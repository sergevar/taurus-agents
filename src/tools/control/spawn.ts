import type { ToolResult, ToolContext } from '../../core/types.js';
import { Tool } from '../base.js';

export interface SpawnRequest {
  requestId: string;
  input: string;
  system_prompt?: string;
  tools?: string[];
  max_turns?: number;
  timeout_ms?: number;
}

export interface SpawnResult {
  summary: string;
  error?: string;
}

/**
 * SpawnTool — spawns a sub-task that runs in a child worker.
 *
 * The child shares the same agent (Docker container, model) but gets its own
 * run, conversation, and TAOR loop. The parent blocks until the child completes.
 *
 * The sendRequest/waitForResult callbacks are injected by the worker.
 */
export class SpawnTool extends Tool {
  readonly name = 'Spawn';
  readonly description = 'Spawn a sub-agent to handle a task. The sub-agent runs in the same container with its own conversation and returns the result when done. Use this to delegate self-contained subtasks.';
  readonly requiresApproval = false;
  readonly inputSchema = {
    type: 'object' as const,
    properties: {
      task: {
        type: 'string',
        description: 'The task description for the sub-agent.',
      },
      system_prompt: {
        type: 'string',
        description: 'Optional system prompt override. Defaults to the parent agent\'s system prompt.',
      },
      tools: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional tool subset for the sub-agent. Must be a subset of your available tools — any tools not in your set are ignored. Defaults to all your available tools.',
      },
      max_turns: {
        type: 'number',
        description: 'Max inference turns for the sub-agent. Default: 50.',
      },
    },
    required: ['task'],
  };

  private sendRequest: (request: SpawnRequest) => void;
  private waitForResult: (requestId: string) => Promise<SpawnResult>;

  constructor(
    sendRequest: (request: SpawnRequest) => void,
    waitForResult: (requestId: string) => Promise<SpawnResult>,
  ) {
    super();
    this.sendRequest = sendRequest;
    this.waitForResult = waitForResult;
  }

  async execute(input: { task: string; system_prompt?: string; tools?: string[]; max_turns?: number }, _context: ToolContext): Promise<ToolResult> {
    const requestId = crypto.randomUUID();

    this.sendRequest({
      requestId,
      input: input.task,
      system_prompt: input.system_prompt,
      tools: input.tools,
      max_turns: input.max_turns,
    });

    const result = await this.waitForResult(requestId);

    if (result.error) {
      return {
        output: `Sub-agent error: ${result.error}${result.summary ? `\n\nPartial output: ${result.summary}` : ''}`,
        isError: true,
        durationMs: 0,
      };
    }

    return {
      output: result.summary,
      isError: false,
      durationMs: 0,
    };
  }
}
