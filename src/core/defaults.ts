/** Central place for all default values used across the codebase. */

export const DEFAULT_MODEL = 'claude-sonnet-4-20250514';
export const DEFAULT_DOCKER_IMAGE = 'taurus-base';
export const DEFAULT_TOOLS = ['Read', 'Glob', 'Grep'];
export const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];
export const DEFAULT_MAX_TURNS = 0;       // 0 = unlimited
export const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes

export const DEFAULT_FETCH_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-User': '?1',
  'Sec-Fetch-Dest': 'document',
};
