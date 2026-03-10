import type { ToolResult, ToolContext } from '../../core/types.js';
import { Tool } from '../base.js';
import type { PersistentShell } from '../../daemon/persistent-shell.js';

const DEBOUNCE_MS = 150;

export class PersistentBashTool extends Tool {
  readonly name = 'Bash';
  readonly description = 'Execute a bash command in a persistent shell. Working directory and environment persist between calls.';
  readonly requiresApproval = true;
  readonly inputSchema = {
    type: 'object' as const,
    properties: {
      command: {
        type: 'string',
        description: 'The bash command to execute',
      },
      timeout: {
        type: 'number',
        description: 'Timeout in milliseconds. Default is 120000 (2 minutes).',
      },
    },
    required: ['command'],
  };

  private shell: PersistentShell;
  private onOutput?: (chunk: string) => void;

  constructor(shell: PersistentShell, onOutput?: (chunk: string) => void) {
    super();
    this.shell = shell;
    this.onOutput = onOutput;
  }

  async execute(input: { command: string; timeout?: number }, _context: ToolContext): Promise<ToolResult> {
    // Set up debounced streaming if onOutput is provided
    let onData: ((line: string) => void) | undefined;
    let flush: (() => void) | undefined;

    if (this.onOutput) {
      let buffer = '';
      let timer: ReturnType<typeof setTimeout> | null = null;
      const emit = this.onOutput;

      flush = () => {
        if (timer) { clearTimeout(timer); timer = null; }
        if (buffer) { emit(buffer); buffer = ''; }
      };

      onData = (line: string) => {
        buffer += (buffer ? '\n' : '') + line;
        if (!timer) timer = setTimeout(flush!, DEBOUNCE_MS);
      };
    }

    try {
      const result = await this.shell.exec(input.command, {
        timeout: input.timeout,
        onData,
      });

      // Flush any remaining buffered output
      flush?.();

      let output = result.stdout || '';
      if (result.exitCode !== 0) {
        output = output
          ? `${output}\n\nExit code: ${result.exitCode}`
          : `Exit code: ${result.exitCode}`;
      }
      if (!output) output = '(no output)';

      return {
        output,
        isError: result.exitCode !== 0,
        durationMs: result.durationMs,
      };
    } catch (err: any) {
      flush?.();
      return {
        output: `Failed to execute: ${err.message}`,
        isError: true,
        durationMs: 0,
      };
    }
  }
}
