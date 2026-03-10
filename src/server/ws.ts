/**
 * WebSocket terminal handler — bridges xterm.js to a bash session
 * inside an agent's Docker container via `docker exec`.
 *
 * Uses node-pty for proper PTY support (colors, readline, resize).
 */

import { WebSocketServer, type WebSocket } from 'ws';
import * as pty from 'node-pty';
import type http from 'node:http';
import type { Daemon } from '../daemon/daemon.js';

/** Attach WebSocket upgrade handler to the HTTP server. */
export function attachTerminalWs(server: http.Server, daemon: Daemon): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url!, `http://localhost`);
    const match = url.pathname.match(/^\/ws\/terminal\/(?<id>[^/]+)$/);
    if (!match?.groups?.id) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      handleConnection(ws, match.groups!.id, daemon);
    });
  });
}

async function handleConnection(ws: WebSocket, agentId: string, daemon: Daemon): Promise<void> {
  try {
    const containerId = await daemon.ensureContainerForBrowsing(agentId);

    const term = pty.spawn('docker', ['exec', '-it', containerId, '/bin/bash'], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      env: process.env as Record<string, string>,
    });

    // Container stdout → WebSocket
    term.onData((data: string) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(data);
      }
    });

    term.onExit(() => {
      if (ws.readyState === ws.OPEN) {
        ws.close();
      }
    });

    // WebSocket → container stdin (or resize commands)
    ws.on('message', (msg: Buffer | string) => {
      const data = msg.toString();

      // Resize messages: JSON with {type: 'resize', cols, rows}
      if (data.startsWith('{')) {
        try {
          const parsed = JSON.parse(data);
          if (parsed.type === 'resize' && parsed.cols && parsed.rows) {
            term.resize(parsed.cols, parsed.rows);
            return;
          }
        } catch {
          // Not JSON — treat as regular input
        }
      }

      term.write(data);
    });

    ws.on('close', () => {
      term.kill();
    });

    ws.on('error', () => {
      term.kill();
    });
  } catch (err: any) {
    if (ws.readyState === ws.OPEN) {
      ws.send(`\r\nError: ${err.message}\r\n`);
      ws.close();
    }
  }
}
