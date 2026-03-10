/**
 * Daemon lifecycle tests — state machine for runs, resume, inject, stop.
 *
 * Mocks: fork(), Docker, DB models. No real containers or LLM calls.
 * Tests the run Map bookkeeping, IPC routing, and status derivation.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { EventEmitter } from 'node:events';

// ── Fake ChildProcess ──

class FakeChildProcess extends EventEmitter {
  killed = false;
  sent: any[] = [];

  send(msg: any) {
    this.sent.push(msg);
    // Simulate worker exiting after receiving stop (real worker cleans up then exits)
    if (msg.type === 'stop') {
      setTimeout(() => this.emitExit(0), 5);
    }
    return true;
  }

  kill(_signal?: string) {
    this.killed = true;
    this.emit('exit', null);
  }

  // Simulate: emit 'ready', then allow the start message to be processed
  emitReady() {
    this.emit('message', { type: 'ready' });
  }

  // Simulate: worker sends 'paused' IPC
  emitPaused(reason = 'test pause') {
    this.emit('message', { type: 'paused', reason });
  }

  // Simulate: worker sends 'run_complete' IPC
  emitComplete(summary = 'Done', tokens = { input: 10, output: 5, cost: 0 }) {
    this.emit('message', { type: 'run_complete', summary, tokens });
  }

  // Simulate: worker sends 'error' IPC
  emitError(error = 'something broke') {
    this.emit('message', { type: 'error', error });
  }

  // Simulate: process exits
  emitExit(code: number | null = 0) {
    this.emit('exit', code);
  }
}

// ── Module mocks ──

// Track the latest FakeChildProcess so tests can control it
let latestFakeChild: FakeChildProcess;

vi.mock('node:child_process', () => ({
  fork: vi.fn(() => {
    latestFakeChild = new FakeChildProcess();
    // Auto-emit ready after a tick (simulates worker startup)
    setTimeout(() => latestFakeChild.emitReady(), 5);
    return latestFakeChild;
  }),
}));

// Mock DB models — just enough to not crash
const mockAgentData = {
  id: 'agent-1',
  name: 'test-agent',
  status: 'idle',
  system_prompt: 'You are a test agent.',
  tools: ['Bash'],
  cwd: '/workspace',
  model: 'test-model',
  docker_image: 'ubuntu:22.04',
  container_id: 'taurus-agent-test-1',
  schedule: null,
  schedule_overlap: 'skip',
  max_turns: 0,
  timeout_ms: 300000,
  mounts: [],
  folder_id: '00000000-0000-0000-0000-000000000000',
  metadata: null,
  update: vi.fn(async (data: any) => { Object.assign(mockAgentData, data); }),
  toApi: vi.fn(function (this: any) { return { ...this }; }),
};

vi.mock('../src/db/models/Agent.js', () => ({
  default: {
    findAll: vi.fn(async () => [mockAgentData]),
    findByPk: vi.fn(async (id: string) => id === 'agent-1' ? mockAgentData : null),
    create: vi.fn(async (data: any) => ({ ...mockAgentData, ...data, toApi: () => ({ ...mockAgentData, ...data }) })),
    update: vi.fn(async () => {}),
    destroy: vi.fn(async () => {}),
  },
}));

let runCounter = 0;
vi.mock('../src/db/models/Run.js', () => ({
  default: {
    findAll: vi.fn(async () => []),
    findByPk: vi.fn(async (id: string) => ({
      id,
      status: 'stopped',
      update: vi.fn(async () => {}),
    })),
    findOne: vi.fn(async () => null),
    create: vi.fn(async (data: any) => ({
      id: `run-${++runCounter}`,
      ...data,
      status: 'running',
      update: vi.fn(async () => {}),
    })),
    update: vi.fn(async () => {}),
    hasMany: vi.fn(),
  },
}));

vi.mock('../src/db/models/Message.js', () => ({
  default: {
    findAll: vi.fn(async () => []),
    max: vi.fn(async () => 0),
    create: vi.fn(async () => ({})),
  },
}));

vi.mock('../src/db/models/AgentLog.js', () => ({
  default: {
    findAll: vi.fn(async () => []),
    create: vi.fn(async () => ({})),
    destroy: vi.fn(async () => {}),
  },
}));

vi.mock('../src/db/models/Folder.js', () => ({
  default: {
    seedRoot: vi.fn(async () => {}),
  },
}));

// Mock DockerService — ensureContainer simulates a brief startup delay
vi.mock('../src/daemon/docker.js', () => ({
  DockerService: class {
    ensureContainer = vi.fn(async () => { await new Promise(r => setTimeout(r, 10)); });
    pauseContainer = vi.fn(async () => {});
    unpauseContainer = vi.fn(async () => {});
    stopContainer = vi.fn(async () => {});
    destroyContainer = vi.fn(async () => {});
    removeContainer = vi.fn(async () => {});
  },
}));

// Mock SSE
vi.mock('../src/daemon/sse.js', () => ({
  SSEBroadcaster: class {
    broadcast = vi.fn();
    addClient = vi.fn();
    closeAll = vi.fn();
  },
}));

// ── Import Daemon after mocks are set up ──

const { Daemon } = await import('../src/daemon/daemon.js');

// ── Helpers ──

const silentLogger = () => {};

async function createTestDaemon(): Promise<InstanceType<typeof Daemon>> {
  runCounter = 0;
  const daemon = new Daemon(silentLogger);
  await daemon.init();
  return daemon;
}

// ── Tests ──

describe('Daemon run lifecycle', () => {
  let daemon: InstanceType<typeof Daemon>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockAgentData.status = 'idle';
    daemon = await createTestDaemon();
  });

  describe('startRun', () => {
    it('forks a worker and adds run to the map', async () => {
      const runId = await daemon.startRun('agent-1', 'manual', 'hello');

      expect(runId).toBe('run-1');
      expect(daemon.hasActiveRuns('agent-1')).toBe(true);
      expect(daemon.isRunning('agent-1')).toBe(true);

      // Worker received the start message
      expect(latestFakeChild.sent).toHaveLength(1);
      expect(latestFakeChild.sent[0].type).toBe('start');
      expect(latestFakeChild.sent[0].input).toBe('hello');
      expect(latestFakeChild.sent[0].resume).toBeFalsy();
    });
  });

  describe('continueRun — paused worker alive', () => {
    it('sends IPC resume without forking a new worker', async () => {
      // Start a run, then simulate the worker pausing
      const runId = await daemon.startRun('agent-1', 'manual', 'hello');
      const worker = latestFakeChild;
      worker.emitPaused('waiting for input');

      // The run should be paused
      const activeRun = daemon.getActiveRun('agent-1', runId);
      expect(activeRun?.status).toBe('paused');

      // Now continue the paused run
      const sentBefore = worker.sent.length;
      await daemon.continueRun('agent-1', runId, 'continue please');

      // Should have sent resume IPC to the SAME worker (no new fork)
      expect(worker.sent.length).toBe(sentBefore + 1);
      const resumeMsg = worker.sent[worker.sent.length - 1];
      expect(resumeMsg.type).toBe('resume');
      expect(resumeMsg.message).toBe('continue please');

      // Run status should be running again
      expect(activeRun?.status).toBe('running');
    });
  });

  describe('continueRun — worker dead (DB replay)', () => {
    it('forks a new worker with resume=true', async () => {
      // Start and complete a run
      const runId = await daemon.startRun('agent-1', 'manual', 'hello');
      const oldWorker = latestFakeChild;
      oldWorker.emitComplete();
      oldWorker.emitExit(0);

      // Run is gone from map
      expect(daemon.hasActiveRuns('agent-1')).toBe(false);

      // Continue the completed run
      await daemon.continueRun('agent-1', runId, 'pick up where we left off');

      // A NEW worker was forked
      expect(latestFakeChild).not.toBe(oldWorker);
      expect(latestFakeChild.sent[0].type).toBe('start');
      expect(latestFakeChild.sent[0].resume).toBe(true);
      expect(latestFakeChild.sent[0].input).toBe('pick up where we left off');
      expect(daemon.hasActiveRuns('agent-1')).toBe(true);
    });
  });

  describe('continueRun — already running', () => {
    it('throws if the run is already running', async () => {
      const runId = await daemon.startRun('agent-1', 'manual', 'hello');

      await expect(
        daemon.continueRun('agent-1', runId, 'again')
      ).rejects.toThrow(/already running/);
    });
  });

  describe('stopRun', () => {
    it('sends stop IPC and removes run from map on exit', async () => {
      const runId = await daemon.startRun('agent-1', 'manual', 'hello');
      const worker = latestFakeChild;

      await daemon.stopRun('agent-1', runId, 'user stop');

      // Should have sent stop message
      const stopMsg = worker.sent.find((m: any) => m.type === 'stop');
      expect(stopMsg).toBeDefined();
      expect(stopMsg.reason).toBe('user stop');

      // Worker killed, run removed
      expect(daemon.hasActiveRuns('agent-1')).toBe(false);
    });
  });

  describe('stopAllRuns', () => {
    it('stops all active runs for an agent', async () => {
      await daemon.startRun('agent-1', 'manual', 'run 1');
      // Note: with current single-agent model, we can only have one run
      // This test validates the method exists and works
      await daemon.stopAllRuns('agent-1', 'cleanup');
      expect(daemon.hasActiveRuns('agent-1')).toBe(false);
    });
  });

  describe('injectMessage', () => {
    it('sends inject IPC to a running worker', async () => {
      await daemon.startRun('agent-1', 'manual', 'hello');
      const worker = latestFakeChild;
      const sentBefore = worker.sent.length;

      await daemon.injectMessage('agent-1', 'do this too');

      const injectMsg = worker.sent[worker.sent.length - 1];
      expect(injectMsg.type).toBe('inject');
      expect(injectMsg.message).toBe('do this too');
    });

    it('resumes a paused worker when injecting', async () => {
      const runId = await daemon.startRun('agent-1', 'manual', 'hello');
      const worker = latestFakeChild;
      worker.emitPaused('waiting');

      await daemon.injectMessage('agent-1', 'here is your answer');

      const lastMsg = worker.sent[worker.sent.length - 1];
      expect(lastMsg.type).toBe('resume');
      expect(lastMsg.message).toBe('here is your answer');
    });

    it('throws when no active run exists', async () => {
      await expect(
        daemon.injectMessage('agent-1', 'hello')
      ).rejects.toThrow(/No active run/);
    });
  });

  describe('agent status derivation', () => {
    it('is idle when no runs active', async () => {
      expect(mockAgentData.status).toBe('idle');
    });

    it('is running when a run is active', async () => {
      await daemon.startRun('agent-1', 'manual', 'hello');
      expect(mockAgentData.status).toBe('running');
    });

    it('is paused when all runs are paused', async () => {
      await daemon.startRun('agent-1', 'manual', 'hello');
      latestFakeChild.emitPaused('thinking');
      // Give the async handler a tick to process
      await new Promise(r => setTimeout(r, 10));
      expect(mockAgentData.status).toBe('paused');
    });

    it('returns to idle after run completes', async () => {
      await daemon.startRun('agent-1', 'manual', 'hello');
      latestFakeChild.emitComplete();
      latestFakeChild.emitExit(0);
      await new Promise(r => setTimeout(r, 10));
      expect(mockAgentData.status).toBe('idle');
      expect(daemon.hasActiveRuns('agent-1')).toBe(false);
    });
  });

  describe('container pause on last run exit', () => {
    it('pauses the container when the last run exits', async () => {
      await daemon.startRun('agent-1', 'manual', 'hello');
      const dockerService = daemon.docker as any;

      latestFakeChild.emitComplete();
      latestFakeChild.emitExit(0);
      await new Promise(r => setTimeout(r, 10));

      expect(dockerService.pauseContainer).toHaveBeenCalledWith('taurus-agent-test-1');
    });
  });

  describe('getCurrentRunId', () => {
    it('returns running run ID', async () => {
      const runId = await daemon.startRun('agent-1', 'manual', 'hello');
      expect(daemon.getCurrentRunId('agent-1')).toBe(runId);
    });

    it('returns null when no runs active', () => {
      expect(daemon.getCurrentRunId('agent-1')).toBeNull();
    });

    it('returns paused run ID when only paused runs', async () => {
      const runId = await daemon.startRun('agent-1', 'manual', 'hello');
      latestFakeChild.emitPaused('waiting');
      await new Promise(r => setTimeout(r, 10));
      expect(daemon.getCurrentRunId('agent-1')).toBe(runId);
    });
  });

  describe('awaitRunCompletion', () => {
    it('resolves when run completes', async () => {
      const runId = await daemon.startRun('agent-1', 'manual', 'hello');
      const completion = daemon.awaitRunCompletion(runId, 5000);

      latestFakeChild.emitComplete('all done', { input: 100, output: 50, cost: 0 });
      latestFakeChild.emitExit(0);

      const result = await completion;
      expect(result.summary).toBe('all done');
      expect(result.tokens?.input).toBe(100);
    });

    it('resolves with error when worker crashes', async () => {
      const runId = await daemon.startRun('agent-1', 'manual', 'hello');
      const completion = daemon.awaitRunCompletion(runId, 5000);

      latestFakeChild.emitExit(1);

      const result = await completion;
      expect(result.error).toContain('exited with code 1');
    });
  });

  describe('Spawn', () => {
    it('creates a child run when parent sends spawn_request', async () => {
      await daemon.startRun('agent-1', 'manual', 'hello');
      const parentWorker = latestFakeChild;

      // Simulate the parent worker sending a spawn_request via IPC
      parentWorker.emit('message', {
        type: 'spawn_request',
        requestId: 'req-1',
        input: 'do subtask',
      });

      // Give forkWorker time to process (ensureContainer mock has 10ms delay)
      await new Promise(r => setTimeout(r, 50));

      // A new child was forked
      const childWorker = latestFakeChild;
      expect(childWorker).not.toBe(parentWorker);

      // The child received a start message
      expect(childWorker.sent[0].type).toBe('start');
      expect(childWorker.sent[0].input).toBe('do subtask');

      // Agent should now have 2 active runs
      expect(daemon.hasActiveRuns('agent-1')).toBe(true);
    });

    it('routes spawn_result back to parent when child completes', async () => {
      await daemon.startRun('agent-1', 'manual', 'hello');
      const parentWorker = latestFakeChild;

      // Spawn a child
      parentWorker.emit('message', {
        type: 'spawn_request',
        requestId: 'req-1',
        input: 'do subtask',
      });
      await new Promise(r => setTimeout(r, 50));

      const childWorker = latestFakeChild;

      // Child completes
      childWorker.emitComplete('subtask done', { input: 20, output: 10, cost: 0 });
      childWorker.emitExit(0);
      await new Promise(r => setTimeout(r, 20));

      // Parent should have received spawn_result
      const spawnResult = parentWorker.sent.find((m: any) => m.type === 'spawn_result');
      expect(spawnResult).toBeDefined();
      expect(spawnResult.requestId).toBe('req-1');
      expect(spawnResult.summary).toBe('subtask done');
      expect(spawnResult.error).toBeUndefined();
    });

    it('routes spawn error back to parent when child sends error IPC', async () => {
      await daemon.startRun('agent-1', 'manual', 'hello');
      const parentWorker = latestFakeChild;

      parentWorker.emit('message', {
        type: 'spawn_request',
        requestId: 'req-err',
        input: 'do failing subtask',
      });
      await new Promise(r => setTimeout(r, 50));

      const childWorker = latestFakeChild;

      // Child sends error IPC (e.g. runAgent threw) then exits cleanly
      childWorker.emitError('agent threw an exception');
      await new Promise(r => setTimeout(r, 20));

      const spawnResult = parentWorker.sent.find((m: any) => m.type === 'spawn_result');
      expect(spawnResult).toBeDefined();
      expect(spawnResult.requestId).toBe('req-err');
      expect(spawnResult.error).toBe('agent threw an exception');
    });

    it('routes spawn error back to parent when child crashes', async () => {
      await daemon.startRun('agent-1', 'manual', 'hello');
      const parentWorker = latestFakeChild;

      parentWorker.emit('message', {
        type: 'spawn_request',
        requestId: 'req-2',
        input: 'do risky subtask',
      });
      await new Promise(r => setTimeout(r, 50));

      const childWorker = latestFakeChild;

      // Child crashes without sending run_complete
      childWorker.emitExit(1);
      await new Promise(r => setTimeout(r, 20));

      const spawnResult = parentWorker.sent.find((m: any) => m.type === 'spawn_result');
      expect(spawnResult).toBeDefined();
      expect(spawnResult.requestId).toBe('req-2');
      expect(spawnResult.error).toContain('exited with code 1');
    });

    it('passes only subset tools to child (intersection with parent)', async () => {
      // Parent agent has tools: ['Bash']
      await daemon.startRun('agent-1', 'manual', 'hello');
      const parentWorker = latestFakeChild;

      // Spawn requests tools including ones the parent doesn't have
      parentWorker.emit('message', {
        type: 'spawn_request',
        requestId: 'req-tools',
        input: 'do subtask',
        tools: ['Bash', 'Read', 'WebSearch'], // Read and WebSearch not in parent's tools
      });
      await new Promise(r => setTimeout(r, 50));

      const childWorker = latestFakeChild;
      const startMsg = childWorker.sent[0];
      expect(startMsg.type).toBe('start');
      // Only 'Bash' should survive intersection — Read and WebSearch are not in parent's ['Bash']
      expect(startMsg.tools).toEqual(['Bash']);
    });

    it('inherits parent tools when no tools specified in spawn', async () => {
      await daemon.startRun('agent-1', 'manual', 'hello');
      const parentWorker = latestFakeChild;

      parentWorker.emit('message', {
        type: 'spawn_request',
        requestId: 'req-no-tools',
        input: 'do subtask',
        // no tools field
      });
      await new Promise(r => setTimeout(r, 50));

      const childWorker = latestFakeChild;
      const startMsg = childWorker.sent[0];
      expect(startMsg.type).toBe('start');
      // tools should be undefined — worker falls back to agent.tools from DB
      expect(startMsg.tools).toBeUndefined();
    });

    it('cascade kills child runs when parent exits', async () => {
      await daemon.startRun('agent-1', 'manual', 'hello');
      const parentWorker = latestFakeChild;

      parentWorker.emit('message', {
        type: 'spawn_request',
        requestId: 'req-3',
        input: 'long subtask',
      });
      await new Promise(r => setTimeout(r, 50));

      const childWorker = latestFakeChild;
      expect(childWorker.killed).toBe(false);

      // Parent exits — child should be cascade killed
      parentWorker.emitExit(0);
      await new Promise(r => setTimeout(r, 50));

      // Child should have received a stop message and been killed
      const stopMsg = childWorker.sent.find((m: any) => m.type === 'stop');
      expect(stopMsg).toBeDefined();
      expect(stopMsg.reason).toBe('parent run exited');
    });
  });
});
