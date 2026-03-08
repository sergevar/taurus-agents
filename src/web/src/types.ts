export type AgentStatus = 'idle' | 'running' | 'paused' | 'error' | 'disabled';

export interface Agent {
  id: string;
  folder_id: string;
  name: string;
  type: 'observer' | 'actor';
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
  created_at: string;
  updated_at: string;
}

export interface Run {
  id: string;
  name: string | null;
  cwd: string;
  model: string;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
  agent_id: string | null;
  trigger: string | null;
  run_summary: string | null;
  run_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface MessageRecord {
  id: string;
  run_id: string;
  seq: number;
  role: 'user' | 'assistant';
  content: unknown;
  stop_reason: string | null;
  input_tokens: number;
  output_tokens: number;
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
