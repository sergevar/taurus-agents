# Taurus Agents

Multi-agent orchestration framework. Each agent runs in an isolated Docker container with a persistent shell, an LLM-powered TAOR loop (Think-Act-Observe-Repeat), and a configurable tool set.

## Quick start

```bash
# Prerequisites: Node.js 18+, Docker

# Install dependencies
npm install

# Start the daemon (builds web UI, starts HTTP server on :7777)
./taurus dev

# Or just the daemon without web rebuild
./taurus
```

The web UI is at `http://localhost:7777`. The API is at `http://localhost:7777/api/`.

## Architecture

```
┌─────────────┐     HTTP / SSE       ┌──────────────┐
│   Web UI    │◄────────────────────►│   Server     │
│  (React)    │                      │  (routes)    │
└─────────────┘                      └──────┬───────┘
                                            │
                                     ┌──────▼───────┐
                                     │   Daemon     │
                                     │  (parent)    │
                                     └──┬───┬───┬───┘
                                   IPC  │   │   │  IPC
                                  ┌─────▼┐ ┌▼┐ ┌▼─────┐
                                  │Worker│ │…│ │Worker│
                                  │(fork)│ │ │ │(fork)│
                                  └──┬───┘ └─┘ └──┬───┘
                                     │             │
                                  ┌──▼───┐      ┌──▼───┐
                                  │Docker│      │Docker│
                                  └──────┘      └──────┘
```

- **Daemon** (parent process): manages agent lifecycle, coordinates via IPC, broadcasts SSE events.
- **Workers** (forked child processes): one per running agent. Owns the agent loop, persists messages to SQLite, talks to the LLM.
- **Docker containers**: one per agent. Persistent shell session across commands. Tools execute inside the container.
- **SQLite**: stores agents, runs, messages, logs, folders. Located at `data/taurus.db`.

## Concepts

### Runs

A run is a single execution of an agent. It contains a sequence of messages (user/assistant turns). Runs can be:

- **Started**: fresh run with an initial message.
- **Continued**: resumes an existing run, appending to the conversation history.
- **Scheduled**: triggered by a cron expression.

### Tools

| Tool | Group | Description |
|------|-------|-------------|
| Read | file | Read file contents |
| Write | file | Create or overwrite files |
| Edit | file | String replacement edits |
| Glob | search | Find files by pattern |
| Grep | search | Search file contents with regex |
| Bash | exec | Run shell commands |
| Pause | control | Pause execution, wait for human |
| WebSearch | web | Brave search API |
| WebFetch | web | Fetch and extract web pages |
| Browser | web | Control a headless browser |

### System prompt templates

Agent system prompts support these placeholders:

- `{{datetime}}` — ISO timestamp
- `{{date}}` — YYYY-MM-DD
- `{{time}}` — HH:MM:SS
- `{{year}}` — current year
- `{{timezone}}` — system timezone

### Scheduling

Agents can have a `schedule` (cron expression). Overlap behavior when a scheduled trigger fires while the agent is already running:

- `skip` — drop the trigger (default)
- `queue` — queue it, run after current finishes
- `kill` — stop current run, start new

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TAURUS_PORT` | `7777` | HTTP server port |
| `ANTHROPIC_API_KEY` | — | Required. Anthropic API key |
| `BRAVE_SEARCH_API_KEY` | — | Optional. Enables WebSearch tool |

## CLI

```bash
./taurus              # Start daemon
./taurus dev          # Build web UI + start daemon
./taurus build        # Build web UI only
./taurus watch        # Build web UI in watch mode
./taurus seed         # Create a test agent via API
```

## API

Full API reference: [api.md](api.md)

Key endpoints:

```bash
# List agents
curl localhost:7777/api/agents

# Create agent
curl -X POST localhost:7777/api/agents \
  -H 'Content-Type: application/json' \
  -d '{"name": "my-agent", "system_prompt": "You are helpful."}'

# Start a run
curl -X POST localhost:7777/api/agents/<id>/run \
  -H 'Content-Type: application/json' \
  -d '{"input": "Hello"}'

# Blocking ask (waits for completion, returns response)
curl localhost:7777/api/ask \
  -H 'Content-Type: application/json' \
  -d '{"agent": "my-agent", "message": "What files are in /workspace?"}'
```

## Project structure

```
src/
  index.ts              # Entry point — boots DB, daemon, HTTP server
  core/
    types.ts            # Shared types (ContentBlock, ChatMessage, AgentEvent)
    chatml.ts           # ChatML conversation builder
    defaults.ts         # Default values (model, tools, limits)
  daemon/
    daemon.ts           # Parent process — agent lifecycle, IPC, SSE
    agent-worker.ts     # Child process — agent loop, DB writes
    persistent-shell.ts # Persistent bash session (docker exec)
    docker.ts           # Docker container lifecycle
    scheduler.ts        # Cron-based scheduling
    sse.ts              # SSE broadcaster
    types.ts            # IPC message types
  agents/
    agent-loop.ts       # Core TAOR loop (~130 lines)
  inference/
    service.ts          # Inference abstraction
    providers/
      anthropic.ts      # Anthropic API + extended thinking
  tools/
    base.ts             # Tool abstract class
    registry.ts         # Tool registration + execution
    shell/              # File and exec tools (Read, Write, Edit, Glob, Grep, Bash)
    web/                # Web tools (WebFetch, WebSearch)
    control/            # Control tools (Pause)
  server/
    server.ts           # HTTP server + routing
    helpers.ts          # json(), error(), parseBody(), route()
    routes/
      agents.ts         # Agent + run + ask endpoints
      folders.ts        # Folder CRUD
      health.ts         # Health check
      tools.ts          # Tool listing
  db/
    index.ts            # Sequelize + SQLite setup
    models/             # Agent, Run, Message, AgentLog, Folder
  web/
    src/                # React frontend
data/
  taurus.db             # SQLite database (auto-created)
doc/
  README.md             # This file
  api.md                # API reference
  todo.txt              # Development backlog
  research/             # Claude Code architecture research notes
```

## DB Migrations

- Always use `npm run makemigration` to generate migrations — never write them by hand
- `makemigration` auto-generates `_current.json` which tracks the schema state; hand-written migrations desync it
- After makemigration, review the generated file — it may pick up unrelated drift if `_current.json` was stale
- Apply with `npm run migrate`
- Migration files are `.cjs` (the npm script auto-renames `.js → .cjs`)
