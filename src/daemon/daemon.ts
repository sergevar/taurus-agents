/**
 * Daemon — runs in the parent process.
 *
 * Owns the run→worker map. Spawns/stops workers via fork().
 * Routes IPC messages for coordination and SSE broadcasting.
 * Children handle their own DB reads/writes.
 *
 * Delegates Docker lifecycle to DockerService and SSE to SSEBroadcaster.
 */

import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AgentStatus, TriggerType, ChildMessage, ParentMessage, LogLevel,
} from './types.js';
import { ROOT_FOLDER_ID } from './types.js';
import { DockerService } from './docker.js';
import { SSEBroadcaster } from './sse.js';
import { Scheduler } from './scheduler.js';
import { DEFAULT_MODEL, DEFAULT_DOCKER_IMAGE, DEFAULT_MAX_TURNS, DEFAULT_TIMEOUT_MS } from '../core/defaults.js';
import { Op } from 'sequelize';
import Agent from '../db/models/Agent.js';
import AgentLog from '../db/models/AgentLog.js';
import Folder from '../db/models/Folder.js';
import Run from '../db/models/Run.js';
import Message from '../db/models/Message.js';

// Set up association for eager loading
Run.hasMany(Message, { foreignKey: 'run_id', as: 'messages' });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.join(__dirname, 'run-worker.ts');

interface ManagedRun {
  runId: string;
  process: ChildProcess;
  parentRunId: string | null;
  /** Set on spawn children — used to route spawn_result back to the parent worker */
  spawnRequestId: string | null;
  status: 'running' | 'paused';
}

interface ManagedAgent {
  agent: Agent;
  runs: Map<string, ManagedRun>;
}

interface CompletionWaiter {
  resolve: (result: { summary: string; error?: string; tokens?: { input: number; output: number; cost: number } }) => void;
  timer: NodeJS.Timeout;
}

export class Daemon {
  private agents = new Map<string, ManagedAgent>();
  /** Keyed by runId — allows concurrent /api/ask calls to the same agent */
  private completionWaiters = new Map<string, CompletionWaiter[]>();
  private logger: (level: LogLevel, msg: string) => void;
  readonly docker: DockerService;
  readonly sse: SSEBroadcaster;
  readonly scheduler: Scheduler;

  constructor(logger?: (level: LogLevel, msg: string) => void) {
    this.logger = logger ?? ((level, msg) => {
      const ts = new Date().toISOString().slice(11, 19);
      const prefix = { debug: 'DBG', info: 'INF', warn: 'WRN', error: 'ERR' }[level];
      console.log(`[${ts}] ${prefix} ${msg}`);
    });
    this.docker = new DockerService(this.logger);
    this.sse = new SSEBroadcaster();
    this.scheduler = new Scheduler(this, this.logger);
  }

  // ── Lifecycle ──

  async init(): Promise<void> {
    await Folder.seedRoot();

    const agents = await Agent.findAll();
    for (const agent of agents) {
      if (agent.status === 'running') {
        await agent.update({ status: 'idle' });
      }
      this.agents.set(agent.id, { agent, runs: new Map() });
    }

    // Mark orphaned running runs as stopped — paused runs stay paused (no resources consumed)
    const orphanedRuns = await Run.findAll({ where: { status: 'running' } });
    if (orphanedRuns.length > 0) {
      await Run.update({ status: 'stopped' }, { where: { status: 'running' } });
      this.logger('warn', `Marked ${orphanedRuns.length} orphaned run(s) as stopped`);
    }

    // Register scheduled agents
    for (const agent of agents) {
      if (agent.schedule) {
        this.scheduler.register(agent.id, agent.schedule, agent.schedule_overlap);
      }
    }

    this.logger('info', `Daemon initialized. ${this.agents.size} agent(s) loaded.`);
  }

  async shutdown(): Promise<void> {
    this.logger('info', 'Graceful shutdown starting...');
    this.scheduler.shutdown();

    const stopPromises: Promise<void>[] = [];
    for (const [, managed] of this.agents) {
      for (const [runId] of managed.runs) {
        stopPromises.push(this.stopRun(managed.agent.id, runId, 'daemon shutdown'));
      }
    }
    await Promise.allSettled(stopPromises);

    for (const [, managed] of this.agents) {
      if (managed.agent.status !== 'disabled') {
        await Agent.update({ status: 'idle' }, { where: { id: managed.agent.id } });
      }
    }

    for (const [, managed] of this.agents) {
      await this.docker.stopContainer(managed.agent.container_id);
    }

    this.sse.closeAll();
    this.logger('info', 'Graceful shutdown complete.');
  }

  forceShutdown(): void {
    this.logger('warn', 'Force shutdown — killing all children.');
    for (const [, managed] of this.agents) {
      for (const [, run] of managed.runs) {
        if (!run.process.killed) {
          run.process.kill('SIGKILL');
        }
      }
    }
  }

  // ── Agent CRUD ──

  async createAgent(input: {
    name: string;
    system_prompt: string;
    tools: string[];
    cwd: string;
    folder_id?: string;
    model?: string;
    schedule?: string;
    schedule_overlap?: 'skip' | 'queue' | 'kill';
    max_turns?: number;
    timeout_ms?: number;
    metadata?: Record<string, unknown>;
    docker_image?: string;
    mounts?: { host: string; container: string; readonly?: boolean }[];
  }): Promise<ReturnType<Agent['toApi']>> {
    const agent = await Agent.create({
      name: input.name,
      system_prompt: input.system_prompt,
      tools: input.tools,
      cwd: input.cwd,
      folder_id: input.folder_id ?? ROOT_FOLDER_ID,
      model: input.model ?? DEFAULT_MODEL,
      schedule: input.schedule ?? null,
      schedule_overlap: input.schedule_overlap ?? 'skip',
      max_turns: input.max_turns ?? DEFAULT_MAX_TURNS,
      timeout_ms: input.timeout_ms ?? DEFAULT_TIMEOUT_MS,
      metadata: input.metadata ?? null,
      docker_image: input.docker_image ?? DEFAULT_DOCKER_IMAGE,
      mounts: input.mounts ?? [],
    });

    this.agents.set(agent.id, { agent, runs: new Map() });
    if (agent.schedule) {
      this.scheduler.register(agent.id, agent.schedule, agent.schedule_overlap);
    }
    this.logger('info', `Agent created: "${agent.name}" (${agent.id})`);

    return agent.toApi();
  }

  async updateAgent(id: string, updates: Partial<{
    name: string;
    system_prompt: string;
    tools: string[];
    cwd: string;
    folder_id: string;
    model: string;
    schedule: string | null;
    schedule_overlap: 'skip' | 'queue' | 'kill';
    max_turns: number;
    timeout_ms: number;
    metadata: Record<string, unknown>;
    docker_image: string;
    mounts: { host: string; container: string; readonly?: boolean }[];
    status: AgentStatus;
  }>): Promise<ReturnType<Agent['toApi']>> {
    const managed = this.agents.get(id);
    if (!managed) throw new Error(`Agent not found: ${id}`);

    // If mounts or docker_image changed, destroy the container so it's
    // recreated with the new config on the next run (volume is preserved).
    const needsRecreate = 'mounts' in updates || 'docker_image' in updates;

    await managed.agent.update(updates);

    // Re-register schedule if schedule or overlap changed
    if ('schedule' in updates || 'schedule_overlap' in updates) {
      this.scheduler.register(id, managed.agent.schedule, managed.agent.schedule_overlap);
    }

    if (needsRecreate && managed.runs.size === 0) {
      await this.docker.destroyContainer(managed.agent.container_id);
    }

    return managed.agent.toApi();
  }

  async deleteAgent(id: string): Promise<void> {
    this.scheduler.unregister(id);
    const managed = this.agents.get(id);
    if (managed && managed.runs.size > 0) {
      await this.stopAllRuns(id, 'agent deleted');
    }

    if (managed) {
      await this.docker.removeContainer(managed.agent.container_id);
    }

    await AgentLog.destroy({ where: { agent_id: id } });
    await Agent.destroy({ where: { id } });
    this.agents.delete(id);

    this.logger('info', `Agent deleted: ${id}`);
  }

  async getAgent(id: string): Promise<ReturnType<Agent['toApi']> & { next_run: string | null } | null> {
    const managed = this.agents.get(id);
    if (!managed) return null;
    const nextRun = this.scheduler.getNextRun(id);
    return { ...managed.agent.toApi(), next_run: nextRun?.toISOString() ?? null };
  }

  async listAgents(folder_id?: string): Promise<(ReturnType<Agent['toApi']> & { next_run: string | null })[]> {
    const all = [...this.agents.values()].map(m => m.agent);
    const filtered = folder_id ? all.filter(a => a.folder_id === folder_id) : all;
    return filtered.map(a => ({
      ...a.toApi(),
      next_run: this.scheduler.getNextRun(a.id)?.toISOString() ?? null,
    }));
  }

  isRunning(agentId: string): boolean {
    return this.hasActiveRuns(agentId);
  }

  hasActiveRuns(agentId: string): boolean {
    const managed = this.agents.get(agentId);
    return managed ? managed.runs.size > 0 : false;
  }

  /** Find a live run by runId within an agent's active runs */
  getActiveRun(agentId: string, runId?: string): ManagedRun | undefined {
    const managed = this.agents.get(agentId);
    if (!managed) return undefined;
    if (runId) return managed.runs.get(runId);
    // No runId specified — return the most recently added active run
    let latest: ManagedRun | undefined;
    for (const run of managed.runs.values()) latest = run;
    return latest;
  }

  // ── Run Management ──

  async startRun(agentId: string, trigger: TriggerType = 'manual', input?: string, images?: { base64: string; mediaType: string }[]): Promise<string> {
    const managed = this.agents.get(agentId);
    if (!managed) throw new Error(`Agent not found: ${agentId}`);

    await this.docker.ensureContainer(managed.agent);

    const run = await Run.create({
      cwd: managed.agent.cwd,
      model: managed.agent.model,
      agent_id: agentId,
      trigger,
    });

    await this.forkWorker(agentId, run.id, null, {
      type: 'start', agentId, runId: run.id, trigger, input, images,
    });

    this.logger('info', `Agent "${managed.agent.name}" run started (run: ${run.id})`);
    return run.id;
  }

  async continueRun(agentId: string, runId: string, input?: string, images?: { base64: string; mediaType: string }[]): Promise<void> {
    const managed = this.agents.get(agentId);
    if (!managed) throw new Error(`Agent not found: ${agentId}`);

    // If this run already has a live worker (e.g. paused), use inject/resume instead
    const activeRun = managed.runs.get(runId);
    if (activeRun) {
      if (activeRun.status === 'paused') {
        activeRun.process.send({ type: 'resume', message: input } as ParentMessage);
        activeRun.status = 'running';
        await this.deriveAgentStatus(agentId);
        await this.updateRunStatus(agentId, runId, 'running');
        return;
      }
      throw new Error(`Run ${runId} is already running`);
    }

    const run = await Run.findByPk(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);

    await this.docker.ensureContainer(managed.agent);

    await this.forkWorker(agentId, runId, null, {
      type: 'start', agentId, runId, trigger: 'manual', input, images, resume: true,
    });

    this.logger('info', `Agent "${managed.agent.name}" run continued (run: ${runId})`);
  }

  private async forkWorker(agentId: string, runId: string, parentRunId: string | null, startMsg: ParentMessage): Promise<void> {
    const managed = this.agents.get(agentId)!;

    const child = fork(WORKER_PATH, [], {
      execArgv: ['--import', 'tsx'],
      serialization: 'advanced',
      env: { ...process.env },
    });

    managed.runs.set(runId, {
      runId,
      process: child,
      parentRunId,
      spawnRequestId: null,
      status: 'running',
    });

    child.on('message', (msg: ChildMessage) => {
      this.handleChildMessage(agentId, runId, msg);
    });

    child.on('exit', (code) => {
      this.handleChildExit(agentId, runId, code);
    });

    child.on('error', (err) => {
      this.logger('error', `Agent "${managed.agent.name}" run ${runId} process error: ${err.message}`);
    });

    await new Promise<void>((resolve) => {
      const onMessage = (msg: ChildMessage) => {
        if (msg.type === 'ready') {
          child.off('message', onMessage);
          resolve();
        }
      };
      child.on('message', onMessage);
      setTimeout(resolve, 10_000);
    });

    child.send(startMsg);
    await this.deriveAgentStatus(agentId);
    await this.updateRunStatus(agentId, runId, 'running');
  }

  async stopRun(agentId: string, runId: string, reason: string = 'user requested'): Promise<void> {
    const managed = this.agents.get(agentId);
    if (!managed) return;

    const run = managed.runs.get(runId);
    if (!run) return;

    const stopMsg: ParentMessage = { type: 'stop', reason };
    run.process.send(stopMsg);

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (!run.process.killed) {
          run.process.kill('SIGKILL');
        }
        resolve();
      }, 10_000);

      run.process.on('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });

    await this.updateRunStatus(agentId, runId, 'stopped');
  }

  /** Stop top-level runs only — cascade kill handles their children */
  async stopAllRuns(agentId: string, reason: string = 'user requested'): Promise<void> {
    const managed = this.agents.get(agentId);
    if (!managed) return;
    const topLevel = [...managed.runs.values()].filter(r => !r.parentRunId);
    await Promise.allSettled(topLevel.map(r => this.stopRun(agentId, r.runId, reason)));
  }

  async injectMessage(agentId: string, message: string, images?: { base64: string; mediaType: string }[], runId?: string): Promise<void> {
    const managed = this.agents.get(agentId);
    if (!managed) throw new Error(`Agent not found: ${agentId}`);

    const run = runId ? managed.runs.get(runId) : this.getActiveRun(agentId);
    if (!run) throw new Error('No active run to inject into');

    if (run.status === 'paused') {
      run.process.send({ type: 'resume', message } as ParentMessage);
      run.status = 'running';
      await this.deriveAgentStatus(agentId);
      await this.updateRunStatus(agentId, run.runId, 'running');
      return;
    }

    const msg: ParentMessage = { type: 'inject', message, images };
    run.process.send(msg);
  }

  // ── Smart message dispatch ──

  /**
   * Single entry point for sending a message to an agent.
   * Auto-dispatches based on run state:
   *   run is running → inject into it
   *   run is paused  → resume it with message
   *   run is idle    → continue it with message
   *   no run_id      → start a new run
   */
  async sendMessage(
    agentId: string,
    message: string,
    opts?: { images?: { base64: string; mediaType: string }[]; run_id?: string },
  ): Promise<string> {
    const managed = this.agents.get(agentId);
    if (!managed) throw new Error(`Agent not found: ${agentId}`);

    const images = opts?.images;
    const runId = opts?.run_id;

    if (!runId) {
      return this.startRun(agentId, 'manual', message, images);
    }

    // Check if this run has a live worker
    const activeRun = managed.runs.get(runId);
    if (activeRun) {
      if (activeRun.status === 'running') {
        await this.injectMessage(agentId, message, images, runId);
        return runId;
      }
      if (activeRun.status === 'paused') {
        await this.continueRun(agentId, runId, message, images);
        return runId;
      }
    }

    // Idle run — continue it
    await this.continueRun(agentId, runId, message, images);
    return runId;
  }

  // ── Blocking ask (for /api/ask) ──

  /** Returns any active run's ID for this agent. Prefers running over paused. */
  getCurrentRunId(agentId: string): string | null {
    const managed = this.agents.get(agentId);
    if (!managed) return null;
    let pausedId: string | null = null;
    for (const run of managed.runs.values()) {
      if (run.status === 'running') return run.runId;
      if (run.status === 'paused') pausedId = run.runId;
    }
    return pausedId;
  }

  findAgentByName(name: string): Agent | null {
    for (const managed of this.agents.values()) {
      if (managed.agent.name === name) return managed.agent;
    }
    return null;
  }

  awaitRunCompletion(runId: string, timeoutMs: number = 300_000): Promise<{ summary: string; error?: string; tokens?: { input: number; output: number; cost: number } }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const list = this.completionWaiters.get(runId);
        if (list) {
          const idx = list.findIndex(w => w.resolve === resolve);
          if (idx !== -1) list.splice(idx, 1);
          if (list.length === 0) this.completionWaiters.delete(runId);
        }
        reject(new Error('Timeout waiting for run completion'));
      }, timeoutMs);

      const waiters = this.completionWaiters.get(runId) ?? [];
      waiters.push({ resolve, timer });
      this.completionWaiters.set(runId, waiters);
    });
  }

  private notifyRunCompletion(runId: string, result: { summary: string; error?: string; tokens?: { input: number; output: number; cost: number } }): void {
    const waiters = this.completionWaiters.get(runId);
    if (waiters) {
      for (const { resolve, timer } of waiters) {
        clearTimeout(timer);
        resolve(result);
      }
      this.completionWaiters.delete(runId);
    }
  }

  // ── IPC Handling (coordination + SSE only) ──

  private async handleChildMessage(agentId: string, runId: string, msg: ChildMessage): Promise<void> {
    const managed = this.agents.get(agentId);
    if (!managed) return;

    switch (msg.type) {
      case 'ready':
        break;

      case 'log': {
        if (msg.event === 'llm.thinking') {
          this.sse.broadcast(agentId, {
            type: 'llm_thinking',
            agentId,
            runId,
            text: msg.message,
          });
          break;
        }

        if (msg.event === 'llm.text') {
          this.sse.broadcast(agentId, {
            type: 'llm_text',
            agentId,
            runId,
            text: msg.message,
          });
          break;
        }

        if (msg.level !== 'debug') {
          this.logger(msg.level, `[${managed.agent.name}] ${msg.message}`);

          this.sse.broadcast(agentId, {
            type: 'log',
            agentId,
            runId,
            level: msg.level,
            event: msg.event,
            message: msg.message,
            data: msg.data,
            timestamp: new Date().toISOString(),
          });
        }
        break;
      }

      case 'status': {
        // Update the in-memory run status
        const run = managed.runs.get(runId);
        if (run && (msg.status === 'running' || msg.status === 'paused')) {
          run.status = msg.status;
        }
        await this.deriveAgentStatus(agentId);
        break;
      }

      case 'paused': {
        const run = managed.runs.get(runId);
        if (run) run.status = 'paused';
        await this.deriveAgentStatus(agentId);
        await this.updateRunStatus(agentId, runId, 'paused');
        this.logger('info', `[${managed.agent.name}] Paused: ${msg.reason}`);
        this.sse.broadcast(agentId, {
          type: 'agent_paused',
          agentId,
          reason: msg.reason,
          timestamp: new Date().toISOString(),
        });
        break;
      }

      case 'run_complete': {
        this.logger('info', `[${managed.agent.name}] Run complete. Tokens: ${msg.tokens.input}in/${msg.tokens.output}out`);
        // Notify waiters synchronously before any awaits — prevents race with handleChildExit
        this.notifyRunCompletion(runId, { summary: msg.summary, error: msg.error, tokens: msg.tokens });

        // If this is a spawn child, route result back to the parent worker
        const completedRun = managed.runs.get(runId);
        if (completedRun?.spawnRequestId && completedRun.parentRunId) {
          const parentRun = managed.runs.get(completedRun.parentRunId);
          if (parentRun) {
            parentRun.process.send({
              type: 'spawn_result',
              requestId: completedRun.spawnRequestId,
              summary: msg.summary,
              error: msg.error,
            } as ParentMessage);
          }
          // Clear so handleChildExit doesn't double-send
          completedRun.spawnRequestId = null;
        }

        await this.updateRunStatus(agentId, runId, msg.error ? 'error' : 'completed');
        this.scheduler.onRunComplete(agentId);

        this.sse.broadcast(agentId, {
          type: 'run_complete',
          agentId,
          runId,
          summary: msg.summary,
          error: msg.error,
          tokens: msg.tokens,
          timestamp: new Date().toISOString(),
        });
        break;
      }

      case 'spawn_request':
        this.handleSpawnRequest(agentId, runId, msg).catch((err: any) => {
          this.logger('error', `[${managed.agent.name}] Spawn failed: ${err.message}`);
          // Notify the parent worker that the spawn failed
          const parentRun = managed.runs.get(runId);
          if (parentRun) {
            parentRun.process.send({ type: 'spawn_result', requestId: msg.requestId, summary: '', error: err.message } as ParentMessage);
          }
        });
        break;

      case 'signal_emit':
        // TODO: route to other agents
        this.logger('info', `[${managed.agent.name}] Signal emitted: ${msg.name}`);
        break;

      case 'error': {
        this.logger('error', `[${managed.agent.name}] Error: ${msg.error}`);
        this.notifyRunCompletion(runId, { summary: '', error: msg.error });

        // Route error to parent if this is a spawn child
        const erroredRun = managed.runs.get(runId);
        if (erroredRun?.spawnRequestId && erroredRun.parentRunId) {
          const parentRun = managed.runs.get(erroredRun.parentRunId);
          if (parentRun) {
            parentRun.process.send({
              type: 'spawn_result',
              requestId: erroredRun.spawnRequestId,
              summary: '',
              error: msg.error,
            } as ParentMessage);
          }
          erroredRun.spawnRequestId = null; // prevent double-send from handleChildExit
        }

        await this.updateRunStatus(agentId, runId, 'error');

        this.sse.broadcast(agentId, {
          type: 'agent_error',
          agentId,
          error: msg.error,
          timestamp: new Date().toISOString(),
        });
        break;
      }
    }
  }

  private async handleSpawnRequest(
    agentId: string,
    parentRunId: string,
    msg: { requestId: string; input: string; system_prompt?: string; tools?: string[]; max_turns?: number; timeout_ms?: number },
  ): Promise<void> {
    const managed = this.agents.get(agentId);
    if (!managed) throw new Error(`Agent not found: ${agentId}`);

    // Container is already running (parent is active) — no ensureContainer needed

    // Enforce tool subsetting: child tools must be a subset of the parent agent's tools.
    // Any tools not in the parent's set are silently dropped.
    const parentTools = new Set(managed.agent.tools as string[]);
    const childTools = msg.tools
      ? msg.tools.filter(t => parentTools.has(t))
      : undefined; // undefined = inherit parent's full set

    const childRun = await Run.create({
      cwd: managed.agent.cwd,
      model: managed.agent.model,
      agent_id: agentId,
      trigger: 'manual',
      parent_run_id: parentRunId,
    });

    await this.forkWorker(agentId, childRun.id, parentRunId, {
      type: 'start',
      agentId,
      runId: childRun.id,
      trigger: 'spawn',
      input: msg.input,
      tools: childTools,
    });

    // Tag the child run so we can route the result back
    const childManagedRun = managed.runs.get(childRun.id);
    if (childManagedRun) {
      childManagedRun.spawnRequestId = msg.requestId;
    }

    this.logger('info', `[${managed.agent.name}] Spawned child run ${childRun.id} (parent: ${parentRunId})`);
  }

  private handleChildExit(agentId: string, runId: string, code: number | null): void {
    const managed = this.agents.get(agentId);
    if (!managed) return;

    const exitedRun = managed.runs.get(runId);
    managed.runs.delete(runId);

    // If this was a spawn child, route result back to the parent worker
    if (exitedRun?.spawnRequestId && exitedRun.parentRunId) {
      const parentRun = managed.runs.get(exitedRun.parentRunId);
      if (parentRun) {
        // The actual summary comes from run_complete IPC (handled in handleChildMessage).
        // This is the fallback for abnormal exits.
        parentRun.process.send({
          type: 'spawn_result',
          requestId: exitedRun.spawnRequestId,
          summary: '',
          error: code === 0 ? undefined : `Spawn child exited with code ${code}`,
        } as ParentMessage);
      }
    }

    // Cascade kill: stop any child runs whose parent just died
    for (const [childRunId, childRun] of managed.runs) {
      if (childRun.parentRunId === runId) {
        this.stopRun(agentId, childRunId, 'parent run exited').catch(() => {});
      }
    }

    // Mark run as stopped/error if it wasn't already finalized
    if (code !== 0) {
      this.updateRunStatus(agentId, runId, code === null ? 'stopped' : 'error').catch(() => {});
    }

    // Notify any blocking /api/ask waiters (in case child died without run_complete)
    this.notifyRunCompletion(runId, {
      summary: '',
      error: code === 0 ? undefined : `Process exited with code ${code}`,
    });

    // Derive agent status from remaining runs
    this.deriveAgentStatus(agentId).catch(() => {});

    // Pause container to free resources only when no runs are active
    if (managed.runs.size === 0) {
      this.docker.pauseContainer(managed.agent.container_id).catch(() => {});
    }
  }

  private async updateRunStatus(agentId: string, runId: string, status: 'running' | 'paused' | 'completed' | 'error' | 'stopped'): Promise<void> {
    await Run.update({ status }, { where: { id: runId } });
    this.sse.broadcast(agentId, {
      type: 'run_status',
      agentId,
      runId,
      status,
      timestamp: new Date().toISOString(),
    });
  }

  /** Derive agent status from top-level runs (spawn children are internal to their parent) */
  private async deriveAgentStatus(agentId: string): Promise<void> {
    const managed = this.agents.get(agentId);
    if (!managed) return;

    // Only consider top-level runs — spawn children don't affect agent status
    const topLevelRuns = [...managed.runs.values()].filter(r => !r.parentRunId);

    let newStatus: AgentStatus;
    if (topLevelRuns.length === 0) {
      newStatus = managed.runs.size > 0 ? 'running' : 'idle';
    } else {
      let hasRunning = false;
      for (const run of topLevelRuns) {
        if (run.status === 'running') { hasRunning = true; break; }
      }
      newStatus = hasRunning ? 'running' : 'paused';
    }

    if (managed.agent.status !== newStatus) {
      managed.agent.status = newStatus;
      await Agent.update({ status: newStatus }, { where: { id: agentId } });
      this.sse.broadcast(agentId, {
        type: 'agent_status',
        agentId,
        status: newStatus,
        timestamp: new Date().toISOString(),
      });
    }
  }

  // ── SSE Connect ──

  async addSSEClient(agentId: string, res: import('node:http').ServerResponse): Promise<void> {
    this.sse.addClient(agentId, res);

    const managed = this.agents.get(agentId);
    if (managed) {
      res.write(`data: ${JSON.stringify({ type: 'init', agent: managed.agent.toApi() })}\n\n`);
    }

    const logs = await this.getAgentLogs(agentId, 100);
    res.write(`data: ${JSON.stringify({ type: 'history', logs })}\n\n`);

    const latestRun = await Run.findOne({
      where: { agent_id: agentId },
      order: [['created_at', 'DESC']],
    });
    if (latestRun) {
      const messages = await Message.findAll({
        where: { run_id: latestRun.id },
        order: [['created_at', 'ASC']],
      });
      if (messages.length > 0) {
        res.write(`data: ${JSON.stringify({
          type: 'messages',
          runId: latestRun.id,
          messages: messages.map(m => m.toApi()),
        })}\n\n`);
      }
    }
  }

  // ── Queries (for HTTP API) ──

  async getAgentRuns(agentId: string, limit: number = 20): Promise<any[]> {
    const runs = await Run.findAll({
      where: { agent_id: agentId },
      order: [['created_at', 'DESC']],
      limit,
      include: [{
        model: Message,
        as: 'messages',
        attributes: ['role', 'content'],
        order: [['seq', 'DESC']],
        limit: 1,
        separate: true, // required for limit inside include with hasMany
      }],
    });

    return runs.map(r => r.toApi());
  }

  async getRunMessages(runId: string, afterSeq?: number): Promise<any[]> {
    const where: any = { run_id: runId };
    if (afterSeq != null) {
      where.seq = { [Op.gt]: afterSeq };
    }
    const messages = await Message.findAll({
      where,
      order: [['seq', 'ASC']],
    });
    return messages.map(m => m.toApi());
  }

  async getAgentLogs(agentId: string, limit: number = 100): Promise<any[]> {
    const logs = await AgentLog.findAll({
      where: { agent_id: agentId },
      order: [['created_at', 'DESC']],
      limit,
    });
    return logs.map(l => l.toApi());
  }

  // ── File browsing ──

  /** Ensure the agent's container is running and return its container_id. */
  async ensureContainerForBrowsing(agentId: string): Promise<string> {
    const managed = this.agents.get(agentId);
    if (!managed) throw new Error(`Agent not found: ${agentId}`);
    await this.docker.ensureContainer(managed.agent);
    return managed.agent.container_id;
  }
}
