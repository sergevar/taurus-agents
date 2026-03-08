# Claude Code - Tools & Permission System

## Built-in Tools (16 total)

### File Operations
| Tool | Description |
|------|-------------|
| **Read** | Read files (~2000 lines default), images, PDFs, notebooks |
| **Write** | Create new files or complete rewrites |
| **Edit** | Exact string replacement (old_string -> new_string), fails if not unique |
| **MultiEdit** | Multiple edits in single operation |
| **NotebookEdit** | Jupyter cell editing (replace, insert, delete) |

### Search & Discovery
| Tool | Description |
|------|-------------|
| **Glob** | Fast file pattern matching (`**/*.js`, `src/**/*.ts`) |
| **Grep** | Regex content search (built on ripgrep), file type/glob filtering |
| **LS** | Directory listing |

### Execution
| Tool | Description |
|------|-------------|
| **Bash** | Shell commands, persistent working directory, timeout support |
| **BashOutput** | Read output from background bash commands |
| **KillBash** | Terminate running bash processes |

### Web
| Tool | Description |
|------|-------------|
| **WebSearch** | Search the web for current information |
| **WebFetch** | Fetch/parse web pages, HTML to markdown conversion |

### Orchestration
| Tool | Description |
|------|-------------|
| **TodoWrite** | Structured task list management |
| **Task** | Spawn sub-agents for delegated work |
| **ExitPlanMode** | Exit plan mode to begin implementation |

### Additional (IDE/Desktop)
| Tool | Description |
|------|-------------|
| **AskUserQuestion** | Request clarification from user |
| **Chrome** | Browser automation (desktop only) |
| **ToolSearch** | Dynamic tool discovery from MCP servers |
| **Computer** | Computer interface interaction |

## Edit Format: Search-and-Replace
Claude Code uses str_replace: search for exact string, replace it.
- **Pro**: Simple, reliable, minimal tokens
- **Con**: Fails if string appears >1 time or whitespace doesn't match
- **vs Cursor**: Cursor uses secondary model to merge changes
- **vs Aider**: Aider generates unified diffs with line numbers

## Tool Risk Classification
- **Auto-approved (read-only)**: Read, Glob, Grep, WebSearch, LS, TodoWrite
- **Requires approval**: Edit, Write, Bash, WebFetch, NotebookEdit, Task

---

## Permission System

### 5 Permission Modes (cycle with Shift+Tab)
| Mode | Behavior |
|------|----------|
| `plan` | Read-only tools only, creates plan for approval |
| `default` | Asks before file edits and shell commands |
| `acceptEdits` | Auto-approves file edits, asks for commands |
| `dontAsk` | Auto-approves whitelisted tools only |
| `bypassPermissions` | Skip all prompts (enterprise, high-risk) |

### Rule Evaluation Order
**deny -> ask -> allow** (first match wins). Deny always takes precedence.

### Permission Rule Syntax
- **Bash patterns**: `Bash(npm run *)`, `Bash(git * main)`, wildcards with word boundaries
- **File patterns**: Gitignore-style globs
  - Absolute: `//path/to/file`
  - Home: `~/path`
  - Relative to project: `/src/**/*.ts`
  - Relative to cwd: `src/**/*.ts`
- **WebFetch domain**: `WebFetch(domain:example.com)`
- **MCP tools**: `mcp__server__tool`, `mcp__server__*`
- **Subagents**: `Task(AgentName)`

### Configuration Locations (highest to lowest precedence)
1. Managed settings (enterprise policies)
2. CLI flags (`--allowedTools`, `--disallowedTools`)
3. `.claude/settings.local.json` (personal, gitignored)
4. `.claude/settings.json` (project, committed)
5. `~/.claude/settings.json` (user-wide)

### Static Analysis
Bash commands undergo static analysis before execution to detect risky operations (system file modification, sensitive directory access).

### Managed Settings (Enterprise)
- `disableBypassPermissionsMode` - Prevent bypass mode
- `allowManagedPermissionRulesOnly` - Only managed rules apply
- `allowedMcpServers` / `deniedMcpServers` - MCP allowlist/denylist
- `allowManagedHooksOnly` - Only managed hooks
- `allowManagedMcpServersOnly` - Only managed MCP servers

## Sources
- https://code.claude.com/docs/en/permissions
- https://www.vtrivedy.com/posts/claudecode-tools-reference
