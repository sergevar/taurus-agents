/**
 * SearchProvider interface — abstraction over web search backends.
 * Swap implementations (Brave, Tavily, Google, etc.) without changing the tool.
 */

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchProvider {
  readonly name: string;
  search(query: string, opts?: { count?: number }): Promise<SearchResult[]>;
}
