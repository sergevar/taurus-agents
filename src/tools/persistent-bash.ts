import type { ToolResult, ToolContext } from '../core/types.js';
import { Tool } from './base.js';
import type { PersistentShell } from '../threads/persistent-shell.js';

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

  constructor(shell: PersistentShell) {
    super();
    this.shell = shell;
  }

  async execute(input: { command: string; timeout?: number }, _context: ToolContext): Promise<ToolResult> {
    try {
      const result = await this.shell.exec(input.command, {
        timeout: input.timeout,
      });

      const output = result.stdout || `(exit code ${result.exitCode})`;

      return {
        output,
        isError: result.exitCode !== 0,
        durationMs: result.durationMs,
      };
    } catch (err: any) {
      return {
        output: `Failed to execute: ${err.message}`,
        isError: true,
        durationMs: 0,
      };
    }
  }
}
