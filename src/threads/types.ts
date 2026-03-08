// ─── Thread Enums ───

export type ThreadType = 'observer' | 'actor';
export type ThreadStatus = 'idle' | 'running' | 'paused' | 'error' | 'disabled';
export type TriggerType = 'schedule' | 'manual' | `signal:${string}`;
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// ─── Thread Config (DB → memory → IPC) ───

export interface ThreadConfig {
  id: string;
  folderId: string;
  name: string;
  type: ThreadType;
  status: ThreadStatus;
  cwd: string;
  model: string;
  systemPrompt: string;
  tools: string[];
  schedule: string | null;
  maxTurns: number;
  timeoutMs: number;
  metadata: Record<string, unknown>;
  /** Docker container name. Derived from thread ID: taurus-thread-{id} */
  containerId: string;
  /** Docker image to use for the container */
  dockerImage: string;
}

// ─── IPC: Parent → Child ───

export type ParentMessage =
  | { type: 'start'; config: ThreadConfig; sessionId: string; trigger: TriggerType; input?: string; history?: Array<{ role: string; content: any }> }
  | { type: 'stop'; reason: string }
  | { type: 'resume'; message?: string }
  | { type: 'inject'; message: string }
  | { type: 'signal'; name: string; payload: unknown };

// ─── IPC: Child → Parent ───

export type ChildMessage =
  | { type: 'ready' }
  | { type: 'log'; level: LogLevel; event: string; message: string; data?: unknown }
  | { type: 'status'; status: ThreadStatus }
  | { type: 'paused'; reason: string }
  | { type: 'message_persist'; sessionId: string; role: string; content: any;
      stopReason?: string; inputTokens?: number; outputTokens?: number }
  | { type: 'tool_persist'; messageId: string; toolName: string; toolInput: string;
      toolOutput: string; isError: boolean; durationMs: number }
  | { type: 'signal_emit'; name: string; payload: unknown }
  | { type: 'run_complete'; sessionId: string; summary: string; error?: string;
      tokens: { input: number; output: number; cost: number } }
  | { type: 'error'; error: string; stack?: string };

// ─── Root folder well-known ID ───

export const ROOT_FOLDER_ID = '00000000-0000-0000-0000-000000000000';
