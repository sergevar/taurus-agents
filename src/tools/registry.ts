import type { ToolDef, ToolResult, ToolContext } from '../core/types.js';
import type { Tool } from './base.js';

/**
 * ToolRegistry — shared across all agents.
 * Each agent can request a subset of tools by name.
 */
export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  getAll(): Tool[] {
    return [...this.tools.values()];
  }

  /**
   * Get tool definitions for the LLM API.
   * Optionally filter to a subset of tool names.
   */
  getToolDefinitions(filter?: string[]): ToolDef[] {
    const tools = filter
      ? filter.map(name => this.tools.get(name)).filter((t): t is Tool => !!t)
      : this.getAll();

    return tools.map(t => {
      const schema = t.inputSchema as Record<string, any>;
      return {
        name: t.name,
        description: t.description,
        input_schema: {
          ...schema,
          properties: {
            description: {
              type: 'string',
              description: 'Brief reason for this tool call (shown to the user)',
            },
            ...schema.properties,
          },
        },
      };
    });
  }

  /**
   * Execute a tool by name with timing.
   */
  async execute(name: string, input: any, context: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        output: `Unknown tool: ${name}`,
        isError: true,
        durationMs: 0,
      };
    }

    const start = Date.now();
    try {
      const result = await tool.execute(input, context);
      return {
        ...result,
        durationMs: Date.now() - start,
      };
    } catch (err: any) {
      return {
        output: `Tool error: ${err.message || String(err)}`,
        isError: true,
        durationMs: Date.now() - start,
      };
    }
  }
}
