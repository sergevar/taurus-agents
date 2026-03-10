/**
 * WebSocket terminal handler — bridges xterm.js to a bash session
 * inside an agent's Docker container.
 *
 * Uses the Docker Engine API directly (via Unix socket) instead of
 * `docker exec` CLI + expect. This gives us proper PTY allocation
 * and native resize support via POST /exec/{id}/resize.
 *
 * Flow: wait for initial resize from xterm.js → Docker exec create →
 * exec start (TCP hijack) → bridge raw stream ↔ WebSocket.
 * Resize via Docker API — no stty hacks needed.
 */

import { WebSocketServer, type WebSocket } from 'ws';
import http from 'node:http';
import net from 'node:net';
import type { Daemon } from '../daemon/daemon.js';

const DOCKER_SOCKET = '/var/run/docker.sock';

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

// ── Docker Engine API helpers ──

/** JSON request to Docker Engine API via Unix socket. */
function dockerApi(method: string, path: string, body?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const json = body ? JSON.stringify(body) : undefined;
    const headers: Record<string, string> = {};
    if (json) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(json));
    }

    const req = http.request({ socketPath: DOCKER_SOCKET, path, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`Docker API ${method} ${path}: ${res.statusCode} ${data}`));
          return;
        }
        try { resolve(data ? JSON.parse(data) : null); }
        catch { resolve(data); }
      });
    });

    req.on('error', reject);
    if (json) req.write(json);
    req.end();
  });
}

/** Start exec and return the hijacked raw TCP socket. */
function dockerExecAttach(execId: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ Detach: false, Tty: true });

    const socket = net.connect({ path: DOCKER_SOCKET }, () => {
      socket.write(
        `POST /exec/${execId}/start HTTP/1.1\r\n` +
        `Host: localhost\r\n` +
        `Content-Type: application/json\r\n` +
        `Connection: Upgrade\r\n` +
        `Upgrade: tcp\r\n` +
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        `\r\n` +
        body,
      );
    });

    let buf = Buffer.alloc(0);
    const SEP = Buffer.from('\r\n\r\n');

    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf(SEP);
      if (idx === -1) return;

      socket.removeListener('data', onData);
      const headers = buf.subarray(0, idx).toString();
      const rest = buf.subarray(idx + 4);

      if (!headers.includes(' 101 ')) {
        reject(new Error(`Docker exec attach failed: ${headers}`));
        socket.destroy();
        return;
      }

      if (rest.length > 0) socket.unshift(rest);
      resolve(socket);
    };

    socket.on('data', onData);
    socket.on('error', reject);
  });
}

// ── Connection handler ──

async function handleConnection(ws: WebSocket, agentId: string, daemon: Daemon): Promise<void> {
  let stream: net.Socket | null = null;
  let execId: string | null = null;
  let spawning = false;
  let containerId: string;

  try {
    containerId = await daemon.ensureContainerForBrowsing(agentId);
  } catch (err: any) {
    if (ws.readyState === ws.OPEN) {
      ws.send(`\r\nError: ${err.message}\r\n`);
      ws.close();
    }
    return;
  }

  const buffered: string[] = [];

  async function spawnTerminal(cols: number, rows: number): Promise<void> {
    if (spawning) return;
    spawning = true;

    try {
      const exec = await dockerApi('POST', `/containers/${containerId}/exec`, {
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        Tty: true,
        Cmd: ['/bin/bash'],
      });
      execId = exec.Id;

      stream = await dockerExecAttach(execId!);

      // Set terminal size now that the TTY exists
      await dockerApi('POST', `/exec/${execId}/resize?h=${rows}&w=${cols}`);

      // Flush buffered input
      for (const queued of buffered) stream.write(queued);
      buffered.length = 0;

      stream.on('data', (chunk: Buffer) => {
        if (ws.readyState === ws.OPEN) ws.send(chunk);
      });

      stream.on('close', () => {
        if (ws.readyState === ws.OPEN) ws.close();
      });

      stream.on('error', () => {
        if (ws.readyState === ws.OPEN) ws.close();
      });
    } catch (err: any) {
      spawning = false;
      if (ws.readyState === ws.OPEN) {
        ws.send(`\r\nError: ${err.message}\r\n`);
        ws.close();
      }
    }
  }

  ws.on('message', (msg: Buffer | string) => {
    const data = msg.toString();

    // Handle resize messages from xterm.js
    if (data.startsWith('{')) {
      try {
        const parsed = JSON.parse(data);
        if (parsed.type === 'resize' && parsed.cols && parsed.rows) {
          if (!stream && !spawning) {
            spawnTerminal(parsed.cols, parsed.rows);
          } else if (execId) {
            dockerApi('POST', `/exec/${execId}/resize?h=${parsed.rows}&w=${parsed.cols}`).catch(() => {});
          }
          return;
        }
      } catch {
        // Not JSON — treat as regular input
      }
    }

    if (stream) {
      stream.write(data);
    } else {
      buffered.push(data);
    }
  });

  ws.on('close', () => stream?.destroy());
  ws.on('error', () => stream?.destroy());

  // Fallback: if no resize arrives within 1s, spawn with defaults
  setTimeout(() => {
    if (!stream && !spawning && ws.readyState === ws.OPEN) {
      spawnTerminal(80, 24);
    }
  }, 1000);
}
