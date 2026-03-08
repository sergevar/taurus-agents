import type { SearchProvider, SearchResult } from './search-provider.js';

const BRAVE_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search';

export class BraveSearchProvider implements SearchProvider {
  readonly name = 'brave';

  constructor(private apiKey: string) {}

  async search(query: string, opts?: { count?: number }): Promise<SearchResult[]> {
    const count = Math.min(Math.max(opts?.count ?? 5, 1), 20);
    const params = new URLSearchParams({ q: query, count: String(count) });

    const response = await fetch(`${BRAVE_SEARCH_URL}?${params}`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': this.apiKey,
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Brave Search API error: HTTP ${response.status} ${response.statusText}${text ? ` — ${text}` : ''}`);
    }

    const data = await response.json() as BraveSearchResponse;

    return (data.web?.results ?? []).map(r => ({
      title: r.title,
      url: r.url,
      snippet: r.description,
    }));
  }
}

// Minimal type definitions for the Brave Search API response
interface BraveSearchResponse {
  web?: {
    results: Array<{
      title: string;
      url: string;
      description: string;
    }>;
  };
}
