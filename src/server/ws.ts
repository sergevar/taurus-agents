/**
 * WebSocket terminal handler — bridges xterm.js to a bash session
 * inside an agent's Docker container.
 *
 * Sessions persist across WebSocket disconnects so navigating away
 * and back reconnects to the same bash process (with output replay).
 * Arrow-up history, env vars, cwd — all preserved.
 *
 * Uses the Docker Engine API directly (via Unix socket) instead of
 * `docker exec` CLI. This gives us proper PTY allocation and native
 * resize support via POST /exec/{id}/resize.
 */

import { WebSocketServer, type WebSocket } from 'ws';
import http from 'node:http';
import net from 'node:net';
import type { Daemon } from '../daemon/daemon.js';

const DOCKER_SOCKET = '/var/run/docker.sock';
const REPLAY_LIMIT = 50 * 1024; // 50KB replay buffer per session

// ── Persistent terminal sessions ──

interface TerminalSession {
  containerId: string;
  execId: string;
  stream: net.Socket;
  replay: Buffer[];
  replayBytes: number;
  activeWs: WebSocket | null;
}

const sessions = new Map<string, TerminalSession>();

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

      // Pause so data isn't lost before the caller attaches 'data' handlers.
      // The caller must call socket.resume() after attaching.
      socket.pause();
      if (rest.length > 0) socket.unshift(rest);
      resolve(socket);
    };

    socket.on('data', onData);
    socket.on('error', reject);
  });
}

// ── Session cleanup helper ──

function cleanupSession(agentId: string, stream: net.Socket, message?: string): void {
  const sess = sessions.get(agentId);
  if (sess?.stream !== stream) return;
  sessions.delete(agentId);
  const aw = sess.activeWs;
  if (aw && aw.readyState === aw.OPEN) {
    if (message) aw.send(message);
    aw.close();
  }
}

// ── Connection handler ──

async function handleConnection(ws: WebSocket, agentId: string, daemon: Daemon): Promise<void> {
  // Track this WS as holding the container alive
  daemon.terminalConnected(agentId);
  ws.on('close', () => daemon.terminalDisconnected(agentId));

  // Check for existing persistent session
  const existing = sessions.get(agentId);
  if (existing && !existing.stream.destroyed) {
    // Verify the container is still the same
    try {
      const currentContainerId = await daemon.ensureContainerForBrowsing(agentId);
      if (currentContainerId === existing.containerId) {
        reattach(ws, existing);
        return;
      }
      // Container changed — tear down old session
      existing.stream.destroy();
      sessions.delete(agentId);
    } catch {
      // Container gone — tear down
      existing.stream.destroy();
      sessions.delete(agentId);
    }
  } else if (existing) {
    // Stream destroyed — clean up stale entry
    sessions.delete(agentId);
  }

  // Create new session
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
  let spawning = false;

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
        Env: ['TERM=xterm-256color'],
      });

      const stream = await dockerExecAttach(exec.Id);
      await dockerApi('POST', `/exec/${exec.Id}/resize?h=${rows}&w=${cols}`);

      const session: TerminalSession = {
        containerId,
        execId: exec.Id,
        stream,
        replay: [],
        replayBytes: 0,
        activeWs: ws,
      };
      sessions.set(agentId, session);

      // Flush buffered input
      for (const queued of buffered) stream.write(queued);
      buffered.length = 0;

      // Stream data → replay buffer + active WS
      stream.on('data', (chunk: Buffer) => {
        const sess = sessions.get(agentId);
        if (!sess || sess.stream !== stream) return;

        // Append to replay buffer
        sess.replay.push(chunk);
        sess.replayBytes += chunk.length;
        while (sess.replayBytes > REPLAY_LIMIT && sess.replay.length > 1) {
          sess.replayBytes -= sess.replay.shift()!.length;
        }

        // Forward to active WS
        const aw = sess.activeWs;
        if (aw && aw.readyState === aw.OPEN) {
          aw.send(chunk);
        }
      });

      stream.on('close', () => cleanupSession(agentId, stream, '\r\n\x1b[90m[session ended]\x1b[0m\r\n'));
      stream.on('error', () => cleanupSession(agentId, stream, '\r\n\x1b[31m[session error]\x1b[0m\r\n'));

      // Resume the paused socket now that handlers are attached
      stream.resume();
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
    if (data.startsWith('{')) {
      try {
        const parsed = JSON.parse(data);
        if (parsed.type === 'resize' && parsed.cols && parsed.rows) {
          const sess = sessions.get(agentId);
          if (!sess && !spawning) {
            spawnTerminal(parsed.cols, parsed.rows);
          } else if (sess) {
            dockerApi('POST', `/exec/${sess.execId}/resize?h=${parsed.rows}&w=${parsed.cols}`).catch(() => {});
          }
          return;
        }
      } catch {
        // Not JSON — treat as regular input
      }
    }

    const sess = sessions.get(agentId);
    if (sess?.stream && !sess.stream.destroyed) {
      sess.stream.write(data);
    } else {
      buffered.push(data);
    }
  });

  ws.on('close', () => {
    const sess = sessions.get(agentId);
    if (sess?.activeWs === ws) sess.activeWs = null;
    // Do NOT destroy the stream — session persists
  });

  ws.on('error', () => {
    const sess = sessions.get(agentId);
    if (sess?.activeWs === ws) sess.activeWs = null;
  });

  // Fallback: if no resize arrives within 1s, spawn with defaults
  setTimeout(() => {
    if (!sessions.has(agentId) && !spawning && ws.readyState === ws.OPEN) {
      spawnTerminal(80, 24);
    }
  }, 1000);
}

/** Reattach a WebSocket to an existing persistent session. */
function reattach(ws: WebSocket, session: TerminalSession): void {
  // Close previous WS if still connected
  const prev = session.activeWs;
  if (prev && prev !== ws && prev.readyState === prev.OPEN) {
    prev.close();
  }
  session.activeWs = ws;

  // Replay buffered output so the user sees recent terminal state
  for (const chunk of session.replay) {
    if (ws.readyState === ws.OPEN) ws.send(chunk);
  }

  // Route input to the existing stream
  ws.on('message', (msg: Buffer | string) => {
    const data = msg.toString();
    if (data.startsWith('{')) {
      try {
        const parsed = JSON.parse(data);
        if (parsed.type === 'resize' && parsed.cols && parsed.rows) {
          dockerApi('POST', `/exec/${session.execId}/resize?h=${parsed.rows}&w=${parsed.cols}`).catch(() => {});
          return;
        }
      } catch {
        // Not JSON — treat as regular input
      }
    }
    if (!session.stream.destroyed) {
      session.stream.write(data);
    }
  });

  ws.on('close', () => {
    if (session.activeWs === ws) session.activeWs = null;
  });

  ws.on('error', () => {
    if (session.activeWs === ws) session.activeWs = null;
  });
}
