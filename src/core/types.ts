// ─── Content Blocks (provider-agnostic, Anthropic-compatible) ───

export type ThinkingBlock = { type: 'thinking'; thinking: string; signature?: string };
export type TextBlock = { type: 'text'; text: string };
export type ImageBlock = { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };
export type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: any };
export type ToolResultBlock = { type: 'tool_result'; tool_use_id: string; content: string | (TextBlock | ImageBlock)[]; is_error?: boolean };
export type CompactionBlock = { type: 'compaction'; content: string };
export type ContentBlock = ThinkingBlock | TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock | CompactionBlock;

export type ChatMessage = {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
};

// ─── Stream Events (emitted by inference, consumed by agents/UI) ───

export type StreamEvent =
  | { type: 'thinking_delta'; text: string }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_input_delta'; id: string; partialJson: string }
  | { type: 'tool_use_end'; id: string; input: any }
  | { type: 'message_complete'; message: ChatMessage; usage: TokenUsage; stopReason: string }
  | { type: 'error'; error: Error };

// ─── Agent Events (emitted by agent loop, consumed by UI) ───

export type AgentEvent =
  | { type: 'stream'; event: StreamEvent }
  | { type: 'tool_start'; name: string; input: any }
  | { type: 'tool_end'; name: string; result: ToolResult }
  | { type: 'tool_denied'; name: string }
  | { type: 'user_message'; message: ChatMessage; meta?: Record<string, any> }
  | { type: 'max_turns_reached' }
  | { type: 'retry'; attempt: number; maxRetries: number; error: string; delayMs: number }
  | { type: 'done' };

// ─── Token Usage ───
//
// Normalized across all providers (Anthropic, OpenAI, OpenRouter).
//
// inputTokens:     TOTAL tokens sent as input — always the full amount, regardless
//                  of caching. Includes cached reads AND cache writes.
//                  • Anthropic raw: input_tokens + cache_read_input_tokens + cache_creation_input_tokens
//                  • OpenAI raw:    prompt_tokens (already includes cached)
//
// outputTokens:    TOTAL output tokens — includes reasoning tokens (if any).
//
// cacheRead:       Subset of inputTokens served from cache (cheaper).
//                  • Anthropic: cache_read_input_tokens
//                  • OpenAI:    prompt_tokens_details.cached_tokens
//
// cacheWrite:      Subset of inputTokens written to cache (may cost more, Anthropic only).
//                  • Anthropic: cache_creation_input_tokens
//                  • OpenAI:    0 (no write surcharge; OpenRouter may report cache_write_tokens)
//
// reasoningTokens: Subset of outputTokens used for internal chain-of-thought (o3, o4-mini, etc.).
//                  Billed as output tokens. Not visible in response content.
//                  • Anthropic: 0 (thinking blocks are in content, not separate)
//                  • OpenAI:    completion_tokens_details.reasoning_tokens
//
// nativeCost:      Provider-reported USD cost (OpenRouter only). When present, this is
//                  the authoritative cost — use it instead of computing from pricing tables.
//
// Cost formula (universal, when nativeCost is not available):
//   uncachedInput = inputTokens - cacheRead - cacheWrite
//   cost = uncachedInput * inputPrice
//        + cacheRead   * cacheReadPrice
//        + cacheWrite  * cacheWritePrice
//        + outputTokens * outputPrice

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** Reasoning/thinking tokens — subset of outputTokens (OpenAI o-series, OpenRouter). */
  reasoningTokens?: number;
  /** Provider-reported USD cost. Authoritative when present (OpenRouter). */
  nativeCost?: number;
};

// ─── Tool Types ───

export type ImageData = {
  base64: string;
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
};

export type ToolDef = {
  name: string;
  description: string;
  input_schema: object;
};

export type ToolResult = {
  output: string;
  isError: boolean;
  durationMs: number;
  images?: ImageData[];
  /** Internal metadata (not sent to LLM). Stored in Message.meta for hydration on resume. */
  metadata?: Record<string, any>;
};

export type ToolContext = {
  cwd: string;
};

// ─── Inference Request ───

export type InferenceRequest = {
  system: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  maxTokens?: number;
  temperature?: number;
  model?: string;
};