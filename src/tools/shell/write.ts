import type { ToolResult, ToolContext } from '../../core/types.js';
import { Tool } from '../base.js';
import type { PersistentShell } from '../../daemon/persistent-shell.js';
import type { FileTracker } from './file-tracker.js';

export class ShellWriteTool extends Tool {
  readonly name = 'Write';
  readonly description = 'Write content to a file. Creates parent directories if needed. Overwrites existing files. If overwriting, you must Read the file first.';
  readonly requiresApproval = true;
  readonly inputSchema = {
    type: 'object' as const,
    properties: {
      file_path: { type: 'string', description: 'The path to the file to write' },
      content: { type: 'string', description: 'The content to write' },
    },
    required: ['file_path', 'content'],
  };

  constructor(private shell: PersistentShell, private tracker?: FileTracker) { super(); }

  async execute(input: { file_path: string; content: string }, context: ToolContext): Promise<ToolResult> {
    const fp = input.file_path.startsWith('/') ? input.file_path : `${context.cwd}/${input.file_path}`;

    // Freshness check: if file exists, must have been Read first
    if (this.tracker) {
      const stat = await this.shell.exec(`stat -c %Y ${JSON.stringify(fp)} 2>/dev/null || stat -f %m ${JSON.stringify(fp)} 2>/dev/null`);
      if (stat.exitCode === 0) {
        // File exists — check freshness
        const currentMtime = parseInt(stat.stdout.trim(), 10);
        const err = this.tracker.checkFreshness(fp, currentMtime);
        if (err) return { output: err, isError: true, durationMs: stat.durationMs };
      }
      // File doesn't exist — new file, no freshness check needed
    }

    // Ensure parent directory exists, then write via base64 to avoid escaping issues
    const b64 = Buffer.from(input.content).toString('base64');
    const cmd = `mkdir -p $(dirname ${JSON.stringify(fp)}) && echo ${JSON.stringify(b64)} | base64 -d > ${JSON.stringify(fp)}`;
    const result = await this.shell.exec(cmd);

    if (result.exitCode !== 0) {
      return { output: `Error writing file: ${result.stdout}`, isError: true, durationMs: result.durationMs };
    }

    // Update tracked mtime
    if (this.tracker) {
      const stat = await this.shell.exec(`stat -c %Y ${JSON.stringify(fp)} 2>/dev/null || stat -f %m ${JSON.stringify(fp)} 2>/dev/null`);
      if (stat.exitCode === 0) this.tracker.updateMtime(fp, parseInt(stat.stdout.trim(), 10));
    }

    return { output: `File written: ${fp} (${input.content.length} bytes)`, isError: false, durationMs: result.durationMs };
  }
}
