import type { Daemon } from '../../daemon/daemon.js';
import { json, error, parseBody, route, type Route } from '../helpers.js';

export function folderRoutes(daemon: Daemon): Route[] {
  return [
    route('GET', '/api/folders', async (_req, res) => {
      const folders = await daemon.listFolders();
      json(res, folders);
    }),

    route('POST', '/api/folders', async (req, res) => {
      const body = await parseBody(req);
      if (!body.name) return error(res, 'name is required');
      const folder = await daemon.createFolder(body.name, body.parentId);
      json(res, folder, 201);
    }),

    route('DELETE', '/api/folders/:id', async (_req, res, params) => {
      try {
        await daemon.deleteFolder(params.id);
        json(res, { ok: true });
      } catch (err: any) {
        error(res, err.message);
      }
    }),
  ];
}
