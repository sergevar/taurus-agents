import type { Agent, Run, MessageRecord } from './types';

async function request<T>(path: string, opts: Omit<RequestInit, 'body'> & { body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export const api = {
  listAgents(folder_id?: string): Promise<Agent[]> {
    const qs = folder_id ? `?folder_id=${folder_id}` : '';
    return request(`/api/agents${qs}`);
  },

  createAgent(data: {
    name: string;
    system_prompt: string;
    tools: string[];
    cwd?: string;
    model?: string;
    docker_image?: string;
    schedule?: string;
    schedule_overlap?: string;
    max_turns?: number;
    timeout_ms?: number;
    mounts?: { host: string; container: string; readonly?: boolean }[];
    parent_agent_id?: string;
  }): Promise<Agent & { error?: string }> {
    return request('/api/agents', { method: 'POST', body: data });
  },

  updateAgent(id: string, data: Partial<{
    name: string;
    system_prompt: string;
    tools: string[];
    cwd: string;
    model: string;
    docker_image: string;
    schedule: string | null;
    schedule_overlap: string;
    max_turns: number;
    timeout_ms: number;
    mounts: { host: string; container: string; readonly?: boolean }[];
  }>): Promise<Agent> {
    return request(`/api/agents/${id}`, { method: 'PUT', body: data });
  },

  deleteAgent(id: string): Promise<{ ok: boolean }> {
    return request(`/api/agents/${id}`, { method: 'DELETE' });
  },

  startRun(agentId: string, opts?: { trigger?: string; input?: string; run_id?: string; images?: { base64: string; mediaType: string }[] }): Promise<{ runId: string }> {
    return request(`/api/agents/${agentId}/run`, {
      method: 'POST',
      body: { trigger: 'manual', ...opts },
    });
  },

  stopRun(agentId: string): Promise<{ ok: boolean }> {
    return request(`/api/agents/${agentId}/run`, { method: 'DELETE' });
  },

  stopSpecificRun(agentId: string, runId: string): Promise<{ ok: boolean }> {
    return request(`/api/agents/${agentId}/runs/${runId}`, { method: 'DELETE' });
  },

  sendMessage(agentId: string, message: string, images?: { base64: string; mediaType: string }[], runId?: string): Promise<{ runId: string }> {
    return request(`/api/agents/${agentId}/message`, {
      method: 'POST',
      body: { message, images, run_id: runId },
    });
  },

  listRuns(agentId: string): Promise<Run[]> {
    return request(`/api/agents/${agentId}/runs`);
  },

  getRunMessages(agentId: string, runId: string, afterSeq?: number): Promise<MessageRecord[]> {
    const qs = afterSeq != null ? `?after=${afterSeq}` : '';
    return request(`/api/agents/${agentId}/runs/${runId}/messages${qs}`);
  },

  listTools(): Promise<{
    tools: { name: string; group: string; description: string }[];
    defaults: { model: string; docker_image: string; tools: string[]; readonly_tools: string[]; supervisor_tools: string[]; max_turns: number; timeout_ms: number };
  }> {
    return request('/api/tools');
  },

  listModels(): Promise<Record<string, { id: string; contextTokens: number; maxOutputTokens: number }[]>> {
    return request('/api/models');
  },
};
