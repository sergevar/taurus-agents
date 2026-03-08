import type { Daemon } from '../../daemon/daemon.js';
import { json, error, parseBody, route, type Route } from '../helpers.js';
import { DEFAULT_TOOLS } from '../../core/defaults.js';

export function agentRoutes(daemon: Daemon): Route[] {
  return [
    // ── CRUD ──
    route('GET', '/api/agents', async (req, res) => {
      const url = new URL(req.url!, `http://localhost`);
      const folder_id = url.searchParams.get('folder_id') ?? undefined;
      const agents = await daemon.listAgents(folder_id);
      json(res, agents);
    }),

    route('POST', '/api/agents', async (req, res) => {
      const body = await parseBody(req);
      if (!body.name || !body.type || !body.system_prompt) {
        return error(res, 'name, type, and system_prompt are required');
      }
      try {
        const agent = await daemon.createAgent({
          name: body.name,
          type: body.type,
          system_prompt: body.system_prompt,
          tools: body.tools ?? DEFAULT_TOOLS,
          cwd: body.cwd ?? process.cwd(),
          folder_id: body.folder_id,
          model: body.model,
          schedule: body.schedule,
          schedule_overlap: body.schedule_overlap,
          max_turns: body.max_turns,
          timeout_ms: body.timeout_ms,
          metadata: body.metadata,
          docker_image: body.docker_image,
        });
        json(res, agent, 201);
      } catch (err: any) {
        error(res, err.message);
      }
    }),

    route('GET', '/api/agents/:id', async (_req, res, params) => {
      const agent = await daemon.getAgent(params.id);
      if (!agent) return error(res, 'Agent not found', 404);
      json(res, agent);
    }),

    route('PUT', '/api/agents/:id', async (req, res, params) => {
      const body = await parseBody(req);
      try {
        const agent = await daemon.updateAgent(params.id, body);
        json(res, agent);
      } catch (err: any) {
        error(res, err.message);
      }
    }),

    route('DELETE', '/api/agents/:id', async (_req, res, params) => {
      try {
        await daemon.deleteAgent(params.id);
        json(res, { ok: true });
      } catch (err: any) {
        error(res, err.message);
      }
    }),

    // ── Run Management ──
    route('POST', '/api/agents/:id/run', async (req, res, params) => {
      const body = await parseBody(req);
      try {
        if (body.run_id) {
          // Continue an existing run
          await daemon.continueRun(params.id, body.run_id, body.input);
          json(res, { runId: body.run_id });
        } else {
          // Start a new run
          const runId = await daemon.startRun(
            params.id,
            body.trigger ?? 'manual',
            body.input,
          );
          json(res, { runId }, 201);
        }
      } catch (err: any) {
        error(res, err.message);
      }
    }),

    route('DELETE', '/api/agents/:id/run', async (_req, res, params) => {
      try {
        await daemon.stopRun(params.id, 'API stop request');
        json(res, { ok: true });
      } catch (err: any) {
        error(res, err.message);
      }
    }),

    route('POST', '/api/agents/:id/resume', async (req, res, params) => {
      const body = await parseBody(req);
      try {
        await daemon.resumeAgent(params.id, body.message);
        json(res, { ok: true });
      } catch (err: any) {
        error(res, err.message);
      }
    }),

    route('POST', '/api/agents/:id/inject', async (req, res, params) => {
      const body = await parseBody(req);
      if (!body.message) return error(res, 'message is required');
      try {
        await daemon.injectMessage(params.id, body.message);
        json(res, { ok: true });
      } catch (err: any) {
        error(res, err.message);
      }
    }),

    // ── SSE, Logs, Runs ──
    route('GET', '/api/agents/:id/stream', async (_req, res, params) => {
      await daemon.addSSEClient(params.id, res);
    }),

    route('GET', '/api/agents/:id/logs', async (_req, res, params) => {
      const logs = await daemon.getAgentLogs(params.id, 100);
      json(res, logs);
    }),

    route('GET', '/api/agents/:id/runs', async (_req, res, params) => {
      const runs = await daemon.getAgentRuns(params.id);
      json(res, runs);
    }),

    route('GET', '/api/agents/:id/runs/:runId/messages', async (req, res, params) => {
      const url = new URL(req.url!, `http://localhost`);
      const afterStr = url.searchParams.get('after');
      const afterSeq = afterStr ? parseInt(afterStr, 10) : undefined;
      const messages = await daemon.getRunMessages(params.runId, afterSeq);
      json(res, messages);
    }),
  ];
}
