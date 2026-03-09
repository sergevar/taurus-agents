/**
 * Daemon — runs in the parent process.
 *
 * Owns the child process map. Spawns/stops workers via fork().
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.join(__dirname, 'agent-worker.ts');

interface ManagedAgent {
  agent: Agent;
  process: ChildProcess | null;
  currentRunId: string | null;
}

interface CompletionWaiter {
  resolve: (result: { summary: string; error?: string; tokens?: { input: number; output: number; cost: number } }) => void;
  timer: NodeJS.Timeout;
}

export class Daemon {
  private agents = new Map<string, ManagedAgent>();
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
      if (agent.status === 'running' || agent.status === 'paused') {
        await agent.update({ status: 'idle' });
      }
      this.agents.set(agent.id, { agent, process: null, currentRunId: null });
    }

    // Mark orphaned runs (still 'running' in DB) as stopped — no process survived restart
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
    for (const [id, managed] of this.agents) {
      if (managed.process) {
        stopPromises.push(this.stopRun(id, 'daemon shutdown'));
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
      if (managed.process && !managed.process.killed) {
        managed.process.kill('SIGKILL');
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

    this.agents.set(agent.id, { agent, process: null, currentRunId: null });
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

    if (needsRecreate && !managed.process) {
      await this.docker.destroyContainer(managed.agent.container_id);
    }

    return managed.agent.toApi();
  }

  async deleteAgent(id: string): Promise<void> {
    this.scheduler.unregister(id);
    const managed = this.agents.get(id);
    if (managed?.process) {
      await this.stopRun(id, 'agent deleted');
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
    return this.agents.get(agentId)?.process != null;
  }

  // ── Run Management ──

  async startRun(agentId: string, trigger: TriggerType = 'manual', input?: string, images?: { base64: string; mediaType: string }[]): Promise<string> {
    const managed = this.agents.get(agentId);
    if (!managed) throw new Error(`Agent not found: ${agentId}`);
    if (managed.process) throw new Error(`Agent "${managed.agent.name}" is already running`);

    await this.docker.ensureContainer(managed.agent);

    const run = await Run.create({
      cwd: managed.agent.cwd,
      model: managed.agent.model,
      agent_id: agentId,
      trigger,
    });

    await this.forkWorker(agentId, run.id, {
      type: 'start', agentId, runId: run.id, trigger, input, images,
    });

    this.logger('info', `Agent "${managed.agent.name}" run started (run: ${run.id})`);
    return run.id;
  }

  async continueRun(agentId: string, runId: string, input?: string, images?: { base64: string; mediaType: string }[]): Promise<void> {
    const managed = this.agents.get(agentId);
    if (!managed) throw new Error(`Agent not found: ${agentId}`);
    if (managed.process) throw new Error(`Agent "${managed.agent.name}" is already running`);

    const run = await Run.findByPk(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);

    await this.docker.ensureContainer(managed.agent);

    await this.forkWorker(agentId, runId, {
      type: 'start', agentId, runId, trigger: 'manual', input, images, resume: true,
    });

    this.logger('info', `Agent "${managed.agent.name}" run continued (run: ${runId})`);
  }

  private async forkWorker(agentId: string, runId: string, startMsg: ParentMessage): Promise<void> {
    const managed = this.agents.get(agentId)!;

    const child = fork(WORKER_PATH, [], {
      execArgv: ['--import', 'tsx'],
      serialization: 'advanced',
      env: { ...process.env },
    });

    managed.process = child;
    managed.currentRunId = runId;

    child.on('message', (msg: ChildMessage) => {
      this.handleChildMessage(agentId, runId, msg);
    });

    child.on('exit', (code) => {
      this.handleChildExit(agentId, code);
    });

    child.on('error', (err) => {
      this.logger('error', `Agent "${managed.agent.name}" process error: ${err.message}`);
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
    await this.updateAgentStatus(agentId, 'running');
    await this.updateRunStatus(agentId, runId, 'running');
  }

  async stopRun(agentId: string, reason: string = 'user requested'): Promise<void> {
    const managed = this.agents.get(agentId);
    if (!managed?.process) return;

    const runId = managed.currentRunId;
    const stopMsg: ParentMessage = { type: 'stop', reason };
    managed.process.send(stopMsg);

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (managed.process && !managed.process.killed) {
          managed.process.kill('SIGKILL');
        }
        resolve();
      }, 10_000);

      managed.process!.on('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });

    if (runId) {
      await this.updateRunStatus(agentId, runId, 'stopped');
    }
  }

  async resumeAgent(agentId: string, message?: string): Promise<void> {
    const managed = this.agents.get(agentId);
    if (!managed?.process) throw new Error('Agent is not running');
    if (managed.agent.status !== 'paused') throw new Error('Agent is not paused');

    const msg: ParentMessage = { type: 'resume', message };
    managed.process.send(msg);
    await this.updateAgentStatus(agentId, 'running');
    if (managed.currentRunId) {
      await this.updateRunStatus(agentId, managed.currentRunId, 'running');
    }
  }

  async injectMessage(agentId: string, message: string, images?: { base64: string; mediaType: string }[]): Promise<void> {
    const managed = this.agents.get(agentId);
    if (!managed?.process) throw new Error('Agent is not running');

    if (managed.agent.status === 'paused') {
      managed.process.send({ type: 'resume', message } as ParentMessage);
      await this.updateAgentStatus(agentId, 'running');
      return;
    }

    const msg: ParentMessage = { type: 'inject', message, images };
    managed.process.send(msg);
  }

  // ── Blocking ask (for /api/ask) ──

  getCurrentRunId(agentId: string): string | null {
    return this.agents.get(agentId)?.currentRunId ?? null;
  }

  findAgentByName(name: string): Agent | null {
    for (const managed of this.agents.values()) {
      if (managed.agent.name === name) return managed.agent;
    }
    return null;
  }

  awaitRunCompletion(agentId: string, timeoutMs: number = 300_000): Promise<{ summary: string; error?: string; tokens?: { input: number; output: number; cost: number } }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const list = this.completionWaiters.get(agentId);
        if (list) {
          const idx = list.findIndex(w => w.resolve === resolve);
          if (idx !== -1) list.splice(idx, 1);
          if (list.length === 0) this.completionWaiters.delete(agentId);
        }
        reject(new Error('Timeout waiting for run completion'));
      }, timeoutMs);

      const waiters = this.completionWaiters.get(agentId) ?? [];
      waiters.push({ resolve, timer });
      this.completionWaiters.set(agentId, waiters);
    });
  }

  private notifyRunCompletion(agentId: string, result: { summary: string; error?: string; tokens?: { input: number; output: number; cost: number } }): void {
    const waiters = this.completionWaiters.get(agentId);
    if (waiters) {
      for (const { resolve, timer } of waiters) {
        clearTimeout(timer);
        resolve(result);
      }
      this.completionWaiters.delete(agentId);
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

      case 'status':
        await this.updateAgentStatus(agentId, msg.status);
        break;

      case 'paused':
        await this.updateAgentStatus(agentId, 'paused');
        await this.updateRunStatus(agentId, runId, 'paused');
        this.logger('info', `[${managed.agent.name}] Paused: ${msg.reason}`);
        this.sse.broadcast(agentId, {
          type: 'agent_paused',
          agentId,
          reason: msg.reason,
          timestamp: new Date().toISOString(),
        });
        break;

      case 'run_complete':
        this.logger('info', `[${managed.agent.name}] Run complete. Tokens: ${msg.tokens.input}in/${msg.tokens.output}out`);
        await this.updateRunStatus(agentId, runId, msg.error ? 'error' : 'completed');
        this.scheduler.onRunComplete(agentId);
        this.notifyRunCompletion(agentId, { summary: msg.summary, error: msg.error, tokens: msg.tokens });

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

      case 'signal_emit':
        // TODO: route to other agents
        this.logger('info', `[${managed.agent.name}] Signal emitted: ${msg.name}`);
        break;

      case 'error':
        this.logger('error', `[${managed.agent.name}] Error: ${msg.error}`);
        await this.updateRunStatus(agentId, runId, 'error');
        await this.updateAgentStatus(agentId, 'error');
        this.notifyRunCompletion(agentId, { summary: '', error: msg.error });

        this.sse.broadcast(agentId, {
          type: 'agent_error',
          agentId,
          error: msg.error,
          timestamp: new Date().toISOString(),
        });
        break;
    }
  }

  private handleChildExit(agentId: string, code: number | null): void {
    const managed = this.agents.get(agentId);
    if (!managed) return;

    const runId = managed.currentRunId;
    managed.process = null;
    managed.currentRunId = null;

    if (managed.agent.status === 'running') {
      const newStatus: AgentStatus = code === 0 ? 'idle' : 'error';
      this.updateAgentStatus(agentId, newStatus).catch(() => {});
    }

    // Mark run as stopped/error if it wasn't already finalized
    if (runId && code !== 0) {
      this.updateRunStatus(agentId, runId, code === null ? 'stopped' : 'error').catch(() => {});
    }

    // Notify any blocking /api/ask waiters (in case child died without run_complete)
    this.notifyRunCompletion(agentId, {
      summary: '',
      error: code === 0 ? undefined : `Process exited with code ${code}`,
    });

    // Pause container to free resources — will unpause on next run
    this.docker.pauseContainer(managed.agent.container_id).catch(() => {});
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

  private async updateAgentStatus(agentId: string, status: AgentStatus): Promise<void> {
    const managed = this.agents.get(agentId);
    if (!managed) return;

    managed.agent.status = status;
    await Agent.update({ status }, { where: { id: agentId } });

    this.sse.broadcast(agentId, {
      type: 'agent_status',
      agentId,
      status,
      timestamp: new Date().toISOString(),
    });
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
}
