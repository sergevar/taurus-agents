# Taurus API Reference

Base URL: `http://localhost:7777` (configurable via `TAURUS_PORT` env var)

All endpoints accept and return JSON. Set `Content-Type: application/json` on requests with a body.

---

## Agents

### List agents

```
GET /api/agents
GET /api/agents?folder_id=<uuid>
```

Returns an array of agent objects. Optionally filter by folder.

### Create agent

```
POST /api/agents
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `name` | string | yes | — | Unique agent name |
| `type` | string | yes | — | `"observer"` (read-only tools) or `"actor"` (all tools) |
| `system_prompt` | string | yes | — | System prompt. Supports `{{datetime}}`, `{{date}}`, `{{time}}`, `{{year}}`, `{{timezone}}` |
| `tools` | string[] | no | `["Read", "Glob", "Grep"]` | Tool names to enable |
| `cwd` | string | no | daemon cwd | Working directory (mapped to `/workspace` in container) |
| `model` | string | no | `claude-sonnet-4-20250514` | LLM model ID |
| `docker_image` | string | no | `taurus-base` | Docker image for the agent's container |
| `schedule` | string | no | — | Cron expression for scheduled runs |
| `schedule_overlap` | string | no | `"skip"` | `"skip"`, `"queue"`, or `"kill"` |
| `max_turns` | number | no | `0` | Max inference turns per run (0 = unlimited) |
| `timeout_ms` | number | no | `300000` | Run timeout in ms |
| `folder_id` | string | no | root | UUID of parent folder |
| `metadata` | object | no | — | Arbitrary JSON metadata |

Returns `201` with the created agent object.

### Get agent

```
GET /api/agents/:id
```

Returns the agent object plus `next_run` (ISO timestamp or null).

### Update agent

```
PUT /api/agents/:id
```

Body: any subset of the fields from Create. Returns the updated agent.

### Delete agent

```
DELETE /api/agents/:id
```

Stops any running process, removes the Docker container, and deletes the agent and its logs.

---

## Runs

### Start or continue a run

```
POST /api/agents/:id/run
```

| Field | Type | Description |
|-------|------|-------------|
| `input` | string | Message to send to the agent |
| `trigger` | string | `"manual"` (default) or `"schedule"` |
| `run_id` | string | If provided, continues this existing run instead of starting a new one |

Returns `{"runId": "..."}`. This is non-blocking — the run starts in a background worker process.

### Stop a run

```
DELETE /api/agents/:id/run
```

Sends a graceful stop signal. Waits up to 10s, then kills.

### Resume a paused agent

```
POST /api/agents/:id/resume
```

| Field | Type | Description |
|-------|------|-------------|
| `message` | string | Optional message to pass when resuming |

Resumes an agent that paused itself via the Pause tool.

### Inject a message

```
POST /api/agents/:id/inject
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `message` | string | yes | Message queued for the agent's next turn |

Injects a user message into a running agent. If the agent is paused, this also resumes it.

### List runs

```
GET /api/agents/:id/runs
```

Returns runs sorted by `created_at` DESC (latest first), limit 20.

### Get run messages

```
GET /api/agents/:id/runs/:runId/messages
GET /api/agents/:id/runs/:runId/messages?after=<seq>
```

Returns the full message history for a run. Use `after` for pagination — only returns messages with `seq` greater than the given value.

---

## Blocking Ask

Send a message to an agent and wait for the full response. The HTTP request blocks until the agent's run completes (or times out).

### By name

```
POST /api/ask
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `agent` | string | yes | — | Agent name (exact, case-sensitive) |
| `message` | string | yes | — | Message to send |
| `new` | boolean | no | `false` | Force a new run instead of continuing the last one |
| `full` | boolean | no | `false` | Include all run messages in the response |
| `timeout` | number | no | `300000` | Timeout in ms |

### By ID

```
POST /api/agents/:id/ask
```

Same fields as above, minus `agent`.

### Response

Default:

```json
{
  "response": "The agent's final text output...",
  "run_id": "uuid",
  "tokens": { "input": 1234, "output": 567, "cost": 0 }
}
```

With `"full": true`, adds a `messages` array containing every message in the run.

### Behavior

- By default, continues the agent's most recent run (appends to conversation history).
- If no previous run exists, starts a new one.
- If the agent is paused, resumes it with the message.
- Returns `400` if the agent is already running.
- Returns `500` with `{"error": "..."}` on agent errors.

### Examples

```bash
# Simple ask
curl -s localhost:7777/api/ask \
  -H 'Content-Type: application/json' \
  -d '{"agent": "my-agent", "message": "What happened today?"}'

# Force new run
curl -s localhost:7777/api/ask \
  -H 'Content-Type: application/json' \
  -d '{"agent": "my-agent", "message": "Start fresh.", "new": true}'

# Full messages for jq
curl -s localhost:7777/api/ask \
  -H 'Content-Type: application/json' \
  -d '{"agent": "my-agent", "message": "Summarize.", "full": true}' \
  | jq '.messages[-1].content'

# By ID
curl -s localhost:7777/api/agents/73665a54-a2db-4e28-9943-8968fa8d081a/ask \
  -H 'Content-Type: application/json' \
  -d '{"message": "What is your status?"}'
```

---

## SSE Stream

```
GET /api/agents/:id/stream
```

Server-Sent Events stream. On connect, sends:

1. `init` — agent object
2. `history` — recent log entries
3. `messages` — messages from the latest run

Then streams live events:

| Event type | Description |
|------------|-------------|
| `llm_thinking` | Extended thinking text delta |
| `llm_text` | Response text delta |
| `log` | Structured log entry (tool executions, status changes, etc.) |
| `run_status` | Run status changed (`running`, `completed`, `error`, `stopped`) |
| `run_complete` | Run finished — includes `summary`, `error`, `tokens` |
| `agent_status` | Agent status changed (`idle`, `running`, `paused`, `error`) |
| `agent_paused` | Agent paused itself (via Pause tool) |
| `agent_error` | Agent error |

---

## Tools

### List available tools

```
GET /api/tools
```

Returns:

```json
{
  "tools": [
    { "name": "Read", "group": "file", "description": "..." },
    ...
  ],
  "defaults": {
    "model": "claude-sonnet-4-20250514",
    "docker_image": "taurus-base",
    "tools": ["Read", "Glob", "Grep"],
    "max_turns": 0,
    "timeout_ms": 300000
  }
}
```

---

## Folders

### List folder tree

```
GET /api/folders
```

### Create folder

```
POST /api/folders
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Folder name |
| `parent_id` | string | no | Parent folder UUID (defaults to root) |

### Delete folder

```
DELETE /api/folders/:id
```

Cannot delete root. Agents and subfolders are moved to the parent.

---

## File Browser

Browse and edit files inside an agent's Docker container.

### List directory

```
GET /api/agents/:id/files?path=/workspace
```

Returns `{ path, entries }` where each entry has `name` and `type` (`"file"`, `"dir"`, or `"symlink"`). Defaults to `/workspace`.

### Read file

```
POST /api/agents/:id/files/read
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `path` | string | yes | Absolute path inside the container |

Returns `{ path, content, size }`. Max 1MB.

### Write file

```
POST /api/agents/:id/files/write
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `path` | string | yes | Absolute path inside the container |
| `content` | string | yes | File content |

Creates parent directories automatically. Returns `{ ok: true }`.

---

## Health

```
GET /api/health
```

Returns `{"status": "ok", "uptime": <seconds>}`.
