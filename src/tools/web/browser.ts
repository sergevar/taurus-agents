import type { ToolResult, ToolContext } from '../../core/types.js';
import { Tool } from '../base.js';
import type { PersistentShell } from '../../daemon/persistent-shell.js';

type Action = 'open' | 'snapshot' | 'click' | 'type' | 'select' | 'screenshot' | 'scroll' | 'hover' | 'back' | 'forward' | 'wait' | 'close';

const MAX_OUTPUT = 50_000;
const DEFAULT_TIMEOUT = 30_000;
const CLI_SCRIPT = '/usr/local/lib/browser-cli.mjs';

export class BrowserTool extends Tool {
  readonly name = 'Browser';
  readonly description =
    'Control a headless browser inside the container. One tool, multiple actions.\n\n' +
    'Actions:\n' +
    '- "open": Navigate to a URL. Params: `url` (required).\n' +
    '- "snapshot": Get an accessibility snapshot of the page with element roles and names. Use this to understand page structure.\n' +
    '- "click": Click an element. Params: `selector` (required) — CSS selector.\n' +
    '- "type": Type text into an input. Params: `selector` (required), `text` (required). Clears existing value first.\n' +
    '- "select": Select an option from a dropdown. Params: `selector` (required), `values` (required) — array of values.\n' +
    '- "hover": Hover over an element. Params: `selector` (required).\n' +
    '- "screenshot": Take a screenshot (metadata only, no image data returned).\n' +
    '- "scroll": Scroll the page. Params: `direction` ("up" or "down"), `amount` (pixels, default 300).\n' +
    '- "back"/"forward": Navigate browser history.\n' +
    '- "wait": Wait for a duration. Params: `ms` (default 1000).\n' +
    '- "close": Close the browser session.\n\n' +
    'Typical flow: open → snapshot → click/type → snapshot → ...\n' +
    'The browser persists between calls — no need to re-open for each action.';
  readonly requiresApproval = true;
  readonly inputSchema = {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['open', 'snapshot', 'click', 'type', 'select', 'screenshot', 'scroll', 'hover', 'back', 'forward', 'wait', 'close'],
        description: 'The browser action to perform.',
      },
      url: {
        type: 'string',
        description: 'URL to navigate to (for "open" action).',
      },
      selector: {
        type: 'string',
        description: 'CSS selector for the target element (for click/type/select/hover).',
      },
      text: {
        type: 'string',
        description: 'Text to type (for "type" action).',
      },
      values: {
        type: 'array',
        items: { type: 'string' },
        description: 'Values to select (for "select" action).',
      },
      direction: {
        type: 'string',
        enum: ['up', 'down'],
        description: 'Scroll direction (for "scroll" action).',
      },
      amount: {
        type: 'number',
        description: 'Scroll amount in pixels (for "scroll" action, default 300).',
      },
      ms: {
        type: 'number',
        description: 'Wait duration in milliseconds (for "wait" action, default 1000).',
      },
    },
    required: ['action'],
  };

  private shell: PersistentShell;

  constructor(shell: PersistentShell) {
    super();
    this.shell = shell;
  }

  async execute(input: {
    action: Action;
    url?: string;
    selector?: string;
    text?: string;
    values?: string[];
    direction?: 'up' | 'down';
    amount?: number;
    ms?: number;
  }, _context: ToolContext): Promise<ToolResult> {
    const start = Date.now();

    // Serialize the input as JSON and pass to the CLI script
    const jsonInput = JSON.stringify(input);
    const command = `node ${CLI_SCRIPT} ${shellEscape(jsonInput)}`;

    try {
      const result = await this.shell.exec(command, { timeout: DEFAULT_TIMEOUT });
      const output = result.stdout || `(exit code ${result.exitCode})`;
      return {
        output: truncate(output),
        isError: result.exitCode !== 0,
        durationMs: result.durationMs,
      };
    } catch (err: any) {
      return {
        output: `Browser error: ${err.message}`,
        isError: true,
        durationMs: Date.now() - start,
      };
    }
  }
}

function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT) return text;
  return text.slice(0, MAX_OUTPUT) + `\n\n[Truncated — showing ${MAX_OUTPUT} of ${text.length} characters]`;
}
