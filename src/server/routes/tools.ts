import { json, route, type Route } from '../helpers.js';
import { DEFAULT_MODEL, DEFAULT_DOCKER_IMAGE, DEFAULT_TOOLS, READ_ONLY_TOOLS, DEFAULT_MAX_TURNS, DEFAULT_TIMEOUT_MS } from '../../core/defaults.js';

const AVAILABLE_TOOLS = [
  { name: 'Read',      group: 'File',   description: 'Read files' },
  { name: 'Write',     group: 'File',   description: 'Write files' },
  { name: 'Edit',      group: 'File',   description: 'Edit files' },
  { name: 'Glob',      group: 'Search', description: 'Find files by pattern' },
  { name: 'Grep',      group: 'Search', description: 'Search file contents' },
  { name: 'Bash',      group: 'Exec',   description: 'Run shell commands' },
  { name: 'WebSearch', group: 'Web',    description: 'Search the web' },
  { name: 'WebFetch',  group: 'Web',    description: 'Fetch web pages' },
  { name: 'Browser',   group: 'Web',    description: 'Control a headless browser' },
];

export function toolRoutes(): Route[] {
  return [
    route('GET', '/api/tools', async (_req, res) => {
      json(res, {
        tools: AVAILABLE_TOOLS,
        defaults: {
          model: DEFAULT_MODEL,
          docker_image: DEFAULT_DOCKER_IMAGE,
          tools: DEFAULT_TOOLS,
          readonly_tools: READ_ONLY_TOOLS,
          max_turns: DEFAULT_MAX_TURNS,
          timeout_ms: DEFAULT_TIMEOUT_MS,
        },
      });
    }),
  ];
}
