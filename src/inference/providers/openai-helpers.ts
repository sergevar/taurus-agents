import type { ChatMessage, ContentBlock } from '../../core/types.js';

/**
 * Assemble our canonical ContentBlock[] from accumulated streaming state.
 * Shared by both OpenAI (Responses API) and OpenAI-compat (Chat Completions) providers.
 */
export function assembleContent(
  text: string,
  reasoning: string,
  toolCalls: Map<number | string, { id: string; name: string; arguments: string }>,
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
  if (content.length === 0) {
    content.push({ type: 'text', text: '' });
  }

  return content;
}

/**
 * Rough token estimate for OpenAI-family providers (~4 chars per token).
 */
export function estimateTokens(messages: ChatMessage[]): number {
  const json = JSON.stringify(messages);
  return Math.ceil(json.length / 4);
}
