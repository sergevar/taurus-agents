import OpenAI from 'openai';
import type { InferenceRequest, StreamEvent, ChatMessage, ContentBlock, ToolDef } from '../../core/types.js';
import { InferenceProvider } from './base.js';
import { assembleContent, estimateTokens } from './openai-helpers.js';

type OAIMessage = OpenAI.ChatCompletionMessageParam;
type OAITool = OpenAI.ChatCompletionTool;

/**
 * OpenAI-compatible Chat Completions provider.
 *
 * Used for OpenRouter, DeepSeek, vLLM, and any OpenAI-compatible API.
 * Thinking output comes via `reasoning_content` in stream deltas (OpenRouter).
 */
export class OpenAICompatProvider extends InferenceProvider {
  readonly name: string;
  private client: OpenAI;
  private defaultModel: string;

  constructor(opts: { apiKey: string; baseURL?: string; name?: string; defaultModel?: string; defaultHeaders?: Record<string, string> }) {
    super();
    this.name = opts.name ?? 'openai-compat';
    this.defaultModel = opts.defaultModel ?? 'gpt-4o';
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
      defaultHeaders: opts.defaultHeaders,
    });
  }

  async *stream(params: InferenceRequest): AsyncGenerator<StreamEvent> {
    const model = params.model || this.defaultModel;
    const messages = this.convertMessages(params.system, params.messages);
    const tools = params.tools?.length ? this.convertTools(params.tools) : undefined;

    const maxTokens = params.maxTokens ?? 16000;
    const requestBody: Record<string, any> = {
      model,
      messages,
      tools,
      max_tokens: maxTokens,
      stream: true,
      stream_options: { include_usage: true },
    };

    // OpenRouter: request reasoning/thinking output for models that support it.
    if (this.name === 'openrouter') {
      requestBody.reasoning = { effort: 'high' };
    }

    const stream = await this.client.chat.completions.create(requestBody as OpenAI.ChatCompletionCreateParamsStreaming);

    // Track tool calls being assembled across chunks
    const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
    let textContent = '';
    let reasoningContent = '';
    let finishReason = '';
    let usage: any = null;

    for await (const chunk of stream) {
      if (chunk.usage) {
        usage = chunk.usage;
      }

      const choice = chunk.choices?.[0];
      if (!choice) continue;

      const delta = choice.delta;

      // Reasoning and text are mutually exclusive per chunk.
      // OpenRouter sends the same text on multiple fields simultaneously,
      // so we pick one: reasoning_content > reasoning > content.
      const rc = (delta as any)?.reasoning_content ?? (delta as any)?.reasoning;
      if (rc) {
        reasoningContent += rc;
        yield { type: 'thinking_delta', text: rc };
      } else if (delta?.content) {
        textContent += delta.content;
        yield { type: 'text_delta', text: delta.content };
      }

      // Tool calls
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;

          if (tc.id && tc.function?.name) {
            toolCalls.set(idx, { id: tc.id, name: tc.function.name, arguments: tc.function.arguments ?? '' });
            yield { type: 'tool_use_start', id: tc.id, name: tc.function.name };
          } else if (tc.function?.arguments) {
            const existing = toolCalls.get(idx);
            if (existing) {
              existing.arguments += tc.function.arguments;
              yield { type: 'tool_input_delta', id: existing.id, partialJson: tc.function.arguments };
            }
          }
        }
      }

      if (choice.finish_reason) {
        finishReason = choice.finish_reason;
      }
    }

    // Emit tool_use_end for each completed tool call
    for (const [, tc] of toolCalls) {
      let input: any;
      try { input = JSON.parse(tc.arguments); } catch { input = tc.arguments; }
      yield { type: 'tool_use_end', id: tc.id, input };
    }

    const content = assembleContent(textContent, reasoningContent, toolCalls);
    const stopReason = finishReason === 'tool_calls' ? 'tool_use' : 'end_turn';

    // Normalize usage — inputTokens is always the TOTAL (see TokenUsage docs in types.ts).
    // OpenRouter: same shape as OpenAI, plus inline `cost` field and `cache_write_tokens`.
    const promptTokens = usage?.prompt_tokens ?? 0;
    const completionTokens = usage?.completion_tokens ?? 0;
    const cacheRead = usage?.prompt_tokens_details?.cached_tokens ?? 0;
    const cacheWrite = usage?.prompt_tokens_details?.cache_write_tokens ?? 0; // OpenRouter only
    const reasoningTokens = usage?.completion_tokens_details?.reasoning_tokens ?? 0;
    const nativeCost = typeof usage?.cost === 'number' ? usage.cost : undefined; // OpenRouter only

    yield {
      type: 'message_complete',
      message: { role: 'assistant', content } as ChatMessage,
      usage: {
        inputTokens: promptTokens,
        outputTokens: completionTokens,
        cacheRead: cacheRead || undefined,
        cacheWrite: cacheWrite || undefined,
        reasoningTokens: reasoningTokens || undefined,
        nativeCost,
      },
      stopReason,
    };
  }

  async countTokens(params: InferenceRequest): Promise<number> {
    return estimateTokens(params.messages);
  }

  // ── Format conversion: our internal (Anthropic-shaped) → Chat Completions ──

  private convertMessages(system: string, messages: ChatMessage[]): OAIMessage[] {
    const result: OAIMessage[] = [];

    if (system) {
      result.push({ role: 'system', content: system });
    }

    for (const msg of messages) {
      if (msg.role === 'user') {
        if (typeof msg.content === 'string') {
          result.push({ role: 'user', content: msg.content });
        } else {
          const toolResults: ContentBlock[] = [];
          const otherBlocks: ContentBlock[] = [];

          for (const block of msg.content) {
            if (block.type === 'tool_result') {
              toolResults.push(block);
            } else {
              otherBlocks.push(block);
            }
          }

          for (const block of toolResults) {
            if (block.type === 'tool_result') {
              let content: string;
              if (typeof block.content === 'string') {
                content = block.content;
              } else {
                content = block.content
                  .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
                  .map(b => b.text)
                  .join('\n');
              }
              result.push({ role: 'tool', tool_call_id: block.tool_use_id, content });
            }
          }

          if (otherBlocks.length > 0) {
            const parts = this.convertContentParts(otherBlocks);
            if (parts.length > 0) {
              result.push({ role: 'user', content: parts });
            }
          }
        }
      } else if (msg.role === 'assistant') {
        if (typeof msg.content === 'string') {
          result.push({ role: 'assistant', content: msg.content });
        } else {
          const textParts: string[] = [];
          const toolCalls: OpenAI.ChatCompletionMessageToolCall[] = [];

          for (const block of msg.content) {
            if (block.type === 'text') {
              textParts.push(block.text);
            } else if (block.type === 'tool_use') {
              toolCalls.push({
                id: block.id,
                type: 'function',
                function: { name: block.name, arguments: JSON.stringify(block.input) },
              });
            }
          }

          const assistantMsg: OpenAI.ChatCompletionAssistantMessageParam = {
            role: 'assistant',
            content: textParts.join('\n') || null,
          };
          if (toolCalls.length > 0) {
            assistantMsg.tool_calls = toolCalls;
          }
          result.push(assistantMsg);
        }
      }
    }

    return result;
  }

  private convertContentParts(blocks: ContentBlock[]): OpenAI.ChatCompletionContentPart[] {
    const parts: OpenAI.ChatCompletionContentPart[] = [];
    for (const block of blocks) {
      if (block.type === 'text') {
        parts.push({ type: 'text', text: block.text });
      } else if (block.type === 'image') {
        parts.push({
          type: 'image_url',
          image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` },
        });
      }
    }
    return parts;
  }

  private convertTools(tools: ToolDef[]): OAITool[] {
    return tools.map(t => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema as OpenAI.FunctionParameters,
      },
    }));
  }
}
