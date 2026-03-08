# Building a Claude Code Alternative - Design Guide

## Difficulty Assessment

### Core MVP: Medium (2-4 weeks for experienced developer)
The core loop is ~50 lines. The real complexity is in:
1. **Tool implementations** - Each tool needs careful error handling, streaming, timeout management
2. **Permission system** - Rule evaluation, static analysis, approval UI
3. **Context management** - Token counting, compaction, caching
4. **Terminal UI** - Streaming output, keyboard shortcuts, multiline input, colors

### Full Feature Parity: Very Hard (months of work)
- 16+ built-in tools with edge cases
- MCP protocol implementation
- Subagent orchestration with isolation
- 16 hook lifecycle events
- IDE extensions (VS Code, JetBrains)
- Session persistence and resumption
- Git worktree management
- Plugin marketplace system

---

## Minimum Viable Architecture

### Phase 1: Core Loop
```
1. System prompt + CLAUDE.md → initial messages
2. Send to API with tools defined
3. While response has tool_use blocks:
   a. Execute each tool
   b. Append tool results to messages
   c. Send back to API
4. Display final text response
5. Get user input → goto 2
```

### Phase 2: Essential Tools (implement in order)
1. **Read** - File reading with line limits
2. **Edit** - String search-and-replace (the tricky one - uniqueness check)
3. **Write** - File creation
4. **Bash** - Shell execution with timeout, background support
5. **Glob** - File pattern matching (use fast-glob or similar)
6. **Grep** - Content search (shell out to ripgrep)
7. **WebSearch** / **WebFetch** - Web access
8. **TodoWrite** - Task tracking (simple state management)

### Phase 3: Permission System
1. Define permission modes (plan, default, acceptEdits, etc.)
2. Implement rule matching: deny → ask → allow
3. Bash command static analysis
4. Terminal UI for approval prompts
5. Session-scoped permission memory

### Phase 4: Context Management
1. Token counting (use tiktoken or API token counting)
2. Auto-compaction at ~92% capacity
3. Prompt caching (structure messages for cache hits)
4. Checkpoints before file edits

### Phase 5: Extensibility
1. CLAUDE.md loading (hierarchy of files)
2. Skills system (markdown files with frontmatter)
3. Hooks system (lifecycle events → shell commands)
4. MCP client implementation
5. Subagent spawning

---

## 8 Universal Failure Modes to Solve

| Failure Mode | Claude Code Solution | Your Implementation |
|-------------|---------------------|-------------------|
| Runaway Loops | maxTurns + model stop signals | Set turn limits, detect repetitive tool calls |
| Context Collapse | Auto-compaction + subagent isolation | Token counting + summarization |
| Permission Roulette | deny→ask→allow with globs | Rule engine with pattern matching |
| Amnesia | 6-layer memory system | CLAUDE.md + persistent memory files |
| Monolithic Context | Subagents fork isolated loops | Spawn child processes with own context |
| Hard-Coded Behavior | Declarative config files | Skills/hooks as external markdown/json |
| Black Box | Hooks at every lifecycle event | Event emitter pattern with callbacks |
| Single-Threading | Subagents + Agent Teams | Process/thread pool for parallel work |

---

## Comparison: What Makes Each Tool Special

### Claude Code's Strengths (copy these)
- Search-and-replace edits (simple, reliable)
- Ripgrep for code search (fast, no embeddings needed)
- Subagent isolation (protects main context)
- Deterministic hooks (reliable guardrails)
- CLAUDE.md hierarchy (layered instructions)
- File checkpoints (easy rollback)

### Cursor's Strengths (consider adopting)
- Sub-second autocomplete (Tab completion)
- Visual diff preview before applying
- IDE-native experience (no terminal)
- Secondary model for edit merging

### Aider's Strengths (consider adopting)
- Model-agnostic (any LLM provider)
- Unified diff format (line-number based)
- Repository map (automatic codebase summary)
- Voice coding mode
- Cost efficiency (~40-60% cheaper)

---

## Key Technical Decisions

### Edit Format
- **str_replace** (Claude Code): Simple but requires unique match
- **Unified diff** (Aider): Line numbers, but models often get them wrong
- **Full file rewrite** (simple but token-heavy): Good for small files
- **Recommendation**: Start with str_replace, add fallback to full rewrite

### Code Search
- **Ripgrep** (Claude Code): Fast regex, no setup
- **Tree-sitter** (Cursor): AST-aware, understands code structure
- **Embeddings** (various): Semantic search, expensive setup
- **Recommendation**: Start with ripgrep, add tree-sitter later

### Context Strategy
- Track token usage per message
- Implement compaction as summarization (call LLM to summarize old context)
- Put static content (tool defs, system prompt) at beginning for caching
- Isolate verbose operations in subprocesses

### Terminal UI Libraries
- **Python**: rich, textual, prompt_toolkit
- **TypeScript**: ink (React for CLI), blessed, prompts
- **Rust**: ratatui, crossterm
- **Go**: bubbletea, lipgloss

---

## What to Build That Claude Code Doesn't Have

Potential differentiators:
1. **Model-agnostic**: Support OpenAI, Gemini, local models, not just Claude
2. **Visual diff preview**: Show changes before applying (like Cursor)
3. **Repository map**: Auto-generate codebase summary (like Aider)
4. **Tree-sitter integration**: AST-aware code navigation
5. **Voice mode**: Speech-to-text coding
6. **Custom tool SDK**: Easy API for users to add their own tools
7. **Collaborative mode**: Multiple users + AI in same session
8. **Offline mode**: Local models for air-gapped environments
9. **Recording/replay**: Record sessions for training/documentation
10. **Cost dashboard**: Real-time cost tracking across providers

---

## Resources

### Open Source References
- https://github.com/anthropics/claude-code (official, for reference)
- https://github.com/paul-gauthier/aider (model-agnostic alternative)
- https://github.com/anthropics/claude-agent-sdk-python
- https://github.com/anthropics/claude-agent-sdk-demos
- https://github.com/Yuyz0112/claude-code-reverse (reverse engineering tool)

### Documentation
- https://code.claude.com/docs/en/overview
- https://platform.claude.com/docs/en/agent-sdk/overview
- https://modelcontextprotocol.io (MCP spec)

### Architecture Analysis
- https://vrungta.substack.com/p/claude-code-architecture-reverse
- https://blog.promptlayer.com/claude-code-behind-the-scenes-of-the-master-agent-loop/
- https://medium.com/@georgesung/tracing-claude-codes-llm-traffic-agentic-loop-sub-agents-tool-use-prompts-7796941806f5
