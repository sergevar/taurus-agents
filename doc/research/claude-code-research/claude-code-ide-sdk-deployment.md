# Claude Code - IDE Integrations, SDK, & Deployment

## IDE Integrations

### VS Code Extension
- Inline prompt box, `@` file references
- Resume past conversations, multiple simultaneous conversations
- Switch to terminal mode
- Plugin management, MCP server connection
- Chrome integration, Git operations
- Worktree support, background process monitoring

### JetBrains IDEs
- IntelliJ IDEA, PyCharm, WebStorm, etc.
- IDE-embedded prompt, external terminal support
- Remote development and WSL support

### Desktop App (macOS & Windows)
- Visual diff review (side-by-side)
- Inline comments on changes
- Live app preview (embedded browser)
- Auto-verify with screenshots
- PR monitoring with GitHub CI status
- Auto-fix & auto-merge PRs
- Parallel sessions via Git worktrees
- Connectors: GitHub, Slack, Linear
- SSH remote development
- Cloud sessions (Anthropic-hosted VMs)

### Chrome Extension
- Test local web apps, debug with console
- Automate form filling, draft in Google Docs
- Extract web data, record demo GIFs
- Per-site permissions

---

## Claude Agent SDK

### Languages
- **TypeScript**: `@anthropic-ai/claude-agent-sdk`
- **Python**: `claude_agent_sdk`
- Also: Go, Java, C#, Ruby, PHP (basic support)

### Key Difference from Client SDK
- **Client SDK**: You implement the tool loop manually
- **Agent SDK**: Claude handles tools autonomously (built-in tool execution)

### Python Example
```python
from claude_agent_sdk import query, ClaudeAgentOptions

async for message in query(
    prompt="Find and fix the bug in auth.py",
    options=ClaudeAgentOptions(allowed_tools=["Read", "Edit", "Bash"]),
):
    print(message)
```

### TypeScript Example
```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: "Find and fix the bug in auth.py",
  options: { allowedTools: ["Read", "Edit", "Bash"] }
})) {
  console.log(message);
}
```

### SDK Capabilities
- Built-in tools (Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch, AskUserQuestion)
- Hooks (PreToolUse, PostToolUse, Stop, SessionStart, SessionEnd, etc.)
- Custom subagents via AgentDefinition
- MCP server connection
- Permission modes + canUseTool callback
- Session resume/fork
- Auto-compaction
- Skills/commands loading
- Streaming (AsyncGenerator)

### Authentication
- Anthropic API key (primary)
- AWS Bedrock: `CLAUDE_CODE_USE_BEDROCK=1`
- Google Vertex AI: `CLAUDE_CODE_USE_VERTEX=1`
- Microsoft Azure: `CLAUDE_CODE_USE_FOUNDRY=1`
- LiteLLM Gateway (unified endpoint)

---

## Headless Mode & CI/CD

### Non-Interactive Usage
```bash
claude -p "Find all TODO comments" --output-format json
```

### Output Formats
- `text`, `json`, `stream-json`
- `--json-schema` for structured output
- ~85% of CI/CD uses `json` format

### Multi-Turn CI Sessions
```bash
claude -p "Read the auth module" --session-id my-review
claude -p "Now find all callers" --session-id my-review
```

### Budget & Limits
- `--max-budget-usd` for cost limits
- `--max-turns` for iteration limits
- `--fallback-model` on overload

### CI/CD Integrations
- **GitHub Actions**: `anthropics/claude-code-action` - full agent on PRs
- **GitLab CI**: YAML config for MRs
- **Slack**: Automatic repo detection, session creation

### Piping & Unix
```bash
cat file | claude -p "query"    # stdin input
claude -p "query" | next_cmd    # pipe output
```

---

## Git Integration

### Features
- Auto-detect git state (branch, uncommitted changes)
- Commit workflow with AI-generated messages
- PR creation via GitHub CLI
- Branch management, cross-branch session continuity
- Merge conflict resolution

### Worktrees
- Isolate parallel sessions per branch
- Auto-created by desktop sessions
- Manual: `claude --worktree <name>`
- Storage: `<repo>/.claude/worktrees/<name>`
- Auto-cleanup when session exits
- Subagent isolation: `isolation: "worktree"`

---

## Remote & Cloud

### Remote Control
- `claude remote-control` starts session
- QR code for browser access
- Short-lived credentials, TLS encryption
- Data stays local

### Cloud Sessions
- Anthropic-managed VMs
- Sessions continue offline
- Default image with dev tools
- Limited network access (allowlisted domains)
- GitHub proxy for repo access

### Session Handoff
- CLI to Web: `claude --remote "task"`
- Web to CLI: `/teleport`
- Cross-platform movement

---

## Slash Commands

### Navigation & Control
`/clear`, `/exit`, `/help`, `/doctor`

### Context & Memory
`/context`, `/memory`, `/init`, `/compact [focus]`

### Session
`/resume`, `/rename`, `/rewind`, `/copy`, `/export`

### Cost & Usage
`/cost`, `/stats`, `/usage`

### Configuration
`/config`, `/permissions`, `/status`, `/statusline`, `/theme`

### Tools
`/mcp`, `/agents`, `/plan`, `/model`, `/vim`

### Background
`/tasks`, `/teleport`, `/desktop`

### Debug
`/debug`, `/terminal-setup`

---

## Keyboard Shortcuts

### General
- `Ctrl+C` Cancel, `Ctrl+D` Exit, `Ctrl+L` Clear screen
- `Ctrl+O` Verbose mode, `Ctrl+G` Open in editor
- `Ctrl+R` History search, `Ctrl+T` Task list toggle
- `Ctrl+V` Paste image, `Ctrl+B` Background tasks
- `Ctrl+F` Kill background agents
- `Esc Esc` Rewind, `Shift+Tab` Toggle permission modes
- `Alt+P` Switch model, `Alt+T` Toggle extended thinking

### Multiline Input
- `\` + Enter, `Option+Enter` (macOS), `Shift+Enter`, `Ctrl+J`

### Bash Mode
- Prefix with `!` to run shell commands directly

## Sources
- https://platform.claude.com/docs/en/agent-sdk/overview
- https://code.claude.com/docs/en/headless
- https://github.com/anthropics/claude-code-action
- https://code.claude.com/docs/en/interactive-mode
