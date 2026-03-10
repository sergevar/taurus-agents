import type { ToolResult, ToolContext, ImageData } from '../../core/types.js';
import { Tool } from '../base.js';
import type { PersistentShell } from '../../daemon/persistent-shell.js';
import type { FileTracker } from './file-tracker.js';

const MAX_LINE_LENGTH = 2000;

const IMAGE_MIMES: Record<string, ImageData['mediaType']> = {
  'image/png': 'image/png',
  'image/jpeg': 'image/jpeg',
  'image/gif': 'image/gif',
  'image/webp': 'image/webp',
};

export class ShellReadTool extends Tool {
  readonly name = 'Read';
  readonly description = 'Read a file from the filesystem. Returns contents with line numbers. Can read images (png, jpg, gif, webp). Rejects binary files.';
  readonly inputSchema = {
    type: 'object' as const,
    properties: {
      file_path: { type: 'string', description: 'The path to the file to read' },
      offset: { type: 'number', description: 'Line number to start reading from (1-based)' },
      limit: { type: 'number', description: 'Maximum number of lines to read. Default 2000.' },
    },
    required: ['file_path'],
  };

  constructor(private shell: PersistentShell, private tracker?: FileTracker) { super(); }

  async execute(input: { file_path: string; offset?: number; limit?: number }, context: ToolContext): Promise<ToolResult> {
    const fp = input.file_path.startsWith('/') ? input.file_path : `${context.cwd}/${input.file_path}`;
    const offset = Math.max(1, input.offset ?? 1);
    const limit = input.limit ?? 2000;
    const end = offset + limit - 1;

    // Detect file type via MIME
    const probe = await this.shell.exec(`file --mime-type -b ${JSON.stringify(fp)} 2>/dev/null`);
    const mime = probe.stdout.trim();

    if (probe.exitCode !== 0 || !mime) {
      return { output: `Error reading file: ${fp}`, isError: true, durationMs: probe.durationMs };
    }

    // Image — return as multimodal content
    const imageMediaType = IMAGE_MIMES[mime];
    if (imageMediaType) {
      const b64Result = await this.shell.exec(`base64 ${JSON.stringify(fp)}`);
      if (b64Result.exitCode !== 0) {
        return { output: `Error reading image: ${fp}`, isError: true, durationMs: b64Result.durationMs };
      }
      const base64 = b64Result.stdout.replace(/\s/g, '');
      return {
        output: `Image: ${fp} (${mime})`,
        isError: false,
        durationMs: probe.durationMs + b64Result.durationMs,
        images: [{ base64, mediaType: imageMediaType }],
      };
    }

    // Other binary — reject
    if (!mime.startsWith('text/') && mime !== 'application/json' && mime !== 'application/xml' && mime !== 'application/javascript') {
      return { output: `Cannot read binary file: ${fp} (${mime})`, isError: true, durationMs: probe.durationMs };
    }

    // Text file — normal read with line numbers
    const cmd = `wc -l < ${JSON.stringify(fp)} 2>/dev/null; sed -n '${offset},${end}p' ${JSON.stringify(fp)} 2>&1`;
    const result = await this.shell.exec(cmd);

    if (result.exitCode !== 0) {
      return { output: result.stdout || `Error reading file: ${fp}`, isError: true, durationMs: result.durationMs };
    }

    const lines = result.stdout.split('\n');
    const totalLines = parseInt(lines[0].trim(), 10) || 0;
    const contentLines = lines.slice(1);

    // Add line numbers, truncate long lines
    const maxNum = offset + contentLines.length - 1;
    const padWidth = String(maxNum).length;
    const numbered = contentLines.map((line, i) => {
      const lineNum = String(offset + i).padStart(padWidth, ' ');
      const truncated = line.length > MAX_LINE_LENGTH
        ? line.slice(0, MAX_LINE_LENGTH) + `... [truncated, ${line.length} chars total]`
        : line;
      return `${lineNum}\t${truncated}`;
    }).join('\n');

    const header = `File: ${fp} (${totalLines} lines)`;
    const showing = contentLines.length < totalLines
      ? `\n[Showing lines ${offset}-${offset + contentLines.length - 1} of ${totalLines}]`
      : '';

    // Track mtime for freshness enforcement
    if (this.tracker) {
      const stat = await this.shell.exec(`stat -c %Y ${JSON.stringify(fp)} 2>/dev/null || stat -f %m ${JSON.stringify(fp)} 2>/dev/null`);
      if (stat.exitCode === 0) {
        this.tracker.markRead(fp, parseInt(stat.stdout.trim(), 10));
      }
    }

    return { output: `${header}${showing}\n${numbered}`, isError: false, durationMs: result.durationMs };
  }
}
