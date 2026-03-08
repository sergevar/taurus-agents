import type { Daemon } from '../../daemon/daemon.js';
import { json, error, parseBody, route, type Route } from '../helpers.js';

export function agentRoutes(daemon: Daemon): Route[] {
  return [
    // ── CRUD ──
    route('GET', '/api/agents', async (req, res) => {
      const url = new URL(req.url!, `http://localhost`);
      const folderId = url.searchParams.get('folderId') ?? undefined;
      const agents = await daemon.listAgents(folderId);
      json(res, agents);
    }),

    route('POST', '/api/agents', async (req, res) => {
      const body = await parseBody(req);
      if (!body.name || !body.type || !body.systemPrompt) {
        return error(res, 'name, type, and systemPrompt are required');
      }
      try {
        const agent = await daemon.createAgent({
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
        const runId = await daemon.startRun(
          params.id,
          body.trigger ?? 'manual',
          body.input,
          body.continueRun ?? false,
        );
        json(res, { runId }, 201);
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
  ];
}
