import { v4 as uuidv4 } from 'uuid';
import { json, error, parseBody, route, type Route } from '../helpers.js';
import { ROOT_FOLDER_ID } from '../../daemon/types.js';
import Folder from '../../db/models/Folder.js';
import Agent from '../../db/models/Agent.js';

export function folderRoutes(): Route[] {
  return [
    route('GET', '/api/folders', async (_req, res) => {
      const folders = await Folder.getTree();
      json(res, folders.map(f => f.toApi()));
    }),

    route('POST', '/api/folders', async (req, res) => {
      const body = await parseBody(req);
      if (!body.name) return error(res, 'name is required');
      const folder = await Folder.create({
        id: uuidv4(),
        name: body.name,
        parent_id: body.parentId ?? ROOT_FOLDER_ID,
      });
      json(res, folder.toApi(), 201);
    }),

    route('DELETE', '/api/folders/:id', async (_req, res, params) => {
      try {
        if (params.id === ROOT_FOLDER_ID) throw new Error('Cannot delete root folder');
        const folder = await Folder.findByPk(params.id);
        if (!folder) throw new Error(`Folder not found: ${params.id}`);

        const parentId = folder.parent_id ?? ROOT_FOLDER_ID;
        await Agent.update({ folder_id: parentId }, { where: { folder_id: params.id } });
        await Folder.update({ parent_id: parentId }, { where: { parent_id: params.id } });
        await folder.destroy();

        json(res, { ok: true });
      } catch (err: any) {
        error(res, err.message);
      }
    }),
  ];
}
