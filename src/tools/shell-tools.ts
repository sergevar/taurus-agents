/**
 * Shell-based tool implementations for Docker mode.
 *
 * Instead of using Node.js fs/spawn (which operate on the host),
 * these tools execute commands through PersistentShell, which in Docker mode
 * routes everything through `docker exec -i <container>`.
 *
 * This ensures ALL tool operations happen inside the container.
 */

import type { ToolResult, ToolContext } from '../core/types.js';
import { Tool } from './base.js';
import type { PersistentShell } from '../threads/persistent-shell.js';

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

    // Use sed for offset/limit, cat -n for line numbers
    const cmd = `sed -n '${offset},${end}p' ${JSON.stringify(fp)} | cat -n | sed 's/^ *//' | awk '{printf "%6d\\t%s\\n", NR + ${offset - 1}, substr($0, index($0,$2))}'`;
    // Simpler approach: just use sed + nl
    const simpleCmd = `sed -n '${offset},${end}p' ${JSON.stringify(fp)} 2>&1`;

    const result = await this.shell.exec(simpleCmd);
    if (result.exitCode !== 0) {
      return { output: result.stdout || `Error reading file: ${fp}`, isError: true, durationMs: result.durationMs };
    }

    // Add line numbers
    const lines = result.stdout.split('\n');
    const numbered = lines.map((line, i) => {
      const lineNum = String(offset + i).padStart(6, ' ');
      return `${lineNum}\t${line}`;
    }).join('\n');

    // Get total line count
    const wcResult = await this.shell.exec(`wc -l < ${JSON.stringify(fp)} 2>/dev/null`);
    const totalLines = parseInt(wcResult.stdout.trim(), 10) || lines.length;

    const header = `File: ${fp} (${totalLines} lines)`;
    const truncated = lines.length < totalLines
      ? `\n[Showing lines ${offset}-${offset + lines.length - 1} of ${totalLines}]`
      : '';

    return { output: `${header}${truncated}\n${numbered}`, isError: false, durationMs: result.durationMs };
  }
}

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

    // Ensure parent directory exists
    const dirCmd = `mkdir -p $(dirname ${JSON.stringify(fp)})`;
    await this.shell.exec(dirCmd);

    // Write via base64 to avoid heredoc escaping issues
    const b64 = Buffer.from(input.content).toString('base64');
    const writeCmd = `echo ${JSON.stringify(b64)} | base64 -d > ${JSON.stringify(fp)}`;
    const result = await this.shell.exec(writeCmd);

    if (result.exitCode !== 0) {
      return { output: `Error writing file: ${result.stdout}`, isError: true, durationMs: result.durationMs };
    }
    return { output: `File written: ${fp} (${input.content.length} bytes)`, isError: false, durationMs: result.durationMs };
  }
}

export class ShellEditTool extends Tool {
  readonly name = 'Edit';
  readonly description = 'Edit a file by replacing an exact string match. The old_string must appear exactly once in the file.';
  readonly requiresApproval = true;
  readonly inputSchema = {
    type: 'object' as const,
    properties: {
      file_path: { type: 'string', description: 'The path to the file to edit' },
      old_string: { type: 'string', description: 'The exact string to find and replace. Must be unique.' },
      new_string: { type: 'string', description: 'The string to replace it with.' },
    },
    required: ['file_path', 'old_string', 'new_string'],
  };

  constructor(private shell: PersistentShell) { super(); }

  async execute(input: { file_path: string; old_string: string; new_string: string }, context: ToolContext): Promise<ToolResult> {
    const fp = input.file_path.startsWith('/') ? input.file_path : `${context.cwd}/${input.file_path}`;

    if (input.old_string === input.new_string) {
      return { output: 'old_string and new_string are identical. No changes made.', isError: true, durationMs: 0 };
    }

    // Read the file content
    const readResult = await this.shell.exec(`cat ${JSON.stringify(fp)}`);
    if (readResult.exitCode !== 0) {
      return { output: `File not found: ${fp}`, isError: true, durationMs: readResult.durationMs };
    }

    const content = readResult.stdout;
    const occurrences = content.split(input.old_string).length - 1;

    if (occurrences === 0) {
      return { output: `old_string not found in ${fp}. Make sure it matches exactly.`, isError: true, durationMs: 0 };
    }
    if (occurrences > 1) {
      return { output: `old_string appears ${occurrences} times in ${fp}. It must be unique.`, isError: true, durationMs: 0 };
    }

    const newContent = content.replace(input.old_string, input.new_string);
    const b64 = Buffer.from(newContent).toString('base64');
    const writeResult = await this.shell.exec(`echo ${JSON.stringify(b64)} | base64 -d > ${JSON.stringify(fp)}`);

    if (writeResult.exitCode !== 0) {
      return { output: `Error writing file: ${writeResult.stdout}`, isError: true, durationMs: writeResult.durationMs };
    }

    return {
      output: `Edited ${fp}: replaced ${input.old_string.length} chars with ${input.new_string.length} chars`,
      isError: false,
      durationMs: readResult.durationMs + writeResult.durationMs,
    };
  }
}

export class ShellGlobTool extends Tool {
  readonly name = 'Glob';
  readonly description = 'Find files matching a glob pattern. Returns matching file paths sorted by name.';
  readonly inputSchema = {
    type: 'object' as const,
    properties: {
      pattern: { type: 'string', description: 'The glob pattern to match files against' },
      path: { type: 'string', description: 'The directory to search in. Defaults to cwd.' },
    },
    required: ['pattern'],
  };

  constructor(private shell: PersistentShell) { super(); }

  async execute(input: { pattern: string; path?: string }, context: ToolContext): Promise<ToolResult> {
    const searchDir = input.path
      ? (input.path.startsWith('/') ? input.path : `${context.cwd}/${input.path}`)
      : context.cwd;

    // Use find with -name for simple patterns, or bash globbing
    // For robustness, use find with appropriate flags
    const cmd = `find ${JSON.stringify(searchDir)} -type f -name ${JSON.stringify(input.pattern)} -not -path '*/node_modules/*' -not -path '*/.git/*' 2>/dev/null | sort | head -500`;
    const result = await this.shell.exec(cmd);

    const files = result.stdout.trim().split('\n').filter(Boolean);
    if (files.length === 0) {
      return { output: `No files matched pattern: ${input.pattern}`, isError: false, durationMs: result.durationMs };
    }

    return {
      output: `${files.length} files found:\n${files.join('\n')}`,
      isError: false,
      durationMs: result.durationMs,
    };
  }
}

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
    },
    required: ['pattern'],
  };

  constructor(private shell: PersistentShell) { super(); }

  async execute(
    input: { pattern: string; path?: string; glob?: string; case_insensitive?: boolean },
    context: ToolContext,
  ): Promise<ToolResult> {
    const searchPath = input.path
      ? (input.path.startsWith('/') ? input.path : `${context.cwd}/${input.path}`)
      : context.cwd;

    // Use grep -rn (available in most containers)
    const flags = ['-rn', '--color=never'];
    if (input.case_insensitive) flags.push('-i');
    if (input.glob) flags.push(`--include=${JSON.stringify(input.glob)}`);
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
