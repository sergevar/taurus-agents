import type { ToolResult, ToolContext } from '../../core/types.js';
import { Tool } from '../base.js';
import type { PersistentShell } from '../../daemon/persistent-shell.js';

export class ShellGlobTool extends Tool {
  readonly name = 'Glob';
  readonly description = 'Find files matching a glob pattern. Supports ** for recursive matching (e.g. "**/*.ts", "src/**/*.js"). Returns matching file paths sorted by name.';
  readonly inputSchema = {
    type: 'object' as const,
    properties: {
      pattern: { type: 'string', description: 'The glob pattern to match files against (e.g. "**/*.ts", "src/*.js")' },
      path: { type: 'string', description: 'The directory to search in. Defaults to cwd.' },
    },
    required: ['pattern'],
  };

  constructor(private shell: PersistentShell) { super(); }

  async execute(input: { pattern: string; path?: string }, context: ToolContext): Promise<ToolResult> {
    const searchDir = input.path
      ? (input.path.startsWith('/') ? input.path : `${context.cwd}/${input.path}`)
      : context.cwd;

    // Use bash globstar for full glob support (** patterns)
    // nullglob: no output if nothing matches instead of the literal pattern
    // dotglob is off by default (skip hidden files)
    const cmd = `cd ${JSON.stringify(searchDir)} && shopt -s globstar nullglob && files=(${input.pattern}) && for f in "\${files[@]}"; do [ -f "$f" ] && echo "$f"; done | grep -v node_modules | grep -v '.git/' | sort | head -500`;
    const result = await this.shell.exec(cmd);

    const files = result.stdout.trim().split('\n').filter(Boolean);
    if (files.length === 0) {
      return { output: `No files matched pattern: ${input.pattern}`, isError: false, durationMs: result.durationMs };
    }

    return {
      output: `${files.length} file(s) found:\n${files.join('\n')}`,
      isError: false,
      durationMs: result.durationMs,
    };
  }
}
