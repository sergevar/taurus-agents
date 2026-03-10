/**
 * run-worker.ts — One forked process per active run.
 *
 * Spawned via child_process.fork() by Daemon.
 * Owns the agent loop, a PersistentShell, and DB writes for its run.
 * IPC is used only for coordination signals (status, logs for SSE, completion).
 */

import 'dotenv/config';
import type { ParentMessage, ChildMessage, TriggerType, LogLevel, IpcImage } from './types.js';
import Agent from '../db/models/Agent.js';
import Run from '../db/models/Run.js';
import Message from '../db/models/Message.js';
import AgentLog from '../db/models/AgentLog.js';
import type { ChatMessage, ContentBlock } from '../core/types.js';
import { agentLoop } from '../agents/agent-loop.js';
import { ChatML } from '../core/chatml.js';
import { InferenceService } from '../inference/service.js';
import { resolveProvider } from '../inference/providers/factory.js';
import { ToolRegistry } from '../tools/registry.js';
import { PersistentShell } from './persistent-shell.js';
import { PersistentBashTool } from '../tools/shell/bash.js';
import { PauseTool } from '../tools/control/pause.js';
import { ShellReadTool } from '../tools/shell/read.js';
import { ShellWriteTool } from '../tools/shell/write.js';
import { ShellEditTool } from '../tools/shell/edit.js';
import { ShellGlobTool } from '../tools/shell/glob.js';
import { ShellGrepTool } from '../tools/shell/grep.js';
import { WebFetchTool } from '../tools/web/web-fetch.js';
import { WebSearchTool } from '../tools/web/web-search.js';
import { FileTracker } from '../tools/shell/file-tracker.js';
import { BraveSearchProvider } from '../tools/web/brave-search.js';
import { BrowserTool } from '../tools/web/browser.js';
import { SpawnTool, type SpawnRequest, type SpawnResult } from '../tools/control/spawn.js';

// ── IPC helpers ──

function send(msg: ChildMessage): void {
  process.send?.(msg);
}

function log(level: LogLevel, event: string, message: string, data?: unknown): void {
  send({ type: 'log', level, event, message, data });
}

// ── Pause/Resume machinery ──

let resumeResolve: ((message: string | undefined) => void) | null = null;

function sendPause(reason: string): void {
  send({ type: 'paused', reason });
}

function waitForResume(): Promise<string | undefined> {
  return new Promise((resolve) => {
    resumeResolve = resolve;
  });
}

// ── Spawn machinery ──

const spawnResolvers = new Map<string, (result: SpawnResult) => void>();

function sendSpawnRequest(request: SpawnRequest): void {
  send({ type: 'spawn_request', ...request });
}

function waitForSpawnResult(requestId: string): Promise<SpawnResult> {
  return new Promise((resolve) => {
    spawnResolvers.set(requestId, resolve);
  });
}

// ── Abort controller for graceful stop ──

const abortController = new AbortController();

// ── Message injection queue ──

type InjectedMessage = { text: string; images?: { base64: string; mediaType: string }[] };
const injectQueue: InjectedMessage[] = [];

// ── Tool factories ──
// Each tool registers a factory: (shell) => Tool | null.
// Returning null skips registration (e.g. missing API key).

type ToolFactory = (shell: PersistentShell, tracker: FileTracker) => import('../tools/base.js').Tool | null;

const TOOL_FACTORIES: Record<string, ToolFactory> = {
  Read:      (s, t) => new ShellReadTool(s, t),
  Write:     (s, t) => new ShellWriteTool(s, t),
  Edit:      (s, t) => new ShellEditTool(s, t),
  Glob:      (s) => new ShellGlobTool(s),
  Grep:      (s) => new ShellGrepTool(s),
  Bash:      (s) => new PersistentBashTool(s, (chunk) => {
    send({ type: 'log', level: 'debug', event: 'tool.output', message: chunk });
  }),
  Browser:   (s) => new BrowserTool(s),
  Pause:     ()  => new PauseTool(sendPause, waitForResume),
  Spawn:     ()  => new SpawnTool(sendSpawnRequest, waitForSpawnResult),
  WebFetch:  ()  => new WebFetchTool(),
  WebSearch: ()  => {
    const apiKey = process.env.BRAVE_SEARCH_API_KEY;
    return apiKey ? new WebSearchTool(new BraveSearchProvider(apiKey)) : null;
  },
};

function registerTools(registry: ToolRegistry, toolNames: string[], shell: PersistentShell): void {
  const tracker = new FileTracker();
  for (const name of toolNames) {
    const factory = TOOL_FACTORIES[name];
    if (!factory) continue;
    const tool = factory(shell, tracker);
    if (tool) registry.register(tool);
  }
}

// ── Build input message for the agent ──

function buildInputMessage(trigger: TriggerType, input?: string): string {
  if (input) return input;
  if (trigger === 'schedule') {
    return `You have been triggered by your scheduled run. Current time: ${new Date().toISOString()}. Execute your task.`;
  }
  if (trigger === 'manual') {
    return `You have been manually triggered. Execute your task.`;
  }
  if (trigger.startsWith('signal:')) {
    const signalName = trigger.slice('signal:'.length);
    return `You have been triggered by signal "${signalName}". Execute your task.`;
  }
  return 'Execute your task.';
}

// ── Persist a message to the DB ──

async function persistMessage(run: Run, role: string, content: any, opts?: {
  stopReason?: string; inputTokens?: number; outputTokens?: number;
}): Promise<void> {
  await run.addMessage(role, content, opts);
}

// ── Load run history from DB ──

async function loadRunHistory(runId: string): Promise<ChatMessage[]> {
  const messages = await Message.findAll({
    where: { run_id: runId },
    order: [['created_at', 'ASC']],
  });
  return messages.map(m => m.toChatMLMessage());
}

/**
 * If a run was stopped mid-tool-execution, the last assistant message may have
 * tool_use blocks without corresponding tool_results. Patch those so the
 * conversation is valid for the API.
 */
function patchIncompleteToolCalls(messages: ChatMessage[]): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'assistant' || typeof msg.content === 'string') continue;

    const toolUses = msg.content.filter(b => b.type === 'tool_use');
    if (toolUses.length === 0) continue;

    const neededIds = new Set(toolUses.map((b: any) => b.id as string));

    // Check if the next message has some/all tool_results
    const next = messages[i + 1];
    if (next?.role === 'user' && Array.isArray(next.content)) {
      for (const block of next.content) {
        if (block.type === 'tool_result') neededIds.delete((block as any).tool_use_id);
      }
      // Append missing results to existing user message
      for (const id of neededIds) {
        (next.content as ContentBlock[]).push({
          type: 'tool_result',
          tool_use_id: id,
          content: 'Tool execution was interrupted when the run was stopped.',
          is_error: true,
        });
      }
    } else if (next?.role === 'user' && typeof next.content === 'string') {
      // Next is a plain text user message — convert to content blocks and prepend tool_results
      const errorResult = 'Tool execution was interrupted when the run was stopped.';
      next.content = [
        ...[...neededIds].map(id => ({
          type: 'tool_result' as const,
          tool_use_id: id,
          content: errorResult,
          is_error: true as const,
        })),
        { type: 'text' as const, text: next.content },
      ];
    } else if (neededIds.size > 0) {
      // No following user message — insert one
      messages.splice(i + 1, 0, {
        role: 'user',
        content: [...neededIds].map(id => ({
          type: 'tool_result' as const,
          tool_use_id: id,
          content: 'Tool execution was interrupted when the run was stopped.',
          is_error: true,
        })),
      });
    }
    // Don't break — check ALL messages for incomplete tool calls
  }
}

// ── System prompt template expansion ──

function expandSystemPrompt(prompt: string): string {
  const now = new Date();
  const replacements: Record<string, string> = {
    'datetime': now.toISOString(),
    'date': now.toISOString().split('T')[0],
    'time': now.toTimeString().split(' ')[0],
    'year': String(now.getFullYear()),
    'timezone': Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
  return prompt.replace(/\{\{(\w+)\}\}/gi, (match, key) => {
    return replacements[key.toLowerCase()] ?? match;
  });
}

// ── Main run function ──

async function runAgent(agentId: string, runId: string, trigger: TriggerType, input?: string, resume?: boolean, images?: IpcImage[], toolOverride?: string[]): Promise<void> {
  // 0. Load agent and run from DB
  const agent = await Agent.findByPk(agentId);
  if (!agent) throw new Error(`Agent not found: ${agentId}`);

  const run = await Run.findByPk(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);

  log('info', 'run.started', `Agent "${agent.name}" started (trigger: ${trigger})`);
  send({ type: 'status', status: 'running' });

  // 1. Initialize inference — resolve provider from model string
  const { provider, model: resolvedModel } = resolveProvider(agent.model);
  const inference = new InferenceService(provider);

  // 2. Initialize persistent shell
  const shell = new PersistentShell({
    mode: 'docker',
    container_id: agent.container_id,
    cwd: '/workspace',
  });
  await shell.spawn();

  // 3. Register tools
  // Pause is always available — it's the agent's safety valve to ask for human input.
  // Spawn children never get Pause (nobody can resume them — it would deadlock).
  // Spawn children can request a tool subset (already intersected with parent's tools by daemon).
  // Pause is always available except for spawn children (nobody can resume them — deadlock).
  const ALWAYS_ON_TOOLS = trigger === 'spawn' ? [] : ['Pause'];
  const baseTools = toolOverride ?? agent.tools as string[];
  const tools = new ToolRegistry();
  const toolNames = [...new Set([...baseTools, ...ALWAYS_ON_TOOLS])];
  registerTools(tools, toolNames, shell);

  // 4. Build ChatML
  const chatml = new ChatML();
  chatml.setSystem(expandSystemPrompt(agent.system_prompt));

  // Helper: build user content from text + optional images
  function buildUserContent(text: string, imgs?: IpcImage[]): string | ContentBlock[] {
    if (imgs && imgs.length > 0) {
      return [
        { type: 'text' as const, text },
        ...imgs.map(img => ({
          type: 'image' as const,
          source: { type: 'base64' as const, media_type: img.mediaType, data: img.base64 },
        })),
      ];
    }
    return text;
  }

  if (resume) {
    // Restore conversation from this run's persisted messages
    const history = await loadRunHistory(runId);
    if (history.length > 0) {
      patchIncompleteToolCalls(history);
      for (const msg of history) {
        if (msg.role === 'user') chatml.addUser(msg.content);
        else chatml.addAssistant(msg.content);
      }
    }

    // Add new input if provided, respecting message alternation
    const msgs = chatml.getMessages();
    const last = msgs[msgs.length - 1];

    if (input) {
      const content = buildUserContent(input, images);

      if (last?.role === 'user' && Array.isArray(last.content)) {
        // Last is user with content blocks (e.g. tool_results) — append
        const blocks = typeof content === 'string'
          ? [{ type: 'text' as const, text: content }]
          : content;
        (last.content as ContentBlock[]).push(...blocks);
      } else if (last?.role === 'user' && typeof last.content === 'string') {
        if (typeof content === 'string') {
          last.content += `\n\n${content}`;
        } else {
          // Convert string to blocks so we can add images
          last.content = [{ type: 'text' as const, text: last.content + `\n\n${input}` }, ...content.slice(1)];
        }
      } else {
        chatml.addUser(content);
      }
      await persistMessage(run, 'user', content);
    } else if (!last || last.role === 'assistant') {
      const contMsg = 'Continue from where you left off.';
      chatml.addUser(contMsg);
      await persistMessage(run, 'user', contMsg);
    }

    log('info', 'run.resumed', `Loaded ${history.length} messages, resuming run`);
  } else {
    // Fresh run
    const content = buildUserContent(buildInputMessage(trigger, input), images);
    chatml.addUser(content);
    await persistMessage(run, 'user', content);
  }

  // 6. Run agent loop
  try {
    for await (const event of agentLoop({
      chatml,
      inference,
      tools,
      allowedTools: toolNames,
      cwd: '/workspace',
      maxTurns: agent.max_turns,
      signal: abortController.signal,
      model: resolvedModel,
      getInjectedMessages: () => injectQueue.splice(0),
    })) {
      switch (event.type) {
        case 'stream':
          if (event.event.type === 'thinking_delta') {
            log('debug', 'llm.thinking', event.event.text);
          }
          if (event.event.type === 'text_delta') {
            log('debug', 'llm.text', event.event.text);
          }
          if (event.event.type === 'message_complete') {
            await persistMessage(run, 'assistant', event.event.message.content, {
              stopReason: event.event.stopReason,
              inputTokens: event.event.usage.inputTokens,
              outputTokens: event.event.usage.outputTokens,
            });
            log('info', 'message.saved', 'assistant');
          }
          break;

        case 'tool_start':
          log('debug', 'tool.start', `Executing ${event.name}`, { tool: event.name, input: event.input });
          break;

        case 'tool_end':
          log('info', 'tool.executed', `${event.name} completed (${event.result.durationMs}ms)`, {
            tool: event.name,
            durationMs: event.result.durationMs,
            isError: event.result.isError,
          });
          break;

        case 'tool_denied':
          log('warn', 'tool.denied', `Tool denied: ${event.name}`);
          break;

        case 'user_message':
          await persistMessage(run, 'user', event.message.content);
          log('info', 'message.saved', 'user');
          break;

        case 'retry':
          log('warn', 'inference.retry', `Transient error, retry ${event.attempt}/${event.maxRetries} in ${event.delayMs}ms: ${event.error}`);
          break;

        case 'max_turns_reached':
          log('warn', 'run.max_turns', `Max turns (${agent.max_turns}) reached`);
          break;

        case 'done':
          break;
      }
    }
  } finally {
    injectQueue.length = 0;
    await shell.close();
  }

  // 7. Get final text from ChatML as summary
  const messages = chatml.getMessages();
  const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
  let summary = 'Run completed.';
  if (lastAssistant) {
    if (typeof lastAssistant.content === 'string') {
      summary = lastAssistant.content.slice(0, 4000);
    } else {
      const textBlock = lastAssistant.content.find(b => b.type === 'text');
      if (textBlock && textBlock.type === 'text') {
        summary = textBlock.text.slice(0, 4000);
      }
    }
  }

  // 8. Update run record and log completion
  const usage = inference.getUsage();
  const tokens = { input: usage.inputTokens, output: usage.outputTokens, cost: 0 };

  await run.update({
    run_summary: summary,
    run_error: null,
    total_input_tokens: tokens.input,
    total_output_tokens: tokens.output,
  });

  await AgentLog.create({
    agent_id: agentId,
    run_id: runId,
    level: 'info',
    event: 'run.complete',
    message: summary,
    data: { tokens },
  });

  // 9. Notify parent (for SSE broadcast)
  send({ type: 'run_complete', summary, tokens });
}

// ── IPC message handling ──

process.on('message', async (msg: ParentMessage) => {
  switch (msg.type) {
    case 'start':
      try {
        await runAgent(msg.agentId, msg.runId, msg.trigger, msg.input, msg.resume, msg.images, msg.tools);
      } catch (err: any) {
        send({ type: 'error', error: err.message, stack: err.stack });
      }
      process.exit(0);
      break;

    case 'stop':
      log('info', 'agent.stopping', `Stopping: ${msg.reason}`);
      abortController.abort();
      setTimeout(() => process.exit(0), 5000);
      break;

    case 'resume':
      if (resumeResolve) {
        resumeResolve(msg.message);
        resumeResolve = null;
      }
      break;

    case 'inject':
      injectQueue.push({ text: msg.message, images: msg.images });
      log('info', 'agent.inject', `Message queued for next turn: ${msg.message}`);
      break;

    case 'spawn_result': {
      const resolver = spawnResolvers.get(msg.requestId);
      if (resolver) {
        spawnResolvers.delete(msg.requestId);
        resolver({ summary: msg.summary, error: msg.error });
      }
      break;
    }

    case 'signal':
      log('info', 'agent.signal', `Signal received: ${msg.name}`, msg.payload);
      break;
  }
});

// ── Process lifecycle ──

// Ignore SIGINT — the parent daemon manages our lifecycle via IPC 'stop' messages.
// Without this, Ctrl+C in the terminal kills children directly (same process group),
// racing with the parent's graceful shutdown.
process.on('SIGINT', () => {});

process.on('disconnect', () => {
  abortController.abort();
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  send({ type: 'error', error: err.message, stack: err.stack });
  process.exit(1);
});

// ── Signal readiness ──
send({ type: 'ready' });
