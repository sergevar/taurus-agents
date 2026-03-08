/**
 * ThreadManager — runs in the parent/daemon process.
 *
 * Owns the child process map. Spawns/stops workers via fork().
 * Routes IPC messages. Persists all data to DB. Broadcasts SSE.
 */

import { fork, execSync, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { v4 as uuidv4 } from 'uuid';
import type { ServerResponse } from 'node:http';
import type {
  ThreadConfig, ThreadStatus, TriggerType, ChildMessage, ParentMessage, LogLevel,
} from './types.js';
import { ROOT_FOLDER_ID } from './types.js';
import Thread from '../db/models/Thread.js';
import ThreadLog from '../db/models/ThreadLog.js';
import Folder from '../db/models/Folder.js';
import Session from '../db/models/Session.js';
import Message from '../db/models/Message.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKER_PATH = path.join(__dirname, 'thread-worker.ts');

interface ManagedThread {
  config: ThreadConfig;
  process: ChildProcess | null;
  currentSessionId: string | null;
}

export class ThreadManager {
  private threads = new Map<string, ManagedThread>();
  /** Per-thread SSE clients. Key '*' = global subscribers. */
  private sseClients = new Map<string, Set<ServerResponse>>();
  private logger: (level: LogLevel, msg: string) => void;

  constructor(logger?: (level: LogLevel, msg: string) => void) {
    this.logger = logger ?? ((level, msg) => {
      const ts = new Date().toISOString().slice(11, 19);
      const prefix = { debug: 'DBG', info: 'INF', warn: 'WRN', error: 'ERR' }[level];
      console.log(`[${ts}] ${prefix} ${msg}`);
    });
  }

  // ── Lifecycle ──

  async init(): Promise<void> {
    // Seed root folder
    await Folder.seedRoot();

    // Load all threads from DB
    const threads = await Thread.findAll();
    for (const thread of threads) {
      const config = thread.toConfig();
      // Reset any that were "running" when daemon died
      if (config.status === 'running' || config.status === 'paused') {
        await thread.update({ status: 'idle' });
        config.status = 'idle';
      }
      this.threads.set(config.id, { config, process: null, currentSessionId: null });
    }

    this.logger('info', `ThreadManager initialized. ${this.threads.size} thread(s) loaded.`);

    // TODO: set up cron jobs for scheduled threads
  }

  async shutdown(): Promise<void> {
    this.logger('info', 'Graceful shutdown starting...');

    const stopPromises: Promise<void>[] = [];
    for (const [id, managed] of this.threads) {
      if (managed.process) {
        stopPromises.push(this.stopRun(id, 'daemon shutdown'));
      }
    }

    await Promise.allSettled(stopPromises);

    // Update all threads to idle
    for (const [, managed] of this.threads) {
      if (managed.config.status !== 'disabled') {
        await Thread.update({ status: 'idle' }, { where: { id: managed.config.id } });
      }
    }

    // Stop all Docker containers
    for (const [, managed] of this.threads) {
      await this.stopContainer(managed.config.containerId);
    }

    // Close all SSE clients
    for (const clients of this.sseClients.values()) {
      for (const res of clients) {
        res.end();
      }
    }
    this.sseClients.clear();

    this.logger('info', 'Graceful shutdown complete.');
  }

  forceShutdown(): void {
    this.logger('warn', 'Force shutdown — killing all children.');
    for (const [, managed] of this.threads) {
      if (managed.process && !managed.process.killed) {
        managed.process.kill('SIGKILL');
      }
    }
  }

  // ── Thread CRUD ──

  async createThread(input: {
    name: string;
    type: 'observer' | 'actor';
    systemPrompt: string;
    tools: string[];
    cwd: string;
    folderId?: string;
    model?: string;
    schedule?: string;
    maxTurns?: number;
    timeoutMs?: number;
    metadata?: Record<string, unknown>;
    dockerImage?: string;
  }): Promise<ThreadConfig> {
    const thread = await Thread.create({
      name: input.name,
      type: input.type,
      system_prompt: input.systemPrompt,
      tools: JSON.stringify(input.tools),
      cwd: input.cwd,
      folder_id: input.folderId ?? ROOT_FOLDER_ID,
      model: input.model ?? 'claude-sonnet-4-20250514',
      schedule: input.schedule ?? null,
      max_turns: input.maxTurns ?? 20,
      timeout_ms: input.timeoutMs ?? 300_000,
      metadata: input.metadata ? JSON.stringify(input.metadata) : null,
      docker_image: input.dockerImage ?? 'ubuntu:22.04',
    });

    const config = thread.toConfig();
    this.threads.set(config.id, { config, process: null, currentSessionId: null });
    this.logger('info', `Thread created: "${config.name}" (${config.id})`);

    return config;
  }

  async updateThread(id: string, updates: Partial<{
    name: string;
    type: 'observer' | 'actor';
    systemPrompt: string;
    tools: string[];
    cwd: string;
    folderId: string;
    model: string;
    schedule: string | null;
    maxTurns: number;
    timeoutMs: number;
    metadata: Record<string, unknown>;
    status: ThreadStatus;
  }>): Promise<ThreadConfig> {
    const thread = await Thread.findByPk(id);
    if (!thread) throw new Error(`Thread not found: ${id}`);

    const dbUpdates: any = {};
    if (updates.name !== undefined) dbUpdates.name = updates.name;
    if (updates.type !== undefined) dbUpdates.type = updates.type;
    if (updates.systemPrompt !== undefined) dbUpdates.system_prompt = updates.systemPrompt;
    if (updates.tools !== undefined) dbUpdates.tools = JSON.stringify(updates.tools);
    if (updates.cwd !== undefined) dbUpdates.cwd = updates.cwd;
    if (updates.folderId !== undefined) dbUpdates.folder_id = updates.folderId;
    if (updates.model !== undefined) dbUpdates.model = updates.model;
    if (updates.schedule !== undefined) dbUpdates.schedule = updates.schedule;
    if (updates.maxTurns !== undefined) dbUpdates.max_turns = updates.maxTurns;
    if (updates.timeoutMs !== undefined) dbUpdates.timeout_ms = updates.timeoutMs;
    if (updates.metadata !== undefined) dbUpdates.metadata = JSON.stringify(updates.metadata);
    if (updates.status !== undefined) dbUpdates.status = updates.status;

    await thread.update(dbUpdates);
    const config = thread.toConfig();

    const managed = this.threads.get(id);
    if (managed) managed.config = config;

    return config;
  }

  async deleteThread(id: string): Promise<void> {
    const managed = this.threads.get(id);
    if (managed?.process) {
      await this.stopRun(id, 'thread deleted');
    }

    // Remove Docker container and volume
    if (managed) {
      await this.removeContainer(managed.config);
    }

    await ThreadLog.destroy({ where: { thread_id: id } });
    await Thread.destroy({ where: { id } });
    this.threads.delete(id);

    this.logger('info', `Thread deleted: ${id}`);
  }

  async getThread(id: string): Promise<ThreadConfig | null> {
    return this.threads.get(id)?.config ?? null;
  }

  async listThreads(folderId?: string): Promise<ThreadConfig[]> {
    const all = [...this.threads.values()].map(m => m.config);
    if (folderId) return all.filter(c => c.folderId === folderId);
    return all;
  }

  // ── Folder CRUD ──

  async createFolder(name: string, parentId?: string): Promise<{ id: string; name: string; parentId: string | null }> {
    const folder = await Folder.create({
      id: uuidv4(),
      name,
      parent_id: parentId ?? ROOT_FOLDER_ID,
    });
    return folder.toApi();
  }

  async listFolders(): Promise<any[]> {
    const folders = await Folder.getTree();
    return folders.map(f => f.toApi());
  }

  async deleteFolder(id: string): Promise<void> {
    if (id === ROOT_FOLDER_ID) throw new Error('Cannot delete root folder');
    const folder = await Folder.findByPk(id);
    if (!folder) throw new Error(`Folder not found: ${id}`);

    // Move children threads to parent folder
    const parentId = folder.parent_id ?? ROOT_FOLDER_ID;
    await Thread.update({ folder_id: parentId }, { where: { folder_id: id } });
    await Folder.update({ parent_id: parentId }, { where: { parent_id: id } });
    await folder.destroy();
  }

  // ── Docker Container Lifecycle ──

  private dockerExec(args: string): string {
    return execSync(`docker ${args}`, { encoding: 'utf-8', timeout: 30_000 }).trim();
  }

  private isContainerRunning(containerId: string): boolean {
    try {
      const state = this.dockerExec(`inspect --format '{{.State.Running}}' ${containerId}`);
      return state === 'true';
    } catch {
      return false;
    }
  }

  private containerExists(containerId: string): boolean {
    try {
      this.dockerExec(`inspect ${containerId}`);
      return true;
    } catch {
      return false;
    }
  }

  async ensureContainer(config: ThreadConfig): Promise<void> {
    const { containerId, dockerImage } = config;

    if (this.isContainerRunning(containerId)) return;

    if (this.containerExists(containerId)) {
      // Container exists but stopped — start it
      this.dockerExec(`start ${containerId}`);
      this.logger('info', `Container started: ${containerId}`);
      return;
    }

    // Create and start container — fully isolated, no host mounts
    const volumeName = `taurus-vol-${config.id}`;
    try {
      this.dockerExec(`volume create ${volumeName}`);
    } catch {
      // Volume may already exist
    }

    // Create container: long-running sleep process, workspace on persistent volume
    this.dockerExec(
      `create --name ${containerId} ` +
      `-v ${volumeName}:/workspace ` +
      `-w /workspace ` +
      `${dockerImage} sleep infinity`
    );

    this.dockerExec(`start ${containerId}`);

    // Copy scaffold into /workspace so the thread has files to work with
    const scaffoldDir = path.join(__dirname, '..', '..', 'scaffold');
    try {
      this.dockerExec(`cp ${scaffoldDir}/. ${containerId}:/workspace/`);
      this.logger('info', `Scaffold copied into ${containerId}:/workspace/`);
    } catch {
      this.logger('warn', `No scaffold directory found or copy failed — container starts empty`);
    }

    this.logger('info', `Container created and started: ${containerId} (image: ${dockerImage})`);
  }

  async stopContainer(containerId: string): Promise<void> {
    if (this.isContainerRunning(containerId)) {
      try {
        this.dockerExec(`stop -t 5 ${containerId}`);
        this.logger('info', `Container stopped: ${containerId}`);
      } catch (err: any) {
        this.logger('warn', `Failed to stop container ${containerId}: ${err.message}`);
      }
    }
  }

  async removeContainer(config: ThreadConfig): Promise<void> {
    const { containerId } = config;
    try {
      this.dockerExec(`rm -f ${containerId}`);
    } catch { /* ignore */ }
    try {
      this.dockerExec(`volume rm taurus-vol-${config.id}`);
    } catch { /* ignore */ }
    this.logger('info', `Container removed: ${containerId}`);
  }

  // ── Run Management ──

  async startRun(threadId: string, trigger: TriggerType = 'manual', input?: string, continueSession?: boolean): Promise<string> {
    const managed = this.threads.get(threadId);
    if (!managed) throw new Error(`Thread not found: ${threadId}`);
    if (managed.process) throw new Error(`Thread "${managed.config.name}" is already running`);

    // Ensure Docker container is running
    await this.ensureContainer(managed.config);

    // Load history from previous session if continuing
    let history: Array<{ role: string; content: any }> | undefined;
    let sessionId: string;

    if (continueSession) {
      const prevSession = await Session.findOne({
        where: { thread_id: threadId },
        order: [['created_at', 'DESC']],
      });
      if (prevSession) {
        const messages = await Message.findAll({
          where: { session_id: prevSession.id },
          order: [['created_at', 'ASC']],
        });
        if (messages.length > 0) {
          history = messages.map(m => {
            let content: any = m.content;
            try { content = JSON.parse(m.content); } catch {}
            return { role: m.role, content };
          });
        }
      }
    }

    // Create session for this run
    const session = await Session.create({
      cwd: managed.config.cwd,
      model: managed.config.model,
      thread_id: threadId,
      trigger,
    });
    sessionId = session.id;

    // Fork the worker
    const child = fork(WORKER_PATH, [], {
      execArgv: ['--import', 'tsx'],
      serialization: 'advanced',
      env: { ...process.env },
    });

    managed.process = child;
    managed.currentSessionId = sessionId;

    // Set up IPC handler
    child.on('message', (msg: ChildMessage) => {
      this.handleChildMessage(threadId, sessionId, msg);
    });

    child.on('exit', (code) => {
      this.handleChildExit(threadId, code);
    });

    child.on('error', (err) => {
      this.logger('error', `Thread "${managed.config.name}" process error: ${err.message}`);
    });

    // Wait for 'ready' then send 'start'
    // The child sends 'ready' immediately on load
    const startMsg: ParentMessage = {
      type: 'start',
      config: managed.config,
      sessionId,
      trigger,
      input,
      history,
    };

    // Small delay to ensure the child is ready
    await new Promise<void>((resolve) => {
      const onMessage = (msg: ChildMessage) => {
        if (msg.type === 'ready') {
          child.off('message', onMessage);
          resolve();
        }
      };
      child.on('message', onMessage);
      // Timeout after 10s
      setTimeout(resolve, 10_000);
    });

    child.send(startMsg);

    // Update status
    await this.updateThreadStatus(threadId, 'running');
    this.logger('info', `Thread "${managed.config.name}" run started (session: ${sessionId})`);

    return sessionId;
  }

  async stopRun(threadId: string, reason: string = 'user requested'): Promise<void> {
    const managed = this.threads.get(threadId);
    if (!managed?.process) return;

    const stopMsg: ParentMessage = { type: 'stop', reason };
    managed.process.send(stopMsg);

    // Wait for graceful exit
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

  async resumeThread(threadId: string, message?: string): Promise<void> {
    const managed = this.threads.get(threadId);
    if (!managed?.process) throw new Error('Thread is not running');
    if (managed.config.status !== 'paused') throw new Error('Thread is not paused');

    const msg: ParentMessage = { type: 'resume', message };
    managed.process.send(msg);
    await this.updateThreadStatus(threadId, 'running');
  }

  async injectMessage(threadId: string, message: string): Promise<void> {
    const managed = this.threads.get(threadId);
    if (!managed?.process) throw new Error('Thread is not running');

    // If paused, resume with the message instead
    if (managed.config.status === 'paused') {
      managed.process.send({ type: 'resume', message } as ParentMessage);
      await this.updateThreadStatus(threadId, 'running');
      return;
    }

    const msg: ParentMessage = { type: 'inject', message };
    managed.process.send(msg);
  }

  // ── IPC Handling ──

  private async handleChildMessage(threadId: string, sessionId: string, msg: ChildMessage): Promise<void> {
    const managed = this.threads.get(threadId);
    if (!managed) return;

    switch (msg.type) {
      case 'ready':
        // Already handled in startRun
        break;

      case 'log': {
        // Streaming text tokens: forward to SSE for live display, but don't persist
        if (msg.event === 'llm.text') {
          this.broadcastSSE(threadId, {
            type: 'llm_text',
            threadId,
            text: msg.message,
          });
          break;
        }

        // Persist to DB (skip debug level to reduce volume)
        if (msg.level !== 'debug') {
          await ThreadLog.create({
            thread_id: threadId,
            session_id: sessionId,
            level: msg.level,
            event: msg.event,
            message: msg.message,
            data: msg.data ? JSON.stringify(msg.data) : null,
          });
        }

        // Log to terminal (skip debug level for cleanliness)
        if (msg.level !== 'debug') {
          this.logger(msg.level, `[${managed.config.name}] ${msg.message}`);
        }

        // Broadcast to SSE clients (skip debug)
        if (msg.level === 'debug') break;
        this.broadcastSSE(threadId, {
          type: 'log',
          threadId,
          sessionId,
          level: msg.level,
          event: msg.event,
          message: msg.message,
          data: msg.data,
          timestamp: new Date().toISOString(),
        });
        break;
      }

      case 'status':
        await this.updateThreadStatus(threadId, msg.status);
        break;

      case 'paused':
        await this.updateThreadStatus(threadId, 'paused');
        this.logger('info', `[${managed.config.name}] Paused: ${msg.reason}`);
        this.broadcastSSE(threadId, {
          type: 'thread_paused',
          threadId,
          reason: msg.reason,
          timestamp: new Date().toISOString(),
        });
        break;

      case 'message_persist': {
        const session = await Session.findByPk(msg.sessionId);
        if (session) {
          await session.addMessage(msg.role, msg.content, {
            stopReason: msg.stopReason,
            inputTokens: msg.inputTokens,
            outputTokens: msg.outputTokens,
          });
        }
        break;
      }

      case 'tool_persist':
        // TODO: persist tool call records
        break;

      case 'signal_emit':
        // TODO: route to other threads
        this.logger('info', `[${managed.config.name}] Signal emitted: ${msg.name}`);
        break;

      case 'run_complete': {
        const session = await Session.findByPk(msg.sessionId);
        if (session) {
          await session.update({
            run_summary: msg.summary,
            run_error: msg.error ?? null,
            total_input_tokens: session.totalInputTokens + msg.tokens.input,
            total_output_tokens: session.totalOutputTokens + msg.tokens.output,
          });
        }

        this.logger('info', `[${managed.config.name}] Run complete. Tokens: ${msg.tokens.input}in/${msg.tokens.output}out`);

        // Persist run summary as a ThreadLog so it shows up on reload
        await ThreadLog.create({
          thread_id: threadId,
          session_id: msg.sessionId,
          level: msg.error ? 'error' : 'info',
          event: 'run.complete',
          message: msg.summary || 'Run completed.',
          data: JSON.stringify({ tokens: msg.tokens, error: msg.error }),
        });

        this.broadcastSSE(threadId, {
          type: 'run_complete',
          threadId,
          sessionId: msg.sessionId,
          summary: msg.summary,
          error: msg.error,
          tokens: msg.tokens,
          timestamp: new Date().toISOString(),
        });
        break;
      }

      case 'error':
        this.logger('error', `[${managed.config.name}] Error: ${msg.error}`);
        await this.updateThreadStatus(threadId, 'error');

        if (managed.currentSessionId) {
          const session = await Session.findByPk(managed.currentSessionId);
          if (session) {
            await session.update({ run_error: msg.error });
          }
        }

        this.broadcastSSE(threadId, {
          type: 'thread_error',
          threadId,
          error: msg.error,
          timestamp: new Date().toISOString(),
        });
        break;
    }
  }

  private handleChildExit(threadId: string, code: number | null): void {
    const managed = this.threads.get(threadId);
    if (!managed) return;

    managed.process = null;
    managed.currentSessionId = null;

    if (managed.config.status === 'running') {
      // Unexpected exit
      managed.config.status = code === 0 ? 'idle' : 'error';
      Thread.update(
        { status: managed.config.status },
        { where: { id: threadId } },
      ).catch(() => {}); // fire and forget
    }

    if (code !== 0 && code !== null) {
      this.logger('warn', `[${managed.config.name}] Process exited with code ${code}`);
    }
  }

  private async updateThreadStatus(threadId: string, status: ThreadStatus): Promise<void> {
    const managed = this.threads.get(threadId);
    if (!managed) return;

    managed.config.status = status;
    await Thread.update({ status }, { where: { id: threadId } });

    this.broadcastSSE(threadId, {
      type: 'thread_status',
      threadId,
      status,
      timestamp: new Date().toISOString(),
    });
  }

  // ── SSE ──

  /**
   * Subscribe to SSE events for a specific thread.
   * Also sends recent log history on connect.
   */
  async addSSEClient(threadId: string, res: ServerResponse): Promise<void> {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    if (!this.sseClients.has(threadId)) {
      this.sseClients.set(threadId, new Set());
    }
    this.sseClients.get(threadId)!.add(res);

    res.on('close', () => {
      const clients = this.sseClients.get(threadId);
      if (clients) {
        clients.delete(res);
        if (clients.size === 0) this.sseClients.delete(threadId);
      }
    });

    // Send thread state
    const config = this.threads.get(threadId)?.config;
    if (config) {
      res.write(`data: ${JSON.stringify({ type: 'init', thread: config })}\n\n`);
    }

    // Send recent log history
    const logs = await this.getThreadLogs(threadId, 100);
    res.write(`data: ${JSON.stringify({ type: 'history', logs })}\n\n`);

    // Send messages from the most recent session so conversation survives reload
    const latestSession = await Session.findOne({
      where: { thread_id: threadId },
      order: [['created_at', 'DESC']],
    });
    if (latestSession) {
      const messages = await Message.findAll({
        where: { session_id: latestSession.id },
        order: [['created_at', 'ASC']],
      });
      if (messages.length > 0) {
        res.write(`data: ${JSON.stringify({
          type: 'messages',
          sessionId: latestSession.id,
          messages: messages.map(m => m.toApi()),
        })}\n\n`);
      }
    }
  }

  private broadcastSSE(threadId: string, data: any): void {
    const payload = `data: ${JSON.stringify(data)}\n\n`;
    // Send to thread-specific subscribers
    const clients = this.sseClients.get(threadId);
    if (clients) {
      for (const client of clients) {
        client.write(payload);
      }
    }
  }

  // ── Queries (for HTTP API) ──

  async getThreadRuns(threadId: string, limit: number = 20): Promise<any[]> {
    const sessions = await Session.findAll({
      where: { thread_id: threadId },
      order: [['created_at', 'DESC']],
      limit,
    });
    return sessions.map(s => s.toApi());
  }

  async getThreadLogs(threadId: string, limit: number = 100): Promise<any[]> {
    const logs = await ThreadLog.findAll({
      where: { thread_id: threadId },
      order: [['created_at', 'DESC']],
      limit,
    });
    return logs.map(l => l.toApi());
  }
}
