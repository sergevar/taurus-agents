import type { ToolResult, ToolContext } from '../../core/types.js';
import { Tool } from '../base.js';
import type { SearchProvider } from './search-provider.js';

export class WebSearchTool extends Tool {
  readonly name = 'WebSearch';
  readonly description =
    'Search the web for current information. Returns a list of results with titles, URLs, and snippets. ' +
    'Use this when you need up-to-date information, documentation, or answers from the internet.';
  readonly requiresApproval = false;
  readonly inputSchema = {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string',
        description: 'The search query.',
      },
      count: {
        type: 'number',
        description: 'Number of results to return (1–10, default 5).',
      },
    },
    required: ['query'],
  };

  constructor(private provider: SearchProvider) {
    super();
  }

  async execute(input: { query: string; count?: number }, _context: ToolContext): Promise<ToolResult> {
    const start = Date.now();
    const count = Math.min(Math.max(input.count ?? 5, 1), 10);

    try {
      const results = await this.provider.search(input.query, { count });

      if (results.length === 0) {
        return {
          output: `No results found for "${input.query}".`,
          isError: false,
          durationMs: Date.now() - start,
        };
      }

      const formatted = results
        .map((r, i) => [
          `[${i + 1}] ${r.title}`,
          `    URL: ${r.url}`,
          `    ${r.snippet}`,
        ].join('\n'))
        .join('\n\n');

      return {
        output: `Search results for "${input.query}" (${results.length} results, via ${this.provider.name}):\n\n${formatted}`,
        isError: false,
        durationMs: Date.now() - start,
      };
    } catch (err: any) {
      return {
        output: `Search error: ${err.message || String(err)}`,
        isError: true,
        durationMs: Date.now() - start,
      };
    }
  }
}
