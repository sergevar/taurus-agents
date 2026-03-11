import type { ToolResult, ToolContext } from '../../core/types.js';
import { Tool } from '../base.js';
import type { PersistentShell } from '../../daemon/persistent-shell.js';

interface GrepInput {
  pattern: string;
  path?: string;
  glob?: string;
  type?: string;
  case_insensitive?: boolean;
  context?: number;
  '-A'?: number;
  '-B'?: number;
  '-C'?: number;
  output_mode?: 'content' | 'files_with_matches' | 'count';
  head_limit?: number;
  offset?: number;
  multiline?: boolean;
}

export class ShellGrepTool extends Tool {
  readonly name = 'Grep';
  readonly description = 'Search file contents using regex patterns. Returns matching lines with file paths and line numbers.';
  readonly inputSchema = {
    type: 'object' as const,
    properties: {
      pattern: { type: 'string', description: 'The regex pattern to search for' },
      path: { type: 'string', description: 'File or directory to search in. Defaults to cwd.' },
      glob: { type: 'string', description: 'Glob pattern to filter files (e.g. "*.ts", "*.{ts,tsx}")' },
      type: { type: 'string', description: 'File type filter (e.g. "ts", "py", "js"). Ripgrep only.' },
      case_insensitive: { type: 'boolean', description: 'Case insensitive search. Default false.' },
      context: { type: 'number', description: 'Lines of context before and after each match.' },
      '-A': { type: 'number', description: 'Lines to show after each match.' },
      '-B': { type: 'number', description: 'Lines to show before each match.' },
      '-C': { type: 'number', description: 'Lines of context before and after (alias for context).' },
      output_mode: {
        type: 'string',
        enum: ['content', 'files_with_matches', 'count'],
        description: 'Output mode: "content" shows matching lines (default), "files_with_matches" shows only file paths, "count" shows match counts per file.',
      },
      head_limit: { type: 'number', description: 'Max number of output lines/entries. Default 200.' },
      offset: { type: 'number', description: 'Skip first N lines/entries before applying head_limit.' },
      multiline: { type: 'boolean', description: 'Enable multiline matching (pattern can span lines). Ripgrep only.' },
    },
    required: ['pattern'],
  };

  private hasRg: boolean | null = null; // null = not yet checked

  constructor(private shell: PersistentShell) { super(); }

  private async checkRg(): Promise<boolean> {
    if (this.hasRg !== null) return this.hasRg;
    const result = await this.shell.exec('command -v rg >/dev/null 2>&1 && echo YES || echo NO');
    this.hasRg = result.stdout.trim() === 'YES';
    return this.hasRg;
  }

  async execute(input: GrepInput, ctx: ToolContext): Promise<ToolResult> {
    const searchPath = input.path
      ? (input.path.startsWith('/') ? input.path : `${ctx.cwd}/${input.path}`)
      : ctx.cwd;

    const useRg = await this.checkRg();
    const cmd = useRg
      ? this.buildRgCommand(input, searchPath)
      : this.buildGrepCommand(input, searchPath);

    const result = await this.shell.exec(cmd);

    if (result.exitCode === 1 && !result.stdout.trim()) {
      return { output: `No matches for pattern: ${input.pattern}`, isError: false, durationMs: result.durationMs };
    }

    let output = result.stdout || '(no output)';

    // Append pagination info when head_limit is used
    const limit = input.head_limit ?? 200;
    const offset = input.offset ?? 0;
    if (output !== '(no output)') {
      const lines = output.split('\n');
      if (lines.length >= limit) {
        output += `\n\n[Showing results with pagination = limit: ${limit}, offset: ${offset}]`;
      }
    }

    return {
      output,
      isError: result.exitCode !== 0 && result.exitCode !== 1,
      durationMs: result.durationMs,
    };
  }

  private buildRgCommand(input: GrepInput, searchPath: string): string {
    const mode = input.output_mode ?? 'content';
    const limit = input.head_limit ?? 200;
    const offset = input.offset ?? 0;

    const flags: string[] = ['--color=never', '--no-heading', '-M', '500'];

    if (mode === 'content') flags.push('-n'); // line numbers
    if (mode === 'files_with_matches') flags.push('-l');
    if (mode === 'count') flags.push('-c');

    if (input.case_insensitive) flags.push('-i');
    if (input.multiline) flags.push('-U', '--multiline-dotall');

    // Context lines (content mode only)
    if (mode === 'content') {
      const ctxA = input['-A'];
      const ctxB = input['-B'];
      const ctxC = input['-C'] ?? input.context;
      if (ctxC != null) flags.push(`-C`, `${ctxC}`);
      else {
        if (ctxA != null) flags.push(`-A`, `${ctxA}`);
        if (ctxB != null) flags.push(`-B`, `${ctxB}`);
      }
    }

    // File type filter
    if (input.type) flags.push(`--type`, input.type);
    if (input.glob) flags.push(`--glob`, JSON.stringify(input.glob));

    const paginationPipe = offset > 0
      ? `| tail -n +${offset + 1} | head -${limit}`
      : `| head -${limit}`;

    return `rg ${flags.join(' ')} ${JSON.stringify(input.pattern)} ${JSON.stringify(searchPath)} 2>/dev/null ${paginationPipe}`;
  }

  private buildGrepCommand(input: GrepInput, searchPath: string): string {
    const mode = input.output_mode ?? 'content';
    const limit = input.head_limit ?? 200;
    const offset = input.offset ?? 0;

    const flags: string[] = ['-rn', '--color=never'];

    if (mode === 'files_with_matches') flags.push('-l');
    if (mode === 'count') flags.push('-c');
    if (input.case_insensitive) flags.push('-i');
    if (input.glob) flags.push(`--include=${JSON.stringify(input.glob)}`);

    // Context lines
    const ctxC = input['-C'] ?? input.context;
    if (ctxC != null) flags.push(`-C`, `${ctxC}`);
    else {
      if (input['-A'] != null) flags.push(`-A`, `${input['-A']}`);
      if (input['-B'] != null) flags.push(`-B`, `${input['-B']}`);
    }

    flags.push('--exclude-dir=node_modules', '--exclude-dir=.git');

    const paginationPipe = offset > 0
      ? `| tail -n +${offset + 1} | head -${limit}`
      : `| head -${limit}`;

    return `grep ${flags.join(' ')} ${JSON.stringify(input.pattern)} ${JSON.stringify(searchPath)} 2>/dev/null ${paginationPipe}`;
  }
}
