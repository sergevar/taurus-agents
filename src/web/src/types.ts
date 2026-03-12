export type AgentStatus = 'idle' | 'running' | 'paused' | 'error' | 'disabled';

export interface Agent {
  id: string;
  parent_agent_id: string | null;
  folder_id: string;
  name: string;
  status: AgentStatus;
  cwd: string;
  model: string;
  system_prompt: string;
  tools: string[];
  schedule: string | null;
  schedule_overlap: 'skip' | 'queue' | 'kill';
  next_run: string | null;
  max_turns: number;
  timeout_ms: number;
  metadata: Record<string, unknown> | null;
  docker_image: string;
  mounts: { host: string; container: string; readonly?: boolean }[];
  created_at: string;
  updated_at: string;
}

export type RunStatus = 'running' | 'paused' | 'completed' | 'error' | 'stopped';

export interface Run {
  id: string;
  name: string | null;
  status: RunStatus;
  cwd: string;
  model: string;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
  agent_id: string | null;
  parent_run_id: string | null;
  trigger: string | null;
  run_summary: string | null;
  run_error: string | null;
  last_message: { role: string; text: string } | null;
  created_at: string;
  updated_at: string;
}

export interface MessageUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoningTokens?: number;
  nativeCost?: number;
}

export interface MessageRecord {
  id: string;
  run_id: string;
  seq: number;
  role: 'user' | 'assistant' | 'system';
  content: unknown;
  stop_reason: string | null;
  input_tokens: number;
  output_tokens: number;
  usage?: MessageUsage;
  cost?: number;
  created_at: string;
}

export interface LogEntry {
  level: string;
  event: string;
  message: string;
  timestamp?: string;
  created_at?: string;
  data?: unknown;
}

export interface SSEEvent {
  type: string;
  [key: string]: unknown;
}
