import type { AgentEvent, StreamEvent, ToolDef, ContentBlock } from '../core/types.js';
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
  getInjectedMessages?: () => { text: string; images?: { base64: string; mediaType: string }[] }[];
}

const TRANSIENT_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'UND_ERR_SOCKET']);
const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 529]);
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 2000;

function isTransientError(err: any): boolean {
  if (TRANSIENT_CODES.has(err?.code)) return true;
  if (TRANSIENT_STATUSES.has(err?.status)) return true;
  const msg = err?.message ?? '';
  return TRANSIENT_CODES.has(msg) || /ECONNRESET|ETIMEDOUT|overloaded/i.test(msg);
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
      const combinedText = injected.map(m => m.text).filter(Boolean).join('\n\n');
      const allImages = injected.flatMap(m => m.images ?? []);

      // Build content blocks for the injected message
      const blocks: ContentBlock[] = [];
      if (combinedText) blocks.push({ type: 'text', text: `[User message]: ${combinedText}` });
      for (const img of allImages) {
        blocks.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.base64 } });
      }

      const messages = chatml.getMessages();
      const last = messages[messages.length - 1];

      if (last?.role === 'user' && Array.isArray(last.content)) {
        // Last message is user with content blocks (e.g. tool_results) — append
        (last.content as ContentBlock[]).push(...blocks);
      } else if (last?.role === 'user' && typeof last.content === 'string') {
        if (allImages.length > 0) {
          // Convert string content to blocks so we can add images
          last.content = [{ type: 'text', text: last.content }, ...blocks];
        } else {
          last.content += `\n\n[User message]: ${combinedText}`;
        }
      } else {
        if (allImages.length > 0) {
          chatml.addUser(blocks);
        } else {
          chatml.addUser(`[User message]: ${combinedText}`);
        }
      }
    }

    // ── Think: stream inference (with retry for transient errors) ──
    const toolDefs = tools.getToolDefinitions(allowedTools);
    let stopReason = '';

    for (let attempt = 0; ; attempt++) {
      try {
        for await (const event of inference.complete(chatml, toolDefs, model ? { model } : undefined)) {
          yield { type: 'stream', event };

          if (event.type === 'message_complete') {
            stopReason = event.stopReason;
            chatml.addAssistant(event.message.content);
          }
        }
        break; // success
      } catch (err: any) {
        // OpenAI SDK buries details in err.error; Anthropic uses err.message directly
        const errMsg = err?.error?.message || err?.message || String(err);
        const errDetail = err?.status ? `[${err.status}] ${errMsg}` : errMsg;

        if (attempt < MAX_RETRIES && isTransientError(err) && !signal?.aborted) {
          const delay = BASE_DELAY_MS * 2 ** attempt;
          yield { type: 'retry', attempt: attempt + 1, maxRetries: MAX_RETRIES, error: errDetail, delayMs: delay };
          await new Promise(r => {
            const timer = setTimeout(r, delay);
            signal?.addEventListener('abort', () => { clearTimeout(timer); r(undefined); }, { once: true });
          });
          if (signal?.aborted) throw err;
          continue;
        }
        throw new Error(errDetail);
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
