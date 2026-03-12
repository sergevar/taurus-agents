import OpenAI from 'openai';
import type { Responses } from 'openai/resources/responses/responses';
import type { InferenceRequest, StreamEvent, ChatMessage, ContentBlock, ToolDef } from '../../core/types.js';
import { InferenceProvider } from './base.js';
import { assembleContent, estimateTokens } from './openai-helpers.js';

/**
 * OpenAI Responses API provider.
 *
 * Used for direct OpenAI access. Supports reasoning summaries (thinking),
 * which are only available through the Responses API (not Chat Completions).
 */
export class OpenAIProvider extends InferenceProvider {
  readonly name = 'openai';
  private client: OpenAI;
  private defaultModel: string;

  constructor(opts: { apiKey: string; defaultModel?: string }) {
    super();
    this.defaultModel = opts.defaultModel ?? 'gpt-4o';
    this.client = new OpenAI({ apiKey: opts.apiKey });
  }

  async *stream(params: InferenceRequest): AsyncGenerator<StreamEvent> {
    const model = params.model || this.defaultModel;
    const input = this.convertInput(params.messages);
    const tools = params.tools?.length ? this.convertTools(params.tools) : undefined;
    const maxTokens = params.maxTokens ?? 16000;

    const stream = await this.client.responses.create({
      model,
      instructions: params.system || undefined,
      input,
      tools,
      max_output_tokens: maxTokens,
      reasoning: { summary: 'auto' },
      stream: true,
    });

    // Track state across streaming events
    const toolCalls = new Map<string, { id: string; name: string; arguments: string }>();
    let textContent = '';
    let reasoningContent = '';
    let usage: any = null;
    let hasToolCalls = false;

    for await (const event of stream) {
      switch (event.type) {
        // ── Reasoning summary (thinking) ──
        case 'response.reasoning_summary_text.delta':
          reasoningContent += event.delta;
          yield { type: 'thinking_delta', text: event.delta };
          break;

        // ── Text output ──
        case 'response.output_text.delta':
          textContent += event.delta;
          yield { type: 'text_delta', text: event.delta };
          break;

        // ── Function calls ──
        case 'response.function_call_arguments.delta': {
          const tc = toolCalls.get(event.item_id);
          if (tc) {
            tc.arguments += event.delta;
            yield { type: 'tool_input_delta', id: tc.id, partialJson: event.delta };
          }
          break;
        }

        case 'response.function_call_arguments.done': {
          const tc = toolCalls.get(event.item_id);
          if (tc) {
            tc.arguments = event.arguments;
          }
          break;
        }

        // ── Output item lifecycle ──
        case 'response.output_item.added': {
          const item = event.item as any;
          if (item.type === 'function_call') {
            hasToolCalls = true;
            const callId = item.call_id || item.id;
            toolCalls.set(item.id, { id: callId, name: item.name, arguments: '' });
            yield { type: 'tool_use_start', id: callId, name: item.name };
          }
          break;
        }

        // ── Completion ──
        case 'response.completed': {
          usage = event.response.usage;
          break;
        }
      }
    }

    // Emit tool_use_end for each completed tool call
    for (const [, tc] of toolCalls) {
      let input: any;
      try { input = JSON.parse(tc.arguments); } catch { input = tc.arguments; }
      yield { type: 'tool_use_end', id: tc.id, input };
    }

    // Assemble the final message
    const content = assembleContent(textContent, reasoningContent, toolCalls);
    const stopReason = hasToolCalls ? 'tool_use' : 'end_turn';

    // Normalize usage
    const inputTokens = usage?.input_tokens ?? 0;
    const outputTokens = usage?.output_tokens ?? 0;
    const cacheRead = usage?.input_tokens_details?.cached_tokens ?? 0;
    const reasoningTokens = usage?.output_tokens_details?.reasoning_tokens ?? 0;

    yield {
      type: 'message_complete',
      message: { role: 'assistant', content } as ChatMessage,
      usage: {
        inputTokens,
        outputTokens,
        cacheRead: cacheRead || undefined,
        reasoningTokens: reasoningTokens || undefined,
      },
      stopReason,
    };
  }

  async countTokens(params: InferenceRequest): Promise<number> {
    return estimateTokens(params.messages);
  }

  // ── Format conversion: our internal (Anthropic-shaped) → Responses API ──

  private convertInput(messages: ChatMessage[]): Responses.ResponseInput {
    const input: Responses.ResponseInput = [];

    for (const msg of messages) {
      if (msg.role === 'user') {
        if (typeof msg.content === 'string') {
          input.push({ role: 'user', content: msg.content });
        } else {
          for (const block of msg.content) {
            if (block.type === 'tool_result') {
              let outputStr: string;
              if (typeof block.content === 'string') {
                outputStr = block.content;
              } else {
                outputStr = block.content
                  .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
                  .map(b => b.text)
                  .join('\n');
              }
              input.push({
                type: 'function_call_output',
                call_id: block.tool_use_id,
                output: outputStr,
              });
            } else if (block.type === 'text') {
              input.push({ role: 'user', content: block.text });
            }
            // Skip images for now — Responses API handles them differently
          }
        }
      } else if (msg.role === 'assistant') {
        if (typeof msg.content === 'string') {
          input.push({ role: 'assistant', content: msg.content });
        } else {
          const textParts: string[] = [];
          for (const block of msg.content) {
            if (block.type === 'text') {
              textParts.push(block.text);
            } else if (block.type === 'tool_use') {
              // Flush accumulated text first
              if (textParts.length > 0) {
                input.push({ role: 'assistant', content: textParts.join('\n') });
                textParts.length = 0;
              }
              input.push({
                type: 'function_call',
                call_id: block.id,
                name: block.name,
                arguments: JSON.stringify(block.input),
              });
            }
            // Skip thinking blocks — OpenAI doesn't accept them back
          }
          if (textParts.length > 0) {
            input.push({ role: 'assistant', content: textParts.join('\n') });
          }
        }
      }
    }

    return input;
  }

  private convertTools(tools: ToolDef[]): Responses.Tool[] {
    return tools.map(t => ({
      type: 'function' as const,
      name: t.name,
      description: t.description ?? undefined,
      parameters: t.input_schema as Record<string, unknown>,
      strict: false,
    }));
  }
}
