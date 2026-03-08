/**
 * SSEBroadcaster — manages Server-Sent Events connections.
 *
 * Tracks per-agent SSE clients and broadcasts events to them.
 */

import type { ServerResponse } from 'node:http';

export class SSEBroadcaster {
  private clients = new Map<string, Set<ServerResponse>>();

  addClient(agentId: string, res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    if (!this.clients.has(agentId)) {
      this.clients.set(agentId, new Set());
    }
    this.clients.get(agentId)!.add(res);

    res.on('close', () => {
      const set = this.clients.get(agentId);
      if (set) {
        set.delete(res);
        if (set.size === 0) this.clients.delete(agentId);
      }
    });
  }

  broadcast(agentId: string, data: any): void {
    const payload = `data: ${JSON.stringify(data)}\n\n`;
    const set = this.clients.get(agentId);
    if (set) {
      for (const client of set) {
        client.write(payload);
      }
    }
  }

  closeAll(): void {
    for (const set of this.clients.values()) {
      for (const res of set) {
        res.end();
      }
    }
    this.clients.clear();
  }
}
