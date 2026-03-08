# Claude Code Architecture - Deep Dive

## Core Loop: TAOR (Think-Act-Observe-Repeat)

~50 lines of core logic. Deliberately simple:

```
while (response has tool_calls):
    execute tool -> feed results back -> repeat
```

Loop terminates when model produces plain text without tool invocations. All intelligence is in the model, not the harness.

### Three Blended Phases
1. **Gather Context** - Search files, read code, understand the problem
2. **Take Action** - Edit files, run commands, make changes
3. **Verify Results** - Run tests, check output, validate changes

Phases blend naturally. Claude decides what each step requires based on previous step output, chaining dozens of actions and course-correcting.

## Design Principles

### 1. Radical Simplicity
Single while-loop. No complex state machines, DAGs, or orchestration graphs. The model IS the planner.

### 2. Primitive Tools Over Specialization
Four capability primitives: Read, Write, Execute, Connect. Bash acts as universal adapter for anything else.

### 3. Flat Message History
No complex threading or competing agent personas. Single-threaded with isolated sub-agents for parallelism.

### 4. Context as Scarce Resource
Auto-compaction, on-demand skill loading, sub-agent isolation, MCP tool search - all protect the context window.

### 5. Layered Configuration
Organization -> Project -> User -> Session. Deny rules always win.

### 6. Deterministic Hooks for Non-Deterministic Models
Hooks provide reliable, auditable guardrails outside the LLM loop.

### 7. Declarative Extensibility
Skills, commands, agents, plugins, MCP - all configured via files, not code changes.

### 8. Co-Evolution Design
Harness shrinks as models improve. Hard-coded scaffolding deleted with model upgrades.

### 9. Search Over Embeddings
Regex search (ripgrep) over vector embeddings. Transparent and simple.

### 10. Checkpoints and Reversibility
Every file edit creates a snapshot. User can always revert.

## Model Usage
- **Main loop**: Sonnet/Opus for reasoning and tool selection
- **Lightweight checks**: Haiku for quota verification, topic detection
- **Subagents**: Model configurable per-agent (sonnet, opus, haiku, inherit)
- **Extended thinking**: Optional deeper reasoning mode (configurable budget)

## Session Architecture
- Sessions independent, each starts with fresh context window
- Session persistence to disk (resumable with --continue/--resume)
- Session forking (--fork-session for branching approaches)
- Session IDs for headless/CI multi-turn conversations
- Context window dynamically adjusted per model (~200K default)

## Streaming
- Real-time output as model generates tokens
- Tool calls stream as they execute
- Server-sent events for API integration

## Internal Codenames (Community Reverse-Engineered)
- Master agent loop: "nO"
- Real-time steering: "h2A queue"
- Context compressor: "Compressor wU2"
- Sub-agent dispatch: "I2A/Task Agent"

## Sources
- https://code.claude.com/docs/en/how-claude-code-works
- https://vrungta.substack.com/p/claude-code-architecture-reverse
- https://blog.promptlayer.com/claude-code-behind-the-scenes-of-the-master-agent-loop/
- https://github.com/anthropics/claude-code
