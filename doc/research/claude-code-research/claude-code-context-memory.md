# Claude Code - Context Management & Memory System

## Context Window Management

### Capacity
- ~200K tokens default (model-dependent, up to 1M via cloud providers)
- Auto-compaction triggers at **~92% usage** (~167K of 200K)
- Buffer reduced to ~33K tokens / 16.5% as of early 2026

### What Fills Context
- Conversation history (messages + tool results)
- CLAUDE.md contents (loaded at startup)
- MCP tool definitions (upfront cost)
- Skill descriptions (always loaded, full content on invoke)
- System instructions
- Extended thinking tokens

### Auto-Compaction
- Replaces older tool outputs first
- Then summarizes conversation history
- Preserves: user requests, key code snippets
- May lose: detailed early instructions (→ put in CLAUDE.md instead)
- Manual: `/compact [focus instructions]` (e.g., `/compact focus on API changes`)
- Visualization: `/context` shows usage grid

### Prompt Caching
- Cache writes: 25% more than base input tokens (5-min TTL)
- Cache reads: 10% of base input price
- Static content (tools, system instructions) placed at beginning for caching

### Cost Optimization
- Sessions stopping at 75% context utilization produce higher-quality code
- Move specialized instructions to skills (load on-demand)
- Use subagents for verbose operations (isolated context)
- Use MCP Tool Search for large server sets
- Model selection: Haiku for lightweight, Sonnet for most tasks, Opus for complex reasoning
- Extended thinking: disable with `MAX_THINKING_TOKENS=0`

---

## 6-Layer Memory System

Loaded at session start (highest to lowest):
1. **Organization policies** (managed settings)
2. **Project context** (CLAUDE.md)
3. **User preferences** (`~/.claude/CLAUDE.md`)
4. **Auto-learned patterns** (auto memory)
5. **Session history** (persisted sessions)
6. **Tool-specific state** (MCP, checkpoints)

---

## CLAUDE.md System

### Hierarchy (highest to lowest priority)
1. Managed policy (`/Library/Application Support/...` or `/etc/claude-code/...`)
2. Local project (`.claude/CLAUDE.md` or `./CLAUDE.md`)
3. User-level (`~/.claude/CLAUDE.md`)
4. Local project personal (`./CLAUDE.local.md`)
5. Auto memory (`~/.claude/projects/<project>/memory/`)

### Features
- Loaded in full at session start
- Child directory CLAUDE.md loaded on-demand when reading those files
- File imports with `@path/syntax` (recursive, max 5 levels)
- Best practice: keep under 300 lines (some teams: under 60)

### What to Include
- Project conventions, coding standards
- Testing expectations
- Architecture notes
- Build/run commands

### What NOT to Include
- Entire codebases
- Verbose explanations
- Info Claude can discover on its own

---

## Modular Rules (.claude/rules/)

- `.md` files in `.claude/rules/` directory
- Path-specific rules with YAML frontmatter `paths` field
- Glob patterns: `src/**/*.ts`, `*.md`, `{src,lib}/**/*.ts`
- Subdirectory organization
- Symlinks for sharing across projects
- User-level: `~/.claude/rules/` (global)

---

## Auto Memory

- **Location**: `~/.claude/projects/<project>/memory/`
- **Structure**: `MEMORY.md` (index, first 200 lines loaded) + topic files
- **Behavior**: Claude reads/writes during session automatically
- **Management**: `/memory` command opens in editor
- **Controls**: `autoMemoryEnabled` setting, `CLAUDE_CODE_DISABLE_AUTO_MEMORY` env var

---

## Session Management

- Independent sessions, each with fresh context
- `claude --continue` / `claude -c`: Resume last session
- `claude --resume` / `claude -r`: Pick specific session
- `--fork-session`: Branch to try different approach
- `--session-id` with `-p`: Maintain context in headless/CI mode
- `--no-session-persistence`: Disable saving
- `/rename`: Custom session names

---

## Checkpoints

- Snapshot before every file edit
- Local to sessions (separate from git)
- `Esc Esc` to rewind to previous state
- Cannot checkpoint remote actions (databases, APIs, deployments)

## Sources
- https://code.claude.com/docs/en/memory
- https://code.claude.com/docs/en/costs
- https://platform.claude.com/docs/en/build-with-claude/compaction
