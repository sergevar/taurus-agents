import type { AgentEvent, StreamEvent, ToolDef } from '../core/types.js';
import type { ChatML } from '../core/chatml.js';
import type { InferenceService } from '../inference/service.js';
import type { ToolRegistry } from '../tools/registry.js';

export interface AgentLoopParams {
  chatml: ChatML;
  inference: InferenceService;
  tools: ToolRegistry;
  allowedTools: string[];
  cwd: string;

  /** Called for every tool invocation. Defaults to allowing all. */
  requestApproval?: (toolName: string, input: any) => Promise<boolean>;

  /** Maximum inference round-trips before stopping. */
  maxTurns?: number;

  /** Optional signal for graceful cancellation. */
  signal?: AbortSignal;

  /** Model override (passed to inference provider per-request). */
  model?: string;

  /** Returns queued injected messages (drains the queue). Used for mid-run user messages. */
  getInjectedMessages?: () => string[];
}

/**
 * The core TAOR loop: Think → Act → Observe → Repeat.
 *
 * Reusable by any agent. ~50 lines of actual logic.
 * Yields AgentEvents that the UI (or any consumer) can render.
 */
export async function* agentLoop(params: AgentLoopParams): AsyncGenerator<AgentEvent> {
  const { chatml, inference, tools, allowedTools, cwd, requestApproval = async () => true, maxTurns = 0, signal, model, getInjectedMessages } = params;
  let turns = 0;

  while (true) {
    if (signal?.aborted) {
      yield { type: 'done' };
      return;
    }

    if (maxTurns > 0 && turns >= maxTurns) {
      yield { type: 'max_turns_reached' };
      break;
    }

    // ── Check for injected user messages ──
    const injected = getInjectedMessages?.() ?? [];
    if (injected.length > 0) {
      const combined = injected.join('\n\n');
      const messages = chatml.getMessages();
      const last = messages[messages.length - 1];

      if (last?.role === 'user' && Array.isArray(last.content)) {
        // Last message is user with content blocks (e.g. tool_results) — append text block
        (last.content as import('../core/types.js').ContentBlock[]).push({
          type: 'text',
          text: `[User message]: ${combined}`,
        });
      } else {
        // Between turns or first turn — add as user message
        // But we need to ensure alternation. If last is user (string), we can't add another user.
        // In that case, we modify the existing string content.
        if (last?.role === 'user' && typeof last.content === 'string') {
          last.content += `\n\n[User message]: ${combined}`;
        } else {
          chatml.addUser(`[User message]: ${combined}`);
        }
      }
    }

    // ── Think: stream inference ──
    const toolDefs = tools.getToolDefinitions(allowedTools);
    let stopReason = '';

    for await (const event of inference.complete(chatml, toolDefs, model ? { model } : undefined)) {
      yield { type: 'stream', event };

      if (event.type === 'message_complete') {
        stopReason = event.stopReason;

        // Add assistant response to ChatML
        chatml.addAssistant(event.message.content);
      }
    }

    // If model finished without requesting tools → done
    if (stopReason !== 'tool_use') {
      yield { type: 'done' };
      return;
    }

    // ── Act: execute tool calls ──
    const toolUseBlocks = chatml.getToolUseBlocks();

    for (const toolUse of toolUseBlocks) {
      if (signal?.aborted) {
        yield { type: 'done' };
        return;
      }

      // Always run through approval — enforces agent-type policy on every tool
      const approved = await requestApproval(toolUse.name, toolUse.input);
      if (!approved) {
        chatml.addToolResult(toolUse.id, 'Tool denied by policy.', true);
        yield { type: 'tool_denied', name: toolUse.name };
        continue;
      }

      yield { type: 'tool_start', name: toolUse.name, input: toolUse.input };

      // ── Observe: execute and feed result back ──
      const result = await tools.execute(toolUse.name, toolUse.input, { cwd });
      chatml.addToolResult(toolUse.id, result.output, result.isError, result.images);

      yield { type: 'tool_end', name: toolUse.name, result };
    }

    // Yield the user message (tool results) that was just built so it can be persisted
    const allMessages = chatml.getMessages();
    const lastMsg = allMessages[allMessages.length - 1];
    if (lastMsg?.role === 'user') {
      yield { type: 'user_message', message: lastMsg };
    }

    turns++;
    // Loop back → Think again with tool results in context
  }
}
