# Taurus Agents

Self-hosted multi-agent platform. Each agent runs in an isolated Docker container with a persistent shell, an LLM-powered control loop, and a configurable tool set. Ships with a web UI for managing agents, browsing files, and interacting via terminal — all in the browser.

## Features

- **Isolated execution** — each agent gets its own Docker container with a persistent shell session
- **Web UI** — real-time streaming of LLM thinking/text/tool output, file editor (Monaco), interactive terminal (xterm.js), agent configuration
- **12 built-in tools** — file ops (Read, Write, Edit, Glob, Grep), shell (Bash), web (WebFetch, WebSearch, Browser), control (Pause, Spawn)
- **Multi-provider** — Anthropic (default), OpenAI, OpenRouter (access to DeepSeek, Llama, etc.)
- **Scheduling** — cron-based with overlap modes (skip, queue, kill)
- **Sub-agents** — spawn child agents for parallel work
- **Blocking API** — `POST /api/ask` sends a message and waits for the response, making it easy to script
- **SSE streaming** — real-time events for building custom frontends
- **SQLite storage** — agents, runs, messages, logs all persisted locally

## Quick start

Prerequisites: Node.js 18+, Docker

```bash
git clone https://github.com/sergevar/taurus-agents.git
cd taurus-agents
npm install

# Set up API keys
cp .env.example .env
# Edit .env — at minimum set ANTHROPIC_API_KEY

# Build the custom Docker image (includes Node.js, Python, ripgrep, Playwright)
docker build -t taurus-base docker/

# Start (builds web UI + starts daemon on :7777)
./taurus dev
```

Open `http://localhost:7777` in your browser.

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

- **Daemon** — parent process managing agent lifecycle, IPC coordination, SSE broadcasting
- **Workers** — one forked child process per running agent, owns the TAOR loop (Think-Act-Observe-Repeat), persists messages to SQLite
- **Docker containers** — one per agent, persistent shell session across commands, tools execute inside
- **SQLite** — stores agents, runs, messages, logs, folders at `data/taurus.db`

## Multi-provider models

Specify the provider as a prefix on the model ID:

```
claude-sonnet-4-20250514          # Anthropic (default, no prefix needed)
openai/gpt-4o                     # OpenAI
openrouter/deepseek/deepseek-r1   # OpenRouter
```

Set the corresponding API key in `.env` for each provider you use.

## Tools

| Tool | Group | Description |
|------|-------|-------------|
| Read | file | Read file contents (binary detection, image support) |
| Write | file | Create or overwrite files |
| Edit | file | String replacement edits with freshness enforcement |
| Glob | search | Find files by glob pattern |
| Grep | search | Search file contents with regex (ripgrep) |
| Bash | exec | Run shell commands in the persistent container shell |
| Pause | control | Pause execution, wait for human input |
| Spawn | control | Spawn sub-agents for parallel work |
| WebSearch | web | Search via Brave Search API |
| WebFetch | web | Fetch and extract web page content |
| Browser | web | Control a headless Chromium browser (Playwright) |

## API

Full reference: [doc/api.md](doc/api.md)

```bash
# List agents
curl localhost:7777/api/agents

# Create an agent
curl -X POST localhost:7777/api/agents \
  -H 'Content-Type: application/json' \
  -d '{"name": "my-agent", "system_prompt": "You are helpful."}'

# Start a run (non-blocking)
curl -X POST localhost:7777/api/agents/<id>/run \
  -H 'Content-Type: application/json' \
  -d '{"input": "Hello"}'

# Blocking ask (waits for completion)
curl -s localhost:7777/api/ask \
  -H 'Content-Type: application/json' \
  -d '{"agent": "my-agent", "message": "What files are in /workspace?"}'
```

## Scheduling

Agents can have a cron schedule. Set `schedule` to a cron expression and `schedule_overlap` to control behavior when a trigger fires while the agent is already running:

- `skip` — drop the trigger (default)
- `queue` — queue it, run after current finishes
- `kill` — stop current run, start new

## System prompt templates

Agent system prompts support placeholders:

| Placeholder | Value |
|-------------|-------|
| `{{datetime}}` | ISO timestamp |
| `{{date}}` | YYYY-MM-DD |
| `{{time}}` | HH:MM:SS |
| `{{year}}` | Current year |
| `{{timezone}}` | System timezone |

## Project structure

```
src/
  index.ts              # Entry point
  core/                 # Types, ChatML builder, defaults
  daemon/               # Parent process, workers, Docker, scheduler, SSE
  agents/               # Core TAOR loop
  inference/            # LLM abstraction + providers (Anthropic, OpenAI, OpenRouter)
  tools/                # Tool implementations (file, search, exec, web, control)
  server/               # HTTP server, routes, WebSocket terminal
  db/                   # Sequelize + SQLite models and migrations
  web/                  # React frontend (Vite, Monaco, xterm.js)
docker/
  Dockerfile            # Custom agent container image
data/
  taurus.db             # SQLite database (auto-created)
doc/
  api.md                # API reference
```

## CLI

```bash
./taurus              # Start daemon
./taurus dev          # Build web UI + start daemon
./taurus build        # Build web UI only
./taurus watch        # Build web UI in watch mode
./taurus status       # Check if daemon is running
```

## Configuration

Copy `.env.example` to `.env` and set your keys:

```bash
ANTHROPIC_API_KEY=     # Required for default Anthropic models
OPENAI_API_KEY=        # Required for openai/ models
OPENROUTER_API_KEY=    # Required for openrouter/ models
BRAVE_SEARCH_API_KEY=  # Required for WebSearch tool
JINA_API_KEY=          # Optional — higher rate limits for WebFetch
TAURUS_PORT=7777       # Server port
```

## License

MIT
