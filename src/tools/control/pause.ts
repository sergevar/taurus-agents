import type { ToolResult, ToolContext } from '../../core/types.js';
import { Tool } from '../base.js';

/**
 * PauseTool — allows an agent to pause itself and wait for human input.
 *
 * When an agent calls this tool, the worker sends a 'paused' message to the
 * Daemon via IPC and blocks until a 'resume' message arrives. The Daemon
 * updates the agent status and the web UI shows a resume button.
 *
 * The sendPause/waitForResume callbacks are injected by the agent worker.
 */
export class PauseTool extends Tool {
  readonly name = 'Pause';
  readonly description = 'Pause this agent and wait for human input. Use ONLY when you need a decision, approval, or additional information from a human before continuing. This will HALT execution until a human responds — do NOT use it for planning, thinking, or organizing your work.';
  readonly requiresApproval = false; // The tool IS the approval mechanism
  readonly inputSchema = {
    type: 'object' as const,
    properties: {
      reason: {
        type: 'string',
        description: 'Why are you pausing? This is shown to the human in the dashboard.',
      },
    },
    required: ['reason'],
  };

  private sendPause: (reason: string) => void;
  private waitForResume: () => Promise<string | undefined>;

  constructor(
    sendPause: (reason: string) => void,
    waitForResume: () => Promise<string | undefined>,
  ) {
    super();
    this.sendPause = sendPause;
    this.waitForResume = waitForResume;
  }

  async execute(input: { reason: string }, _context: ToolContext): Promise<ToolResult> {
    this.sendPause(input.reason);

    const resumeMessage = await this.waitForResume();

    const output = resumeMessage
      ? `Resumed. Human message: ${resumeMessage}`
      : 'Resumed. No additional message provided.';

    return {
      output,
      isError: false,
      durationMs: 0,
    };
  }
}
