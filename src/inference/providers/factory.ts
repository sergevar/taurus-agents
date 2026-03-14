import type { InferenceProvider } from './base.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';
import { OpenAICompatProvider } from './openai-compat.js';

/**
 * Resolve a provider from a model string.
 *
 * Model format: provider/model-id (provider prefix is REQUIRED)
 *   - "anthropic/claude-sonnet-4-20250514" → AnthropicProvider
 *   - "openai/gpt-4o"                     → OpenAIProvider (Responses API)
 *   - "openrouter/deepseek/deepseek-r1"   → OpenAICompatProvider (Chat Completions)
 *   - "custom/model-name"                 → OpenAICompatProvider (custom endpoint)
 *
 * The full prefixed model string is passed through to the provider in each
 * InferenceRequest — providers strip the prefix before calling their API.
 */
export function resolveProvider(model: string): InferenceProvider {
  const firstSlash = model.indexOf('/');
  if (firstSlash === -1) {
    throw new Error(
      `Model "${model}" is missing a provider prefix. Use "anthropic/${model}", "openai/${model}", etc.`,
    );
  }

  const backend = model.slice(0, firstSlash);

  switch (backend) {
    case 'openai': {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) throw new Error('OPENAI_API_KEY is required for openai/ models');
      return new OpenAIProvider({ apiKey });
    }

    case 'openrouter': {
      const apiKey = process.env.OPENROUTER_API_KEY;
      if (!apiKey) throw new Error('OPENROUTER_API_KEY is required for openrouter/ models');
      return new OpenAICompatProvider({
        apiKey,
        baseURL: 'https://openrouter.ai/api/v1',
        name: 'openrouter',
        defaultHeaders: {
          'HTTP-Referer': 'https://github.com/taurus-agents',
          'X-OpenRouter-Title': 'Taurus Agents',
        },
      });
    }

    case 'anthropic':
      return new AnthropicProvider();

    case 'groq': {
      const apiKey = process.env.GROQ_API_KEY;
      if (!apiKey) throw new Error('GROQ_API_KEY is required for groq/ models');
      return new OpenAICompatProvider({
        apiKey,
        baseURL: 'https://api.groq.com/openai/v1',
        name: 'groq',
      });
    }

    case 'custom': {
      const apiKey = process.env.CUSTOM_PROVIDER_API_KEY;
      const baseURL = process.env.CUSTOM_PROVIDER_BASE_URL;
      if (!apiKey) throw new Error('CUSTOM_PROVIDER_API_KEY is required for custom/ models');
      if (!baseURL) throw new Error('CUSTOM_PROVIDER_BASE_URL is required for custom/ models');
      return new OpenAICompatProvider({
        apiKey,
        baseURL,
        name: 'custom',
      });
    }

    default:
      throw new Error(
        `Unknown provider "${backend}" in model "${model}". Supported: anthropic, openai, openrouter, groq, custom.`,
      );
  }
}
