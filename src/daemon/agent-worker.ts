/**
 * agent-worker.ts — Universal child process entry point.
 *
 * Spawned via child_process.fork() by Daemon.
 * Receives AgentConfig via IPC, runs the agent loop, sends events back.
 * All DB writes go through parent via IPC messages.
 */

import 'dotenv/config';
import type { ParentMessage, ChildMessage, AgentConfig, TriggerType, LogLevel } from './types.js';
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
  // All tools execute through PersistentShell (which uses docker exec in Docker mode)
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

  // Always register Pause even if not in the list — agents need it
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

// ── Main run function ──

async function runAgent(config: AgentConfig, runId: string, trigger: TriggerType, input?: string, history?: Array<{ role: string; content: any }>): Promise<void> {
  log('info', 'run.started', `Agent "${config.name}" started (trigger: ${trigger})`);
  send({ type: 'status', status: 'running' });

  // 1. Initialize inference
  const provider = new AnthropicProvider();
  const inference = new InferenceService(provider);

  // 2. Initialize persistent shell (Docker mode — all tools execute inside container)
  const shell = new PersistentShell({
    mode: 'docker',
    containerId: config.containerId,
    cwd: '/workspace',
  });
  await shell.spawn();

  // 3. Register tools
  const tools = new ToolRegistry();
  // Ensure Pause is always available
  const toolNames = [...new Set([...config.tools, 'Pause'])];
  registerTools(tools, toolNames, shell);

  // 4. Build ChatML
  const chatml = new ChatML();
  chatml.setSystem(config.systemPrompt);

  if (history && history.length > 0) {
    // Continuing a previous run — replay prior messages
    // Trim trailing incomplete tool calls: if last assistant message has tool_use
    // blocks without matching tool_result in a following user message, drop it
    const trimmed = [...history];
    while (trimmed.length > 0) {
      const last = trimmed[trimmed.length - 1];
      if (last.role === 'assistant' && Array.isArray(last.content)) {
        const hasToolUse = last.content.some((b: any) => b.type === 'tool_use');
        if (hasToolUse) {
          // No following user message with tool_result — incomplete, drop it
          trimmed.pop();
          continue;
        }
      }
      break;
    }

    // Ensure history ends with an assistant message (API requires user→assistant alternation)
    // If it ends with user, drop the trailing user message
    while (trimmed.length > 0 && trimmed[trimmed.length - 1].role === 'user') {
      trimmed.pop();
    }

    for (const msg of trimmed) {
      if (msg.role === 'user') chatml.addUser(msg.content);
      else if (msg.role === 'assistant') chatml.addAssistant(msg.content);
    }

    // Add the continuation prompt (or injected input)
    const contMsg = input || 'Continue from where you left off.';
    chatml.addUser(contMsg);
    log('info', 'run.continued', `Replayed ${trimmed.length} messages from previous run (${history.length} total)`);
  } else {
    chatml.addUser(buildInputMessage(trigger, input));
  }

  // 5. Run agent loop
  try {
    const requestApproval = async (toolName: string, _input: any): Promise<boolean> => {
      // Observers can't use mutation tools
      if (config.type === 'observer') {
        log('warn', 'tool.denied', `Observer agent cannot use mutation tool: ${toolName}`);
        return false;
      }
      // Actors auto-approve for now (agents are autonomous)
      return true;
    };

    for await (const event of agentLoop({
      chatml,
      inference,
      tools,
      allowedTools: toolNames,
      cwd: '/workspace',
      requestApproval,
      maxTurns: config.maxTurns,
      signal: abortController.signal,
      model: config.model,
      getInjectedMessages: () => injectQueue.splice(0),
    })) {
      switch (event.type) {
        case 'stream':
          if (event.event.type === 'text_delta') {
            log('debug', 'llm.text', event.event.text);
          }
          if (event.event.type === 'message_complete') {
            send({
              type: 'message_persist',
              sessionId: runId,
              role: 'assistant',
              content: event.event.message.content,
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

        case 'max_turns_reached':
          log('warn', 'run.max_turns', `Max turns (${config.maxTurns}) reached`);
          break;

        case 'done':
          break;
      }
    }
  } finally {
    injectQueue.length = 0;
    await shell.close();
  }

  // 6. Get final text from ChatML as summary
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

  // 7. Report completion
  const usage = inference.getUsage();
  send({
    type: 'run_complete',
    sessionId: runId,
    summary,
    tokens: {
      input: usage.inputTokens,
      output: usage.outputTokens,
      cost: 0, // TODO: calculate from model pricing
    },
  });
}

// ── IPC message handling ──

process.on('message', async (msg: ParentMessage) => {
  switch (msg.type) {
    case 'start':
      try {
        await runAgent(msg.config, msg.sessionId, msg.trigger, msg.input, msg.history);
      } catch (err: any) {
        send({ type: 'error', error: err.message, stack: err.stack });
      }
      // Exit cleanly after run completes
      process.exit(0);
      break;

    case 'stop':
      log('info', 'agent.stopping', `Stopping: ${msg.reason}`);
      abortController.abort();
      // Give agent loop time to notice the signal
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
  // Parent died
  abortController.abort();
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  send({ type: 'error', error: err.message, stack: err.stack });
  process.exit(1);
});

// ── Signal readiness ──
send({ type: 'ready' });
