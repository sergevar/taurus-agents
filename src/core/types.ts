// ─── Content Blocks (provider-agnostic, Anthropic-compatible) ───

export type TextBlock = { type: 'text'; text: string };
export type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: any };
export type ToolResultBlock = { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };
export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export type ChatMessage = {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
};

// ─── Stream Events (emitted by inference, consumed by agents/UI) ───

export type StreamEvent =
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
  | { type: 'user_message'; message: ChatMessage }
  | { type: 'max_turns_reached' }
  | { type: 'done' };

// ─── Token Usage ───

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheRead?: number;
  cacheWrite?: number;
};

// ─── Tool Types ───

export type ToolDef = {
  name: string;
  description: string;
  input_schema: object;
};

export type ToolResult = {
  output: string;
  isError: boolean;
  durationMs: number;
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
