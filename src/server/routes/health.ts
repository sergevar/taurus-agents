import { json, route, type Route } from '../helpers.js';

export function healthRoutes(): Route[] {
  return [
    route('GET', '/api/health', async (_req, res) => {
      json(res, { status: 'ok', uptime: process.uptime() });
    }),
  ];
}
