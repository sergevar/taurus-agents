import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
import type { ToolResult, ToolContext } from '../../core/types.js';
import { Tool } from '../base.js';
import { isUrlSafe } from './url-safety.js';

const MAX_RESPONSE_BYTES = 1_000_000;  // 1 MB
const MAX_OUTPUT_CHARS = 50_000;
const FETCH_TIMEOUT_MS = 15_000;
const USER_AGENT = 'Taurus-Agents/0.1 (WebFetch)';

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
});

export class WebFetchTool extends Tool {
  readonly name = 'WebFetch';
  readonly description =
    'Fetch a web page and return its content as clean markdown. ' +
    'Use this to read documentation, articles, blog posts, or any web page. ' +
    'Only http/https URLs are allowed. Returns extracted readable content.';
  readonly requiresApproval = false;
  readonly inputSchema = {
    type: 'object' as const,
    properties: {
      url: {
        type: 'string',
        description: 'The URL to fetch (http or https only).',
      },
    },
    required: ['url'],
  };

  async execute(input: { url: string }, _context: ToolContext): Promise<ToolResult> {
    const start = Date.now();

    // Validate URL safety
    const check = isUrlSafe(input.url);
    if (!check.safe) {
      return { output: `Error: ${check.reason}`, isError: true, durationMs: Date.now() - start };
    }

    try {
      const response = await fetch(input.url, {
        method: 'GET',
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'text/html, application/json, text/plain, */*',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        return {
          output: `Error: HTTP ${response.status} ${response.statusText}`,
          isError: true,
          durationMs: Date.now() - start,
        };
      }

      const contentType = response.headers.get('content-type') || '';
      const contentLength = parseInt(response.headers.get('content-length') || '0', 10);

      if (contentLength > MAX_RESPONSE_BYTES) {
        return {
          output: `Error: Response too large (${contentLength} bytes, max ${MAX_RESPONSE_BYTES})`,
          isError: true,
          durationMs: Date.now() - start,
        };
      }

      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > MAX_RESPONSE_BYTES) {
        return {
          output: `Error: Response too large (${buffer.byteLength} bytes, max ${MAX_RESPONSE_BYTES})`,
          isError: true,
          durationMs: Date.now() - start,
        };
      }

      const body = new TextDecoder().decode(buffer);

      // JSON — pretty-print
      if (contentType.includes('application/json')) {
        try {
          const json = JSON.parse(body);
          const pretty = JSON.stringify(json, null, 2);
          return {
            output: truncate(`URL: ${input.url}\nContent-Type: ${contentType}\n\n${pretty}`),
            isError: false,
            durationMs: Date.now() - start,
          };
        } catch {
          // Fall through to raw text
        }
      }

      // Plain text — return raw
      if (contentType.includes('text/plain')) {
        return {
          output: truncate(`URL: ${input.url}\nContent-Type: ${contentType}\n\n${body}`),
          isError: false,
          durationMs: Date.now() - start,
        };
      }

      // HTML — extract with Readability, convert to markdown
      const { document } = parseHTML(body);
      const reader = new Readability(document);
      const article = reader.parse();

      if (article && article.content) {
        const markdown = turndown.turndown(article.content);
        const output = [
          `Title: ${article.title || '(untitled)'}`,
          `URL: ${input.url}`,
          '',
          markdown,
        ].join('\n');
        return { output: truncate(output), isError: false, durationMs: Date.now() - start };
      }

      // Readability failed to extract — fall back to raw body text
      const { document: fallbackDoc } = parseHTML(body);
      const textContent = fallbackDoc.body?.textContent?.trim() || body;
      const output = `URL: ${input.url}\n\n${textContent}`;
      return { output: truncate(output), isError: false, durationMs: Date.now() - start };

    } catch (err: any) {
      const message = err.name === 'TimeoutError'
        ? `Fetch timed out after ${FETCH_TIMEOUT_MS / 1000}s`
        : err.message || String(err);
      return { output: `Error: ${message}`, isError: true, durationMs: Date.now() - start };
    }
  }
}

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return text.slice(0, MAX_OUTPUT_CHARS) + `\n\n[Truncated — showing ${MAX_OUTPUT_CHARS} of ${text.length} characters]`;
}
