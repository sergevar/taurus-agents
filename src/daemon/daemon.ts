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

export class Daemon {
  private agents = new Map<string, ManagedAgent>();
  private logger: (level: LogLevel, msg: string) => void;
  readonly docker: DockerService;
  readonly sse: SSEBroadcaster;

  constructor(logger?: (level: LogLevel, msg: string) => void) {
    this.logger = logger ?? ((level, msg) => {
      const ts = new Date().toISOString().slice(11, 19);
      const prefix = { debug: 'DBG', info: 'INF', warn: 'WRN', error: 'ERR' }[level];
      console.log(`[${ts}] ${prefix} ${msg}`);
    });
    this.docker = new DockerService(this.logger);
    this.sse = new SSEBroadcaster();
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

    this.logger('info', `Daemon initialized. ${this.agents.size} agent(s) loaded.`);
  }

  async shutdown(): Promise<void> {
    this.logger('info', 'Graceful shutdown starting...');

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
    type: 'observer' | 'actor';
    system_prompt: string;
    tools: string[];
    cwd: string;
    folder_id?: string;
    model?: string;
    schedule?: string;
    max_turns?: number;
    timeout_ms?: number;
    metadata?: Record<string, unknown>;
    docker_image?: string;
  }): Promise<ReturnType<Agent['toApi']>> {
    const agent = await Agent.create({
      name: input.name,
      type: input.type,
      system_prompt: input.system_prompt,
      tools: input.tools,
      cwd: input.cwd,
      folder_id: input.folder_id ?? ROOT_FOLDER_ID,
      model: input.model ?? 'claude-sonnet-4-20250514',
      schedule: input.schedule ?? null,
      max_turns: input.max_turns ?? 20,
      timeout_ms: input.timeout_ms ?? 300_000,
      metadata: input.metadata ?? null,
      docker_image: input.docker_image ?? 'ubuntu:22.04',
    });

    this.agents.set(agent.id, { agent, process: null, currentRunId: null });
    this.logger('info', `Agent created: "${agent.name}" (${agent.id})`);

    return agent.toApi();
  }

  async updateAgent(id: string, updates: Partial<{
    name: string;
    type: 'observer' | 'actor';
    system_prompt: string;
    tools: string[];
    cwd: string;
    folder_id: string;
    model: string;
    schedule: string | null;
    max_turns: number;
    timeout_ms: number;
    metadata: Record<string, unknown>;
    status: AgentStatus;
  }>): Promise<ReturnType<Agent['toApi']>> {
    const managed = this.agents.get(id);
    if (!managed) throw new Error(`Agent not found: ${id}`);

    await managed.agent.update(updates);
    return managed.agent.toApi();
  }

  async deleteAgent(id: string): Promise<void> {
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

  async getAgent(id: string): Promise<ReturnType<Agent['toApi']> | null> {
    return this.agents.get(id)?.agent.toApi() ?? null;
  }

  async listAgents(folder_id?: string): Promise<ReturnType<Agent['toApi']>[]> {
    const all = [...this.agents.values()].map(m => m.agent);
    const filtered = folder_id ? all.filter(a => a.folder_id === folder_id) : all;
    return filtered.map(a => a.toApi());
  }

  // ── Run Management ──

  async startRun(agentId: string, trigger: TriggerType = 'manual', input?: string): Promise<string> {
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
      type: 'start', agentId, runId: run.id, trigger, input,
    });

    this.logger('info', `Agent "${managed.agent.name}" run started (run: ${run.id})`);
    return run.id;
  }

  async continueRun(agentId: string, runId: string, input?: string): Promise<void> {
    const managed = this.agents.get(agentId);
    if (!managed) throw new Error(`Agent not found: ${agentId}`);
    if (managed.process) throw new Error(`Agent "${managed.agent.name}" is already running`);

    const run = await Run.findByPk(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);

    await this.docker.ensureContainer(managed.agent);

    await this.forkWorker(agentId, runId, {
      type: 'start', agentId, runId, trigger: 'manual', input, resume: true,
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
  }

  async stopRun(agentId: string, reason: string = 'user requested'): Promise<void> {
    const managed = this.agents.get(agentId);
    if (!managed?.process) return;

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
  }

  async resumeAgent(agentId: string, message?: string): Promise<void> {
    const managed = this.agents.get(agentId);
    if (!managed?.process) throw new Error('Agent is not running');
    if (managed.agent.status !== 'paused') throw new Error('Agent is not paused');

    const msg: ParentMessage = { type: 'resume', message };
    managed.process.send(msg);
    await this.updateAgentStatus(agentId, 'running');
  }

  async injectMessage(agentId: string, message: string): Promise<void> {
    const managed = this.agents.get(agentId);
    if (!managed?.process) throw new Error('Agent is not running');

    if (managed.agent.status === 'paused') {
      managed.process.send({ type: 'resume', message } as ParentMessage);
      await this.updateAgentStatus(agentId, 'running');
      return;
    }

    const msg: ParentMessage = { type: 'inject', message };
    managed.process.send(msg);
  }

  // ── IPC Handling (coordination + SSE only) ──

  private async handleChildMessage(agentId: string, runId: string, msg: ChildMessage): Promise<void> {
    const managed = this.agents.get(agentId);
    if (!managed) return;

    switch (msg.type) {
      case 'ready':
        break;

      case 'log': {
        if (msg.event === 'llm.text') {
          this.sse.broadcast(agentId, {
            type: 'llm_text',
            agentId,
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
        await this.updateAgentStatus(agentId, 'error');

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

    managed.process = null;
    managed.currentRunId = null;

    if (managed.agent.status === 'running') {
      const newStatus: AgentStatus = code === 0 ? 'idle' : 'error';
      this.updateAgentStatus(agentId, newStatus).catch(() => {});
    }

    if (code !== 0 && code !== null) {
      this.logger('warn', `[${managed.agent.name}] Process exited with code ${code}`);
    }

    // Pause container to free resources — will unpause on next run
    this.docker.pauseContainer(managed.agent.container_id).catch(() => {});
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

  async getRunMessages(runId: string): Promise<any[]> {
    const messages = await Message.findAll({
      where: { run_id: runId },
      order: [['created_at', 'ASC']],
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
