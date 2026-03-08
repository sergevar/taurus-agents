/**
 * Taurus Daemon — the main entry point.
 *
 * Spawns ThreadManager, HTTP API server, and handles graceful shutdown.
 * ./taurus runs this. Terminal shows structured logs. Web UI on :7777.
 */

import 'dotenv/config';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database } from './db/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Import models so Sequelize registers them
import './db/models/Session.js';
import './db/models/Message.js';
import './db/models/ToolCall.js';
import './db/models/Folder.js';
import './db/models/Thread.js';
import './db/models/ThreadLog.js';

import { ThreadManager } from './threads/thread-manager.js';

const PORT = parseInt(process.env.TAURUS_PORT ?? '7777', 10);

// ── JSON helpers ──

function json(res: http.ServerResponse, data: any, status = 200): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(data));
}

function error(res: http.ServerResponse, message: string, status = 400): void {
  json(res, { error: message }, status);
}

async function parseBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// ── Route matching ──

type Route = {
  method: string;
  pattern: RegExp;
  handler: (req: http.IncomingMessage, res: http.ServerResponse, params: Record<string, string>) => Promise<void>;
};

function route(method: string, path: string, handler: Route['handler']): Route {
  // Convert /api/threads/:id/run to regex with named groups
  const pattern = new RegExp(
    '^' + path.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'
  );
  return { method, pattern, handler };
}

// ── Main ──

async function main() {
  // 1. Boot database
  await Database.sync();

  // 2. Create and init thread manager
  const manager = new ThreadManager();
  await manager.init();

  // 3. Define routes
  const routes: Route[] = [
    // ── Folders ──
    route('GET', '/api/folders', async (_req, res) => {
      const folders = await manager.listFolders();
      json(res, folders);
    }),

    route('POST', '/api/folders', async (req, res) => {
      const body = await parseBody(req);
      if (!body.name) return error(res, 'name is required');
      const folder = await manager.createFolder(body.name, body.parentId);
      json(res, folder, 201);
    }),

    route('DELETE', '/api/folders/:id', async (_req, res, params) => {
      try {
        await manager.deleteFolder(params.id);
        json(res, { ok: true });
      } catch (err: any) {
        error(res, err.message);
      }
    }),

    // ── Threads ──
    route('GET', '/api/threads', async (req, res) => {
      const url = new URL(req.url!, `http://localhost`);
      const folderId = url.searchParams.get('folderId') ?? undefined;
      const threads = await manager.listThreads(folderId);
      json(res, threads);
    }),

    route('POST', '/api/threads', async (req, res) => {
      const body = await parseBody(req);
      if (!body.name || !body.type || !body.systemPrompt) {
        return error(res, 'name, type, and systemPrompt are required');
      }
      try {
        const thread = await manager.createThread({
          name: body.name,
          type: body.type,
          systemPrompt: body.systemPrompt,
          tools: body.tools ?? ['Read', 'Glob', 'Grep'],
          cwd: body.cwd ?? process.cwd(),
          folderId: body.folderId,
          model: body.model,
          schedule: body.schedule,
          maxTurns: body.maxTurns,
          timeoutMs: body.timeoutMs,
          metadata: body.metadata,
          dockerImage: body.dockerImage,
        });
        json(res, thread, 201);
      } catch (err: any) {
        error(res, err.message);
      }
    }),

    route('GET', '/api/threads/:id', async (_req, res, params) => {
      const thread = await manager.getThread(params.id);
      if (!thread) return error(res, 'Thread not found', 404);
      json(res, thread);
    }),

    route('PUT', '/api/threads/:id', async (req, res, params) => {
      const body = await parseBody(req);
      try {
        const thread = await manager.updateThread(params.id, body);
        json(res, thread);
      } catch (err: any) {
        error(res, err.message);
      }
    }),

    route('DELETE', '/api/threads/:id', async (_req, res, params) => {
      try {
        await manager.deleteThread(params.id);
        json(res, { ok: true });
      } catch (err: any) {
        error(res, err.message);
      }
    }),

    // ── Run Management ──
    route('POST', '/api/threads/:id/run', async (req, res, params) => {
      const body = await parseBody(req);
      try {
        const sessionId = await manager.startRun(
          params.id,
          body.trigger ?? 'manual',
          body.input,
          body.continueSession ?? false,
        );
        json(res, { sessionId }, 201);
      } catch (err: any) {
        error(res, err.message);
      }
    }),

    route('DELETE', '/api/threads/:id/run', async (_req, res, params) => {
      try {
        await manager.stopRun(params.id, 'API stop request');
        json(res, { ok: true });
      } catch (err: any) {
        error(res, err.message);
      }
    }),

    route('POST', '/api/threads/:id/resume', async (req, res, params) => {
      const body = await parseBody(req);
      try {
        await manager.resumeThread(params.id, body.message);
        json(res, { ok: true });
      } catch (err: any) {
        error(res, err.message);
      }
    }),

    route('POST', '/api/threads/:id/inject', async (req, res, params) => {
      const body = await parseBody(req);
      if (!body.message) return error(res, 'message is required');
      try {
        await manager.injectMessage(params.id, body.message);
        json(res, { ok: true });
      } catch (err: any) {
        error(res, err.message);
      }
    }),

    // ── Logs & Runs ──
    route('GET', '/api/threads/:id/stream', async (_req, res, params) => {
      // SSE endpoint — keeps connection alive, sends history on connect
      await manager.addSSEClient(params.id, res);
    }),

    route('GET', '/api/threads/:id/logs', async (_req, res, params) => {
      const logs = await manager.getThreadLogs(params.id, 100);
      json(res, logs);
    }),

    route('GET', '/api/threads/:id/runs', async (_req, res, params) => {
      const runs = await manager.getThreadRuns(params.id);
      json(res, runs);
    }),

    // ── Health ──
    route('GET', '/api/health', async (_req, res) => {
      json(res, { status: 'ok', uptime: process.uptime() });
    }),
  ];

  // 4. Create HTTP server
  const server = http.createServer(async (req, res) => {
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      return res.end();
    }

    const url = new URL(req.url!, `http://localhost:${PORT}`);

    for (const r of routes) {
      if (req.method !== r.method) continue;
      const match = url.pathname.match(r.pattern);
      if (match) {
        try {
          await r.handler(req, res, match.groups ?? {});
        } catch (err: any) {
          error(res, `Internal error: ${err.message}`, 500);
        }
        return;
      }
    }

    // Serve web UI for root and unknown paths
    if (req.method === 'GET' && (url.pathname === '/' || !url.pathname.startsWith('/api/'))) {
      const htmlPath = path.join(__dirname, 'web', 'index.html');
      try {
        const html = fs.readFileSync(htmlPath, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
      } catch {
        error(res, 'Not found', 404);
      }
      return;
    }

    error(res, 'Not found', 404);
  });

  const threadCount = (await manager.listThreads()).length;
  server.listen(PORT, () => {
    console.log(`\n  Taurus Daemon v0.1.0`);
    console.log(`  HTTP API: http://localhost:${PORT}`);
    console.log(`  Threads: ${threadCount}`);
    console.log(`  Ctrl+C to stop\n`);
  });

  // 5. Graceful shutdown handling
  let shutdownCount = 0;
  let shutdownInProgress = false;

  async function handleShutdown() {
    shutdownCount++;

    if (shutdownCount === 1 && !shutdownInProgress) {
      shutdownInProgress = true;
      console.log('\nGraceful shutdown... (press Ctrl+C again to force)');
      try {
        await manager.shutdown();
        server.close();
        await Database.close();
        process.exit(0);
      } catch (err) {
        console.error('Shutdown error:', err);
        process.exit(1);
      }
    } else if (shutdownCount === 2) {
      console.log('\nForce shutdown — killing all children...');
      manager.forceShutdown();
      setTimeout(() => process.exit(1), 2000);
    } else {
      process.exit(1);
    }
  }

  process.on('SIGINT', handleShutdown);
  process.on('SIGTERM', handleShutdown);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
