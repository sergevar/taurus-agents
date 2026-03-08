# Taurus Agents - Project Memory

## Project Goal
Build a Claude Code-like agentic coding harness with custom features.

## Claude Code Feature Research (Complete)
Comprehensive analysis of Claude Code's architecture and features stored across topic files:

- [claude-code-architecture.md](claude-code-architecture.md) - Core agentic loop, design principles, TAOR pattern
- [claude-code-tools-permissions.md](claude-code-tools-permissions.md) - 16 built-in tools, 5 permission modes, rule evaluation
- [claude-code-extensibility.md](claude-code-extensibility.md) - MCP, hooks (16 events), skills, plugins, subagents, agent teams
- [claude-code-context-memory.md](claude-code-context-memory.md) - Context management, auto-compaction, 6-layer memory, CLAUDE.md
- [claude-code-ide-sdk-deployment.md](claude-code-ide-sdk-deployment.md) - IDE integrations, Agent SDK, headless mode, CI/CD
- [claude-code-building-guide.md](claude-code-building-guide.md) - 10 key design principles, failure modes, comparison with Cursor/Aider

## Key Insight
Claude Code is ~50 lines of core loop logic. All intelligence is in the model. The harness is deliberately simple:
`while (response has tool_calls): execute tool -> feed results back -> repeat`

## Architecture Summary
- Single-threaded TAOR loop (Think-Act-Observe-Repeat)
- 16 built-in tools across 5 categories (file, search, exec, web, orchestration)
- Sub-agents for parallel work with isolated context windows
- 6-layer memory system (org -> project -> user -> auto -> session -> tool)
- Declarative extensibility (skills, hooks, MCP, plugins - all via config files)
- Permission system: deny -> ask -> allow (first match wins)
- Auto-compaction at ~92% context usage
- Checkpoints before every file edit for reversibility
