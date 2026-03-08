import type { ToolResult, ToolContext } from '../../core/types.js';
import { Tool } from '../base.js';
import type { PersistentShell } from '../../daemon/persistent-shell.js';

export class ShellGrepTool extends Tool {
  readonly name = 'Grep';
  readonly description = 'Search file contents using regex patterns. Returns matching lines with file paths and line numbers.';
  readonly inputSchema = {
    type: 'object' as const,
    properties: {
      pattern: { type: 'string', description: 'The regex pattern to search for' },
      path: { type: 'string', description: 'File or directory to search in. Defaults to cwd.' },
      glob: { type: 'string', description: 'Glob pattern to filter files (e.g. "*.ts")' },
      case_insensitive: { type: 'boolean', description: 'Case insensitive search. Default false.' },
      context: { type: 'number', description: 'Number of context lines before and after each match.' },
    },
    required: ['pattern'],
  };

  constructor(private shell: PersistentShell) { super(); }

  async execute(
    input: { pattern: string; path?: string; glob?: string; case_insensitive?: boolean; context?: number },
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const searchPath = input.path
      ? (input.path.startsWith('/') ? input.path : `${ctx.cwd}/${input.path}`)
      : ctx.cwd;

    const flags = ['-rn', '--color=never'];
    if (input.case_insensitive) flags.push('-i');
    if (input.glob) flags.push(`--include=${JSON.stringify(input.glob)}`);
    if (input.context) flags.push(`-C ${input.context}`);
    flags.push('--exclude-dir=node_modules', '--exclude-dir=.git');

    const cmd = `grep ${flags.join(' ')} ${JSON.stringify(input.pattern)} ${JSON.stringify(searchPath)} 2>/dev/null | head -200`;
    const result = await this.shell.exec(cmd);

    if (result.exitCode === 1 && !result.stdout.trim()) {
      return { output: `No matches for pattern: ${input.pattern}`, isError: false, durationMs: result.durationMs };
    }

    return {
      output: result.stdout || '(no output)',
      isError: result.exitCode !== 0 && result.exitCode !== 1,
      durationMs: result.durationMs,
    };
  }
}
