import { InferenceProvider } from './base.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';

/**
 * Resolve a provider from a model string.
 *
 * Model format: [backend/]model-id
 *   - "claude-sonnet-4-20250514"           → anthropic (default)
 *   - "anthropic/claude-sonnet-4-20250514" → anthropic
 *   - "openai/gpt-4o"                     → openai direct
 *   - "openrouter/deepseek/deepseek-r1"   → openrouter (openai-compatible)
 *   - "openrouter/anthropic/claude-..."    → openrouter
 *
 * Returns { provider, model } where model is the string to send to the API
 * (with the backend prefix stripped).
 */
export function resolveProvider(model: string): { provider: InferenceProvider; model: string } {
  const firstSlash = model.indexOf('/');
  const backend = firstSlash === -1 ? null : model.slice(0, firstSlash);

  switch (backend) {
    case 'openai': {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) throw new Error('OPENAI_API_KEY is required for openai/ models');
      return {
        provider: new OpenAIProvider({ apiKey, name: 'openai', defaultModel: 'gpt-4o' }),
        model: model.slice(firstSlash + 1),
      };
    }

    case 'openrouter': {
      const apiKey = process.env.OPENROUTER_API_KEY;
      if (!apiKey) throw new Error('OPENROUTER_API_KEY is required for openrouter/ models');
      return {
        provider: new OpenAIProvider({
          apiKey,
          baseURL: 'https://openrouter.ai/api/v1',
          name: 'openrouter',
          defaultHeaders: {
            'HTTP-Referer': 'https://github.com/taurus-agents',
            'X-OpenRouter-Title': 'Taurus Agents',
          },
        }),
        // "openrouter/deepseek/deepseek-r1" → "deepseek/deepseek-r1"
        model: model.slice(firstSlash + 1),
      };
    }

    case 'anthropic': {
      return {
        provider: new AnthropicProvider(),
        model: model.slice(firstSlash + 1),
      };
    }

    default: {
      // No prefix — default to anthropic
      return {
        provider: new AnthropicProvider(),
        model,
      };
    }
  }
}
