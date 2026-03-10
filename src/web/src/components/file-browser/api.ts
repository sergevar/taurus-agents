import type { DirListing } from './types';

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

export const fileApi = {
  listDir(agentId: string, dirPath: string): Promise<DirListing> {
    return request(`/api/agents/${agentId}/files?path=${encodeURIComponent(dirPath)}`);
  },

  readFile(agentId: string, filePath: string): Promise<{ path: string; content: string; size: number }> {
    return request(`/api/agents/${agentId}/files/read`, {
      method: 'POST',
      body: { path: filePath },
    });
  },

  writeFile(agentId: string, filePath: string, content: string): Promise<{ ok: boolean }> {
    return request(`/api/agents/${agentId}/files/write`, {
      method: 'POST',
      body: { path: filePath, content },
    });
  },
};
