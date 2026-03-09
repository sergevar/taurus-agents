import type http from 'node:http';
import type { Daemon } from '../../daemon/daemon.js';
import { json, error, parseBody, route, type Route } from '../helpers.js';
import { DEFAULT_TOOLS } from '../../core/defaults.js';

/**
 * Shared handler for POST /api/ask and POST /api/agents/:id/ask.
 * Sends a message, blocks until the run completes, returns the result.
 */
async function handleAsk(
  daemon: Daemon,
  agentId: string,
  body: any,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const message = body.message;
  if (!message) return error(res, 'message is required');

  const forceNew = body.new === true;
  const full = body.full === true;
  const timeoutMs = body.timeout ?? 300_000;

  // Disable socket timeout for long-running requests
  req.socket.setTimeout(0);

  const agent = await daemon.getAgent(agentId);
  if (!agent) return error(res, 'Agent not found', 404);

  if (agent.status === 'running') {
    return error(res, `Agent "${agent.name}" is already running`);
  }

  try {
    // Register waiter BEFORE starting — prevents race with fast completions
    const completionPromise = daemon.awaitRunCompletion(agentId, timeoutMs);

    let runId: string;

    if (agent.status === 'paused') {
      runId = daemon.getCurrentRunId(agentId) ?? '';
      await daemon.resumeAgent(agentId, message);
    } else if (forceNew) {
      runId = await daemon.startRun(agentId, 'manual', message);
    } else {
      // Continue last run, or start new if none exists
      const runs = await daemon.getAgentRuns(agentId, 1);
      if (runs.length > 0) {
        runId = runs[0].id;
        await daemon.continueRun(agentId, runId, message);
      } else {
        runId = await daemon.startRun(agentId, 'manual', message);
      }
    }

    const result = await completionPromise;

    if (result.error) {
      const payload: any = { error: result.error, run_id: runId };
      if (result.summary) payload.response = result.summary;
      return json(res, payload, 500);
    }

    if (full) {
      const messages = await daemon.getRunMessages(runId);
      json(res, { response: result.summary, run_id: runId, tokens: result.tokens, messages });
    } else {
      json(res, { response: result.summary, run_id: runId, tokens: result.tokens });
    }
  } catch (err: any) {
    error(res, err.message);
  }
}

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
      if (!body.name || !body.system_prompt) {
        return error(res, 'name and system_prompt are required');
      }
      try {
        const agent = await daemon.createAgent({
          name: body.name,
          system_prompt: body.system_prompt,
          tools: body.tools ?? DEFAULT_TOOLS,
          cwd: body.cwd ?? '/workspace',
          folder_id: body.folder_id,
          model: body.model,
          schedule: body.schedule,
          schedule_overlap: body.schedule_overlap,
          max_turns: body.max_turns,
          timeout_ms: body.timeout_ms,
          metadata: body.metadata,
          docker_image: body.docker_image,
          mounts: body.mounts,
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
          await daemon.continueRun(params.id, body.run_id, body.input, body.images);
          json(res, { runId: body.run_id });
        } else {
          // Start a new run
          const runId = await daemon.startRun(
            params.id,
            body.trigger ?? 'manual',
            body.input,
            body.images,
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
        await daemon.injectMessage(params.id, body.message, body.images);
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

    // ── Blocking ask ──

    // By name: POST /api/ask { agent: "my-agent", message: "..." }
    route('POST', '/api/ask', async (req, res) => {
      const body = await parseBody(req);
      if (!body.agent) return error(res, 'agent (name) is required');
      const agent = daemon.findAgentByName(body.agent);
      if (!agent) {
        const all = await daemon.listAgents();
        return error(res, `Agent not found: "${body.agent}". Available: ${all.map(a => a.name).join(', ')}`, 404);
      }
      await handleAsk(daemon, agent.id, body, req, res);
    }),

    // By ID: POST /api/agents/:id/ask { message: "..." }
    route('POST', '/api/agents/:id/ask', async (req, res, params) => {
      const body = await parseBody(req);
      await handleAsk(daemon, params.id, body, req, res);
    }),
  ];
}
