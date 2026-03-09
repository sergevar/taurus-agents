import OpenAI from 'openai';
import type { InferenceRequest, StreamEvent, ChatMessage, ContentBlock, ToolDef } from '../../core/types.js';
import { InferenceProvider } from './base.js';

type OAIMessage = OpenAI.ChatCompletionMessageParam;
type OAITool = OpenAI.ChatCompletionTool;

/**
 * OpenAI-compatible provider.
 *
 * Works with OpenAI, OpenRouter, DeepSeek, vLLM, and any OpenAI-compatible API.
 * Translates between our Anthropic-shaped internal format and the OpenAI Chat Completions API.
 */
export class OpenAIProvider extends InferenceProvider {
  readonly name: string;
  private client: OpenAI;
  private defaultModel: string;

  constructor(opts: { apiKey: string; baseURL?: string; name?: string; defaultModel?: string; defaultHeaders?: Record<string, string> }) {
    super();
    this.name = opts.name ?? 'openai';
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

    const requestBody: Record<string, any> = {
      model,
      messages,
      tools,
      max_tokens: params.maxTokens ?? 16000,
      stream: true,
      stream_options: { include_usage: true },
    };

    // OpenRouter: request reasoning/thinking output for models that support it
    if (this.name === 'openrouter') {
      requestBody.reasoning = { effort: 'high' };
    }

    const stream = await this.client.chat.completions.create(requestBody as OpenAI.ChatCompletionCreateParamsStreaming);

    // Track tool calls being assembled across chunks
    const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
    let textContent = '';
    let reasoningContent = '';
    let finishReason = '';
    let usage: { prompt_tokens: number; completion_tokens: number } | null = null;

    for await (const chunk of stream) {
      // Usage arrives in the final chunk with empty choices
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
            // New tool call starting
            toolCalls.set(idx, { id: tc.id, name: tc.function.name, arguments: tc.function.arguments ?? '' });
            yield { type: 'tool_use_start', id: tc.id, name: tc.function.name };
          } else if (tc.function?.arguments) {
            // Argument fragment
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

    // Assemble the final message in our canonical ContentBlock[] format
    const content = this.assembleContent(textContent, reasoningContent, toolCalls);

    // Map finish_reason to our stop_reason
    const stopReason = finishReason === 'tool_calls' ? 'tool_use' : 'end_turn';

    yield {
      type: 'message_complete',
      message: { role: 'assistant', content } as ChatMessage,
      usage: {
        inputTokens: usage?.prompt_tokens ?? 0,
        outputTokens: usage?.completion_tokens ?? 0,
      },
      stopReason,
    };
  }

  async countTokens(params: InferenceRequest): Promise<number> {
    // No token counting API for OpenAI-compatible providers — rough estimate
    const json = JSON.stringify(params.messages);
    return Math.ceil(json.length / 4);
  }

  // ── Format conversion: our internal (Anthropic-shaped) → OpenAI ──

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
          // Content blocks — may contain tool_results, text, and images
          const toolResults: ContentBlock[] = [];
          const otherBlocks: ContentBlock[] = [];

          for (const block of msg.content) {
            if (block.type === 'tool_result') {
              toolResults.push(block);
            } else {
              otherBlocks.push(block);
            }
          }

          // Emit tool result messages (role: "tool")
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

          // Emit remaining content as a user message (if any)
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
          // Extract tool_use blocks into tool_calls, text into content
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
            // Skip thinking blocks — OpenAI doesn't accept them back
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

  // ── Format conversion: OpenAI response → our internal ContentBlock[] ──

  private assembleContent(
    text: string,
    reasoning: string,
    toolCalls: Map<number, { id: string; name: string; arguments: string }>,
  ): ContentBlock[] {
    const content: ContentBlock[] = [];

    if (reasoning) {
      content.push({ type: 'thinking', thinking: reasoning });
    }

    if (text) {
      content.push({ type: 'text', text });
    }

    for (const [, tc] of toolCalls) {
      let input: any;
      try { input = JSON.parse(tc.arguments); } catch { input = tc.arguments; }
      content.push({ type: 'tool_use', id: tc.id, name: tc.name, input });
    }

    // If no content at all, add empty text to avoid empty content array
    if (content.length === 0) {
      content.push({ type: 'text', text: '' });
    }

    return content;
  }
}
