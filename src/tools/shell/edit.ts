import type { ToolResult, ToolContext } from '../../core/types.js';
import { Tool } from '../base.js';
import type { PersistentShell } from '../../daemon/persistent-shell.js';
import type { FileTracker } from './file-tracker.js';

export class ShellEditTool extends Tool {
  readonly name = 'Edit';
  readonly description = 'Edit a file by replacing an exact string match. The old_string must appear exactly once in the file (unless replace_all is true). You must Read the file first.';
  readonly requiresApproval = true;
  readonly inputSchema = {
    type: 'object' as const,
    properties: {
      file_path: { type: 'string', description: 'The path to the file to edit' },
      old_string: { type: 'string', description: 'The exact string to find and replace. Must be unique unless replace_all is true.' },
      new_string: { type: 'string', description: 'The string to replace it with.' },
      replace_all: { type: 'boolean', description: 'Replace all occurrences instead of requiring uniqueness. Default false.' },
    },
    required: ['file_path', 'old_string', 'new_string'],
  };

  constructor(private shell: PersistentShell, private tracker?: FileTracker) { super(); }

  async execute(input: { file_path: string; old_string: string; new_string: string; replace_all?: boolean }, context: ToolContext): Promise<ToolResult> {
    const fp = input.file_path.startsWith('/') ? input.file_path : `${context.cwd}/${input.file_path}`;

    if (input.old_string === input.new_string) {
      return { output: 'old_string and new_string are identical. No changes made.', isError: true, durationMs: 0 };
    }

    // Freshness check: must Read before Edit
    if (this.tracker) {
      const stat = await this.shell.exec(`stat -c %Y ${JSON.stringify(fp)} 2>/dev/null || stat -f %m ${JSON.stringify(fp)} 2>/dev/null`);
      const currentMtime = stat.exitCode === 0 ? parseInt(stat.stdout.trim(), 10) : 0;
      const err = this.tracker.checkFreshness(fp, currentMtime);
      if (err) return { output: err, isError: true, durationMs: stat.durationMs };
    }

    // Read the file
    const readResult = await this.shell.exec(`cat ${JSON.stringify(fp)}`);
    if (readResult.exitCode !== 0) {
      return { output: `File not found: ${fp}`, isError: true, durationMs: readResult.durationMs };
    }

    const content = readResult.stdout;
    const occurrences = content.split(input.old_string).length - 1;

    if (occurrences === 0) {
      return { output: `old_string not found in ${fp}. Make sure it matches exactly (including whitespace and indentation).`, isError: true, durationMs: 0 };
    }

    if (!input.replace_all && occurrences > 1) {
      return { output: `old_string appears ${occurrences} times in ${fp}. It must be unique. Provide more context or use replace_all.`, isError: true, durationMs: 0 };
    }

    // Replace and write back via base64
    const newContent = input.replace_all
      ? content.split(input.old_string).join(input.new_string)
      : content.replace(input.old_string, input.new_string);

    const b64 = Buffer.from(newContent).toString('base64');
    const writeResult = await this.shell.exec(`echo ${JSON.stringify(b64)} | base64 -d > ${JSON.stringify(fp)}`);

    if (writeResult.exitCode !== 0) {
      return { output: `Error writing file: ${writeResult.stdout}`, isError: true, durationMs: writeResult.durationMs };
    }

    // Update tracked mtime after successful edit
    if (this.tracker) {
      const stat = await this.shell.exec(`stat -c %Y ${JSON.stringify(fp)} 2>/dev/null || stat -f %m ${JSON.stringify(fp)} 2>/dev/null`);
      if (stat.exitCode === 0) this.tracker.updateMtime(fp, parseInt(stat.stdout.trim(), 10));
    }

    const replacedCount = input.replace_all ? occurrences : 1;
    return {
      output: `Edited ${fp}: replaced ${replacedCount} occurrence(s) (${input.old_string.length} → ${input.new_string.length} chars)`,
      isError: false,
      durationMs: readResult.durationMs + writeResult.durationMs,
    };
  }
}
