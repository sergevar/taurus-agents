// ─── Agent Enums ───

export type AgentStatus = 'idle' | 'running' | 'paused' | 'error' | 'disabled';
export type TriggerType = 'schedule' | 'manual' | 'spawn' | `signal:${string}`;
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// ─── IPC: Parent → Child ───

export type IpcImage = { base64: string; mediaType: string };

export type ParentMessage =
  | { type: 'start'; agentId: string; runId: string; trigger: TriggerType; input?: string; resume?: boolean; images?: IpcImage[]; tools?: string[] }
  | { type: 'stop'; reason: string }
  | { type: 'resume'; message?: string }
  | { type: 'inject'; message: string; images?: IpcImage[] }
  | { type: 'signal'; name: string; payload: unknown }
  | { type: 'spawn_result'; requestId: string; summary: string; error?: string };

// ─── IPC: Child → Parent (coordination only — no DB writes) ───

export type ChildMessage =
  | { type: 'ready' }
  | { type: 'log'; level: LogLevel; event: string; message: string; data?: unknown }
  | { type: 'status'; status: AgentStatus }
  | { type: 'paused'; reason: string }
  | { type: 'run_complete'; summary: string; error?: string;
      tokens: { input: number; output: number; cost: number } }
  | { type: 'signal_emit'; name: string; payload: unknown }
  | { type: 'spawn_request'; requestId: string; input: string; system_prompt?: string; tools?: string[]; max_turns?: number; timeout_ms?: number }
  | { type: 'error'; error: string; stack?: string };

// ─── Root folder well-known ID ───

export const ROOT_FOLDER_ID = '00000000-0000-0000-0000-000000000000';
