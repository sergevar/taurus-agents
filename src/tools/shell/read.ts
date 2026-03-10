import type { ToolResult, ToolContext } from '../../core/types.js';
import { Tool } from '../base.js';
import type { PersistentShell } from '../../daemon/persistent-shell.js';

export class ShellReadTool extends Tool {
  readonly name = 'Read';
  readonly description = 'Read a file from the filesystem. Returns contents with line numbers.';
  readonly inputSchema = {
    type: 'object' as const,
    properties: {
      file_path: { type: 'string', description: 'The path to the file to read' },
      offset: { type: 'number', description: 'Line number to start reading from (1-based)' },
      limit: { type: 'number', description: 'Maximum number of lines to read. Default 2000.' },
    },
    required: ['file_path'],
  };

  constructor(private shell: PersistentShell) { super(); }

  async execute(input: { file_path: string; offset?: number; limit?: number }, context: ToolContext): Promise<ToolResult> {
    const fp = input.file_path.startsWith('/') ? input.file_path : `${context.cwd}/${input.file_path}`;
    const offset = Math.max(1, input.offset ?? 1);
    const limit = input.limit ?? 2000;
    const end = offset + limit - 1;

    // Get total line count and content in one pass
    const cmd = `wc -l < ${JSON.stringify(fp)} 2>/dev/null; sed -n '${offset},${end}p' ${JSON.stringify(fp)} 2>&1`;
    const result = await this.shell.exec(cmd);

    if (result.exitCode !== 0) {
      return { output: result.stdout || `Error reading file: ${fp}`, isError: true, durationMs: result.durationMs };
    }

    const lines = result.stdout.split('\n');
    const totalLines = parseInt(lines[0].trim(), 10) || 0;
    const contentLines = lines.slice(1);

    // Add line numbers — pad width adapts to the largest line number
    const maxNum = offset + contentLines.length - 1;
    const padWidth = String(maxNum).length;
    const numbered = contentLines.map((line, i) => {
      const lineNum = String(offset + i).padStart(padWidth, ' ');
      return `${lineNum}\t${line}`;
    }).join('\n');

    const header = `File: ${fp} (${totalLines} lines)`;
    const showing = contentLines.length < totalLines
      ? `\n[Showing lines ${offset}-${offset + contentLines.length - 1} of ${totalLines}]`
      : '';

    return { output: `${header}${showing}\n${numbered}`, isError: false, durationMs: result.durationMs };
  }
}
