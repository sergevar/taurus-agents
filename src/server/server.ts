import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Daemon } from '../daemon/daemon.js';
import { error, type Route } from './helpers.js';
import { agentRoutes } from './routes/agents.js';
import { folderRoutes } from './routes/folders.js';
import { healthRoutes } from './routes/health.js';
import { toolRoutes } from './routes/tools.js';
import { fileRoutes } from './routes/files.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] ?? 'application/octet-stream';
}

export function createServer(daemon: Daemon, port: number): http.Server {
  const routes: Route[] = [
    ...folderRoutes(),
    ...agentRoutes(daemon),
    ...healthRoutes(),
    ...toolRoutes(),
    ...fileRoutes(daemon),
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

    // Serve static files from Vite build output
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
      const webDist = path.join(__dirname, '..', 'web', 'dist');
      const filePath = path.join(webDist, url.pathname === '/' ? 'index.html' : url.pathname);

      // Prevent directory traversal
      if (!filePath.startsWith(webDist)) {
        error(res, 'Forbidden', 403);
        return;
      }

      try {
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          const content = fs.readFileSync(filePath);
          res.writeHead(200, { 'Content-Type': getMimeType(filePath) });
          res.end(content);
          return;
        }
      } catch {}

      // SPA fallback — serve index.html for all unmatched routes
      try {
        const indexPath = path.join(webDist, 'index.html');
        const html = fs.readFileSync(indexPath, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
        return;
      } catch {
        error(res, 'Not found — run `npm run build:web` first', 404);
        return;
      }
    }

    error(res, 'Not found', 404);
  });

  return server;
}
