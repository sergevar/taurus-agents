# Taurus Agents — Developer Reference

Internal reference for contributors. For the public overview, see the root [README.md](../README.md).

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
| Read | file | Read file contents (binary detection, image support) |
| Write | file | Create or overwrite files |
| Edit | file | String replacement edits with freshness enforcement |
| Glob | search | Find files by glob pattern |
| Grep | search | Search file contents with regex (ripgrep) |
| Bash | exec | Run shell commands |
| Pause | control | Pause execution, wait for human input |
| Spawn | control | Spawn sub-agents |
| WebSearch | web | Brave Search API |
| WebFetch | web | Fetch and extract web pages |
| Browser | web | Control a headless Chromium browser (Playwright) |

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
    lockfile.ts         # PID-based lockfile (data/taurus.lock)
    sse.ts              # SSE broadcaster
    types.ts            # IPC message types
  agents/
    agent-loop.ts       # Core TAOR loop
  inference/
    service.ts          # Inference abstraction (provider routing)
    providers/
      anthropic.ts      # Anthropic API + extended thinking
      openai.ts         # OpenAI API
      openrouter.ts     # OpenRouter (OpenAI-compatible)
  tools/
    base.ts             # Tool abstract class
    registry.ts         # Tool registration + execution
    shell/              # File and exec tools (Read, Write, Edit, Glob, Grep, Bash)
    web/                # Web tools (WebFetch, WebSearch, Browser)
    control/            # Control tools (Pause, Spawn)
  server/
    server.ts           # HTTP server + routing
    ws.ts               # WebSocket terminal (persistent sessions with replay)
    helpers.ts          # json(), error(), parseBody(), route()
    routes/
      agents.ts         # Agent + run + ask endpoints
      files.ts          # File browser API (list, read, write in container)
      folders.ts        # Folder CRUD
      health.ts         # Health check
      tools.ts          # Tool listing
  db/
    index.ts            # Sequelize + SQLite setup
    models/             # Agent, Run, Message, AgentLog, Folder
  web/
    src/                # React frontend (Vite, React 19, Monaco, xterm.js)
docker/
  Dockerfile            # Custom agent container image (taurus-base)
data/
  taurus.db             # SQLite database (auto-created)
doc/
  api.md                # API reference
  todo.txt              # Development backlog
  research/             # Architecture research notes
```

## CLI

```bash
./taurus              # Start daemon
./taurus dev          # Build web UI + start daemon
./taurus build        # Build web UI only
./taurus watch        # Build web UI in watch mode
./taurus status       # Check if daemon is running
./taurus seed         # Create a test agent via API
```

## DB Migrations

- Always use `npm run makemigration` to generate migrations — never write them by hand
- `makemigration` auto-generates `_current.json` which tracks the schema state; hand-written migrations desync it
- After makemigration, review the generated file — it may pick up unrelated drift if `_current.json` was stale
- Apply with `npm run migrate`
- Migration files are `.cjs` (the npm script auto-renames `.js → .cjs`)

## API

Full API reference: [api.md](api.md)
