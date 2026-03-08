import type { ToolResult, ToolContext } from '../../core/types.js';
import { Tool } from '../base.js';
import type { PersistentShell } from '../../daemon/persistent-shell.js';

export class ShellWriteTool extends Tool {
  readonly name = 'Write';
  readonly description = 'Write content to a file. Creates parent directories if needed. Overwrites existing files.';
  readonly requiresApproval = true;
  readonly inputSchema = {
    type: 'object' as const,
    properties: {
      file_path: { type: 'string', description: 'The path to the file to write' },
      content: { type: 'string', description: 'The content to write' },
    },
    required: ['file_path', 'content'],
  };

  constructor(private shell: PersistentShell) { super(); }

  async execute(input: { file_path: string; content: string }, context: ToolContext): Promise<ToolResult> {
    const fp = input.file_path.startsWith('/') ? input.file_path : `${context.cwd}/${input.file_path}`;

    // Ensure parent directory exists, then write via base64 to avoid escaping issues
    const b64 = Buffer.from(input.content).toString('base64');
    const cmd = `mkdir -p $(dirname ${JSON.stringify(fp)}) && echo ${JSON.stringify(b64)} | base64 -d > ${JSON.stringify(fp)}`;
    const result = await this.shell.exec(cmd);

    if (result.exitCode !== 0) {
      return { output: `Error writing file: ${result.stdout}`, isError: true, durationMs: result.durationMs };
    }
    return { output: `File written: ${fp} (${input.content.length} bytes)`, isError: false, durationMs: result.durationMs };
  }
}
