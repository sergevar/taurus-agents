import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Daemon } from '../daemon/daemon.js';
import { error, type Route } from './helpers.js';
import { agentRoutes } from './routes/agents.js';
import { folderRoutes } from './routes/folders.js';
import { healthRoutes } from './routes/health.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function createServer(daemon: Daemon, port: number): http.Server {
  const routes: Route[] = [
    ...folderRoutes(),
    ...agentRoutes(daemon),
    ...healthRoutes(),
  ];

  const server = http.createServer(async (req, res) => {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      return res.end();
    }

    const url = new URL(req.url!, `http://localhost:${port}`);

    // Match API routes
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

    // Serve web UI for non-API paths
    if (req.method === 'GET' && (url.pathname === '/' || !url.pathname.startsWith('/api/'))) {
      const htmlPath = path.join(__dirname, '..', 'web', 'index.html');
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

  return server;
}
