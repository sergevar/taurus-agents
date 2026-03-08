/**
 * agent-worker.ts — Universal child process entry point.
 *
 * Spawned via child_process.fork() by Daemon.
 * Reads its own Agent row from DB, handles message persistence directly.
 * IPC is used only for coordination signals (status, logs for SSE, completion).
 */

import 'dotenv/config';
import type { ParentMessage, ChildMessage, TriggerType, LogLevel } from './types.js';
import Agent from '../db/models/Agent.js';
import Run from '../db/models/Run.js';
import Message from '../db/models/Message.js';
import AgentLog from '../db/models/AgentLog.js';
import { agentLoop } from '../agents/agent-loop.js';
import { ChatML } from '../core/chatml.js';
import { InferenceService } from '../inference/service.js';
import { AnthropicProvider } from '../inference/providers/anthropic.js';
import { ToolRegistry } from '../tools/registry.js';
import { PersistentShell } from './persistent-shell.js';
import { PersistentBashTool } from '../tools/shell/bash.js';
import { PauseTool } from '../tools/control/pause.js';
import { ShellReadTool } from '../tools/shell/read.js';
import { ShellWriteTool } from '../tools/shell/write.js';
import { ShellEditTool } from '../tools/shell/edit.js';
import { ShellGlobTool } from '../tools/shell/glob.js';
import { ShellGrepTool } from '../tools/shell/grep.js';

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

// ── Abort controller for graceful stop ──

const abortController = new AbortController();

// ── Message injection queue ──

const injectQueue: string[] = [];

// ── Tool registration ──

function registerTools(registry: ToolRegistry, toolNames: string[], shell: PersistentShell): void {
  const SHELL_TOOLS: Record<string, () => import('../tools/base.js').Tool> = {
    Read: () => new ShellReadTool(shell),
    Write: () => new ShellWriteTool(shell),
    Edit: () => new ShellEditTool(shell),
    Glob: () => new ShellGlobTool(shell),
    Grep: () => new ShellGrepTool(shell),
  };

  for (const name of toolNames) {
    if (name === 'Bash') {
      registry.register(new PersistentBashTool(shell));
    } else if (name === 'Pause') {
      registry.register(new PauseTool(sendPause, waitForResume));
    } else if (SHELL_TOOLS[name]) {
      registry.register(SHELL_TOOLS[name]());
    }
  }

  if (!toolNames.includes('Pause')) {
    registry.register(new PauseTool(sendPause, waitForResume));
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

// ── Load history from previous run ──

async function loadHistory(agentId: string): Promise<Array<{ role: string; content: any }> | undefined> {
  const prevRun = await Run.findOne({
    where: { agent_id: agentId },
    order: [['created_at', 'DESC']],
  });
  if (!prevRun) return undefined;

  const messages = await Message.findAll({
    where: { run_id: prevRun.id },
    order: [['created_at', 'ASC']],
  });
  if (messages.length === 0) return undefined;

  return messages.map(m => ({ role: m.role, content: m.content }));
}

// ── Main run function ──

async function runAgent(agentId: string, runId: string, trigger: TriggerType, input?: string, continueRun?: boolean): Promise<void> {
  // 0. Load agent and run from DB
  const agent = await Agent.findByPk(agentId);
  if (!agent) throw new Error(`Agent not found: ${agentId}`);

  const run = await Run.findByPk(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);

  log('info', 'run.started', `Agent "${agent.name}" started (trigger: ${trigger})`);
  send({ type: 'status', status: 'running' });

  // 1. Initialize inference
  const provider = new AnthropicProvider();
  const inference = new InferenceService(provider);

  // 2. Initialize persistent shell
  const shell = new PersistentShell({
    mode: 'docker',
    container_id: agent.container_id,
    cwd: '/workspace',
  });
  await shell.spawn();

  // 3. Register tools
  const tools = new ToolRegistry();
  const toolNames = [...new Set([...agent.tools, 'Pause'])];
  registerTools(tools, toolNames, shell);

  // 4. Build ChatML
  const chatml = new ChatML();
  chatml.setSystem(agent.system_prompt);

  if (continueRun) {
    const history = await loadHistory(agentId);
    if (history && history.length > 0) {
      // Trim trailing incomplete tool calls
      const trimmed = [...history];
      while (trimmed.length > 0) {
        const last = trimmed[trimmed.length - 1];
        if (last.role === 'assistant' && Array.isArray(last.content)) {
          const hasToolUse = last.content.some((b: any) => b.type === 'tool_use');
          if (hasToolUse) { trimmed.pop(); continue; }
        }
        break;
      }
      while (trimmed.length > 0 && trimmed[trimmed.length - 1].role === 'user') {
        trimmed.pop();
      }

      for (const msg of trimmed) {
        if (msg.role === 'user') chatml.addUser(msg.content);
        else if (msg.role === 'assistant') chatml.addAssistant(msg.content);
      }

      const contMsg = input || 'Continue from where you left off.';
      chatml.addUser(contMsg);
      log('info', 'run.continued', `Replayed ${trimmed.length} messages from previous run (${history.length} total)`);
    } else {
      chatml.addUser(buildInputMessage(trigger, input));
    }
  } else {
    chatml.addUser(buildInputMessage(trigger, input));
  }

  // 5. Persist the initial user message
  const initialMessages = chatml.getMessages();
  const initialUserMsg = initialMessages[initialMessages.length - 1];
  if (initialUserMsg?.role === 'user') {
    await persistMessage(run, 'user', initialUserMsg.content);
  }

  // 6. Run agent loop
  try {
    const requestApproval = async (toolName: string, _input: any): Promise<boolean> => {
      if (agent.type === 'observer') {
        log('warn', 'tool.denied', `Observer agent cannot use mutation tool: ${toolName}`);
        return false;
      }
      return true;
    };

    for await (const event of agentLoop({
      chatml,
      inference,
      tools,
      allowedTools: toolNames,
      cwd: '/workspace',
      requestApproval,
      maxTurns: agent.max_turns,
      signal: abortController.signal,
      model: agent.model,
      getInjectedMessages: () => injectQueue.splice(0),
    })) {
      switch (event.type) {
        case 'stream':
          if (event.event.type === 'text_delta') {
            log('debug', 'llm.text', event.event.text);
          }
          if (event.event.type === 'message_complete') {
            await persistMessage(run, 'assistant', event.event.message.content, {
              stopReason: event.event.stopReason,
              inputTokens: event.event.usage.inputTokens,
              outputTokens: event.event.usage.outputTokens,
            });
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
        await runAgent(msg.agentId, msg.runId, msg.trigger, msg.input, msg.continueRun);
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
      injectQueue.push(msg.message);
      log('info', 'agent.inject', `Message queued for next turn: ${msg.message}`);
      break;

    case 'signal':
      log('info', 'agent.signal', `Signal received: ${msg.name}`, msg.payload);
      break;
  }
});

// ── Process lifecycle ──

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
