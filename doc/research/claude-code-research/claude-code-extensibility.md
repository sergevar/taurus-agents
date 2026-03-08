# Claude Code - Extensibility System

## 5 Extension Mechanisms

### 1. Custom Slash Commands
- Markdown files in `.claude/commands/`
- Auto-detected, exposed as `/command-name`
- Like macros for common prompts

### 2. Skills
- Location: `.claude/skills/<name>/SKILL.md`
- YAML frontmatter: name, description, disable-model-invocation, user-invocable, allowed-tools, model, context, agent, hooks
- Load on-demand (description budget = 2% of context window, fallback 16K chars)
- String substitutions: `$ARGUMENTS`, `$ARGUMENTS[N]`, `$N`, `${CLAUDE_SESSION_ID}`, `` !`command` ``
- `context: fork` runs skill in isolated subagent
- Can be auto-invoked by model or manual via `/skill-name`

### 3. Plugins
Bundled collections with versioning:
```
my-plugin/
├── plugin.json     # Manifest
├── skills/         # Skill definitions
├── agents/         # Custom subagents
├── hooks/          # Lifecycle hooks
├── mcp/            # MCP server configs
└── lsp/            # Language server protocol
```
- Distribution via git repos or marketplaces (official Anthropic + custom)
- Enable/disable per-plugin, auto-update support
- Scopes: user, project, local

### 4. Subagents (Task Tool)
- Spawn specialized agents with isolated context windows
- Return only summary to parent (protects main context)
- Cannot spawn their own subagents (no recursive explosion)
- Up to 7 simultaneous agents

#### Built-in Types
| Type | Purpose | Model |
|------|---------|-------|
| Explore | Fast read-only codebase search | Haiku |
| Plan | Research for planning mode | Inherits |
| General-purpose | Complex multi-step work | Inherits |
| statusline-setup | UI configuration | - |
| claude-code-guide | Feature questions | - |

#### Custom Agents
Markdown files in `.claude/agents/` with YAML frontmatter:
```yaml
---
name: code-reviewer
description: Expert code reviewer
tools: [Read, Glob, Grep]
model: sonnet
permissionMode: default
maxTurns: 20
memory: [user, project]
---
Your instructions here...
```

#### Execution Modes
- **Foreground**: Blocks main conversation, interactive prompts pass through
- **Background**: Concurrent, pre-approved permissions only
- **Resume**: Continue existing subagent with full history
- **Worktree isolation**: `isolation: "worktree"` for isolated git copy

### 5. Agent Teams (Experimental)
- Multiple Claude instances working in parallel
- **Lead**: Main session coordinates
- **Teammates**: Independent instances
- **Shared task list** for coordination
- Direct messaging between agents
- Display: in-process, tmux split, iTerm2 split
- Optimal size: 3-5 teammates
- Enable: `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`

---

## Hooks System (16 Lifecycle Events)

### All Events
| Event | When | Can Block? |
|-------|------|-----------|
| SessionStart | Session begins/resumes | No |
| UserPromptSubmit | Before Claude processes prompt | No |
| **PreToolUse** | Before tool executes | **Yes** |
| PermissionRequest | Permission dialog appears | No |
| PostToolUse | After tool succeeds | No |
| PostToolUseFailure | After tool fails | No |
| Notification | Claude needs attention | No |
| SubagentStart | Subagent spawned | No |
| SubagentStop | Subagent finishes | No |
| Stop | Claude finishes responding | No |
| TeammateIdle | Agent team teammate going idle | No |
| TaskCompleted | Task marked complete | No |
| ConfigChange | Config file modified | No |
| WorktreeCreate | Git worktree created | No |
| WorktreeRemove | Git worktree removed | No |
| PreCompact | Before context compaction | No |

### Hook Types
1. **Command**: Run shell commands (`type: "command"`)
2. **Prompt**: Single LLM call for judgment (`type: "prompt"`)
3. **Agent**: Multi-turn verification with tools (`type: "agent"`)

### Hook Structure
Three nesting levels:
1. Hook Event (lifecycle point)
2. Matcher Group (regex filter, e.g., tool name)
3. Hook Handler (command/prompt/agent to run)

### Exit Code Semantics
- `0`: Allow action (stdout added to context)
- `2`: Block action (stderr becomes feedback to Claude)
- Other: Allow, log stderr

### Common Use Cases
- Desktop notifications when idle
- Auto-format (Prettier) after edits
- Block edits to protected files
- Inject context after compaction
- Validate database queries (read-only)
- Run tests after implementation
- Audit configuration changes

---

## MCP (Model Context Protocol)

### Transport Types
- HTTP (recommended), SSE (deprecated), Stdio (local), WebSocket

### Configuration
```json
// .mcp.json (project scope, committed)
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@latest"]
    }
  }
}
```

### Scopes
- Local: `~/.claude.json` (per-project)
- Project: `.mcp.json` (committed)
- User: `~/.claude.json` (cross-project)
- Managed: `managed-mcp.json` (org-wide)

### Features
- Dynamic tool updates (`list_changed` notifications)
- OAuth support
- Environment variables and headers
- Timeout: `MCP_TIMEOUT` env var
- Output limit: `MAX_MCP_OUTPUT_TOKENS` (default 25K)
- **Tool Search**: Auto-enabled when tools exceed 10% of context (dynamically loads tools on-demand)
- Resources: `@server:protocol://path` syntax
- Prompts: `/mcp__<server>__<prompt>` format

### Popular MCP Servers
GitHub, Sentry, Slack, PostgreSQL, Airtable, Notion, Figma, Confluence, Gmail, Google Calendar, Playwright, Puppeteer

## Sources
- https://code.claude.com/docs/en/skills
- https://code.claude.com/docs/en/hooks
- https://code.claude.com/docs/en/mcp
- https://code.claude.com/docs/en/sub-agents
