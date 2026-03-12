/**
 * Model registry — single source of truth for model metadata + pricing.
 *
 * Used by:
 *  - UI model picker (GET /api/models)
 *  - Cost computation (on the fly from persisted token counts)
 *  - Context window budget checks
 *
 * Prices are per million tokens (MTok), USD.
 *
 * Provider pricing docs:
 *  - Anthropic: https://docs.anthropic.com/en/docs/about-claude/pricing
 *  - OpenAI:    https://openai.com/api/pricing
 *  - OpenRouter: cost reported inline in usage.cost (no pricing table needed)
 *
 * Caching behavior by provider:
 *  - Anthropic: opt-in via cache_control: { type: 'ephemeral' }. Write = 1.25x, Read = 0.1x.
 *    Min tokens: 4096 (Opus 4.6/4.5, Haiku 4.5), 2048 (Sonnet 4.6, Haiku 3.5), 1024 (others).
 *    TTL: 5 min default, 1 hour optional at 2x write cost.
 *  - OpenAI: automatic, no opt-in. Write = free, Read = 0.5x (some newer = 0.25x). Min 1024 tok.
 *  - OpenRouter: pass-through from underlying provider + sticky routing for cache warmth.
 *    Reports usage.cost inline — authoritative, used instead of our pricing tables.
 *
 * Token reporting normalization (see TokenUsage in types.ts):
 *  All providers normalize to: inputTokens = TOTAL (cached + uncached + cache writes).
 *  Cost = (total - cacheRead - cacheWrite) * inputPrice + cacheRead * readPrice + cacheWrite * writePrice + output * outputPrice.
 */

export type ModelPricing = {
  input: number;       // $ per MTok
  output: number;      // $ per MTok
  cacheWrite: number;  // $ per MTok
  cacheRead: number;   // $ per MTok
};

export type ModelDef = {
  id: string;
  title: string;
  provider: 'anthropic' | 'openai' | 'openrouter';
  description: string;
  contextTokens: number;
  maxOutputTokens: number;
  pricing?: ModelPricing;
};

// ── Pricing tiers ($ per MTok) ──
//
// cacheWrite: cost of tokens written to cache.
//   Anthropic: 1.25x input (5-min TTL) — there's a 2x option for 1-hour TTL but we don't use it.
//   OpenAI:    same as input (no surcharge, cacheWrite tokens = 0 in practice).
//
// cacheRead: cost of tokens served from cache.
//   Anthropic: ~10% of input (90% savings).
//   OpenAI:    varies — gpt-4o 50%, o-series 25%, gpt-5 series 10%.
//
// OpenRouter models don't need pricing — they report nativeCost inline.

const OPUS_46: ModelPricing = { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.50 };
const OPUS_4: ModelPricing = { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.50 };
const SONNET: ModelPricing = { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.30 };
const HAIKU_45: ModelPricing = { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.10 };
const HAIKU_35: ModelPricing = { input: 0.80, output: 4, cacheWrite: 1, cacheRead: 0.08 };
const GPT4O: ModelPricing = { input: 2.50, output: 10, cacheWrite: 2.50, cacheRead: 1.25 };
const GPT4O_MINI: ModelPricing = { input: 0.15, output: 0.60, cacheWrite: 0.15, cacheRead: 0.075 };
const O3: ModelPricing = { input: 2, output: 8, cacheWrite: 2, cacheRead: 0.50 };
const O4_MINI: ModelPricing = { input: 1.10, output: 4.40, cacheWrite: 1.10, cacheRead: 0.275 };
const GPT5: ModelPricing = { input: 1.25, output: 10, cacheWrite: 1.25, cacheRead: 0.125 };
const GPT5_MINI: ModelPricing = { input: 0.25, output: 2, cacheWrite: 0.25, cacheRead: 0.025 };
const GPT5_NANO: ModelPricing = { input: 0.05, output: 0.40, cacheWrite: 0.05, cacheRead: 0.005 };
const GPT5_1: ModelPricing = { input: 1.25, output: 10, cacheWrite: 1.25, cacheRead: 0.125 };
const GPT5_2: ModelPricing = { input: 1.75, output: 14, cacheWrite: 1.75, cacheRead: 0.175 };
const GPT5_4: ModelPricing = { input: 2.50, output: 15, cacheWrite: 2.50, cacheRead: 0.25 };

// ── Registry ──

export const MODEL_REGISTRY: ModelDef[] = [
  // ── Anthropic ──
  {
    id: 'claude-opus-4-6', title: 'Claude Opus 4.6', provider: 'anthropic',
    description: 'Most capable. Superior reasoning, coding, agentic performance.',
    contextTokens: 200_000, maxOutputTokens: 128_000, pricing: OPUS_46,
  },
  {
    id: 'claude-opus-4-5-20251101', title: 'Claude Opus 4.5', provider: 'anthropic',
    description: 'Premium intelligence with practical performance.',
    contextTokens: 200_000, maxOutputTokens: 64_000, pricing: OPUS_46,
  },
  {
    id: 'claude-sonnet-4-6', title: 'Claude Sonnet 4.6', provider: 'anthropic',
    description: 'Best balance of intelligence, speed, and cost.',
    contextTokens: 200_000, maxOutputTokens: 64_000, pricing: SONNET,
  },
  {
    id: 'claude-sonnet-4-5-20250929', title: 'Claude Sonnet 4.5', provider: 'anthropic',
    description: 'High intelligence at balanced speed and cost.',
    contextTokens: 200_000, maxOutputTokens: 64_000, pricing: SONNET,
  },
  {
    id: 'claude-sonnet-4-20250514', title: 'Claude Sonnet 4', provider: 'anthropic',
    description: 'High-performance reasoning and efficiency.',
    contextTokens: 200_000, maxOutputTokens: 64_000, pricing: SONNET,
  },
  {
    id: 'claude-haiku-4-5-20251001', title: 'Claude Haiku 4.5', provider: 'anthropic',
    description: 'Fastest model with near-frontier intelligence.',
    contextTokens: 200_000, maxOutputTokens: 64_000, pricing: HAIKU_45,
  },
  {
    id: 'claude-3-5-haiku-20241022', title: 'Claude 3.5 Haiku', provider: 'anthropic',
    description: 'Fast model with strong capabilities.',
    contextTokens: 200_000, maxOutputTokens: 8_192, pricing: HAIKU_35,
  },
  {
    id: 'claude-opus-4-1-20250805', title: 'Claude Opus 4.1', provider: 'anthropic',
    description: 'Enhanced agentic tasks, reasoning, and coding.',
    contextTokens: 200_000, maxOutputTokens: 32_000, pricing: OPUS_4,
  },
  {
    id: 'claude-opus-4-20250514', title: 'Claude Opus 4', provider: 'anthropic',
    description: 'Complex reasoning and advanced coding.',
    contextTokens: 200_000, maxOutputTokens: 32_000, pricing: OPUS_4,
  },

  // ── OpenAI ──
  {
    id: 'gpt-4o', title: 'GPT-4o', provider: 'openai',
    description: 'Multimodal flagship, fast and capable.',
    contextTokens: 128_000, maxOutputTokens: 16_384, pricing: GPT4O,
  },
  {
    id: 'gpt-4o-mini', title: 'GPT-4o Mini', provider: 'openai',
    description: 'Small, affordable for lightweight tasks.',
    contextTokens: 128_000, maxOutputTokens: 16_384, pricing: GPT4O_MINI,
  },
  {
    id: 'o3', title: 'o3', provider: 'openai',
    description: 'Reasoning model for math, science, coding.',
    contextTokens: 200_000, maxOutputTokens: 100_000, pricing: O3,
  },
  {
    id: 'o4-mini', title: 'o4-mini', provider: 'openai',
    description: 'Fast, cost-efficient reasoning.',
    contextTokens: 200_000, maxOutputTokens: 100_000, pricing: O4_MINI,
  },
  {
    id: 'gpt-5', title: 'GPT-5', provider: 'openai',
    description: 'Reasoning flagship with summaries.',
    contextTokens: 1_048_576, maxOutputTokens: 32_768, pricing: GPT5,
  },
  {
    id: 'gpt-5-mini', title: 'GPT-5 Mini', provider: 'openai',
    description: 'Fast reasoning, affordable.',
    contextTokens: 1_048_576, maxOutputTokens: 32_768, pricing: GPT5_MINI,
  },
  {
    id: 'gpt-5-nano', title: 'GPT-5 Nano', provider: 'openai',
    description: 'Cheapest reasoning model.',
    contextTokens: 1_048_576, maxOutputTokens: 32_768, pricing: GPT5_NANO,
  },
  {
    id: 'gpt-5.1', title: 'GPT-5.1', provider: 'openai',
    description: 'Improved GPT-5 with better coding.',
    contextTokens: 1_048_576, maxOutputTokens: 32_768, pricing: GPT5_1,
  },
  {
    id: 'gpt-5.2', title: 'GPT-5.2', provider: 'openai',
    description: 'Enhanced reasoning and tool use.',
    contextTokens: 1_048_576, maxOutputTokens: 32_768, pricing: GPT5_2,
  },
  {
    id: 'gpt-5.4', title: 'GPT-5.4', provider: 'openai',
    description: 'Most capable OpenAI model, 1M context.',
    contextTokens: 1_048_576, maxOutputTokens: 32_768, pricing: GPT5_4,
  },

  // ── OpenRouter (pricing varies — leave undefined, computed by OR) ──
  {
    id: 'deepseek/deepseek-r1', title: 'DeepSeek R1', provider: 'openrouter',
    description: 'Reasoning model, 64K context.',
    contextTokens: 64_000, maxOutputTokens: 32_768,
  },
  {
    id: 'deepseek/deepseek-v3', title: 'DeepSeek V3', provider: 'openrouter',
    description: '671B MoE, 128K context.',
    contextTokens: 128_000, maxOutputTokens: 32_768,
  },
  {
    id: 'meta-llama/llama-4-scout', title: 'Llama 4 Scout', provider: 'openrouter',
    description: '17B active, 10M context.',
    contextTokens: 10_000_000, maxOutputTokens: 65_536,
  },
  {
    id: 'meta-llama/llama-4-maverick', title: 'Llama 4 Maverick', provider: 'openrouter',
    description: '400B MoE, 512K context.',
    contextTokens: 512_000, maxOutputTokens: 65_536,
  },
  {
    id: 'google/gemini-2.5-pro', title: 'Gemini 2.5 Pro', provider: 'openrouter',
    description: 'Reasoning-focused, 1M context.',
    contextTokens: 1_048_576, maxOutputTokens: 65_536,
  },
  {
    id: 'google/gemini-2.5-flash', title: 'Gemini 2.5 Flash', provider: 'openrouter',
    description: 'Best price-performance, 1M context.',
    contextTokens: 1_048_576, maxOutputTokens: 65_536,
  },
  {
    id: 'x-ai/grok-4-fast', title: 'Grok 4 Fast', provider: 'openrouter',
    description: 'Best agentic tool calling, 2M context.',
    contextTokens: 2_000_000, maxOutputTokens: 131_072,
  },
];

// ── Lookup helpers ──

const byId = new Map(MODEL_REGISTRY.map(m => [m.id, m]));

/** Look up a model definition by ID. */
export function getModel(id: string): ModelDef | undefined {
  return byId.get(id);
}

/**
 * Get pricing for a model ID. Falls back to prefix matching for dated model IDs
 * (e.g. "claude-sonnet-4-20250514" matches "claude-sonnet-4").
 */
export function getModelPricing(model: string): ModelPricing | null {
  // Exact match first
  const exact = byId.get(model);
  if (exact?.pricing) return exact.pricing;

  // Prefix match — "claude-sonnet-4-20250514" → try "claude-sonnet-4"
  for (const def of MODEL_REGISTRY) {
    if (def.pricing && model.startsWith(def.id)) return def.pricing;
  }
  return null;
}

/**
 * Compute USD cost from token counts and model.
 *
 * Token counts follow the normalized TokenUsage convention (see types.ts):
 *   input  = TOTAL input tokens (includes cached reads + cache writes)
 *   output = TOTAL output tokens (includes reasoning tokens)
 *
 * Cost formula:
 *   uncachedInput = input - cacheRead - cacheWrite
 *   cost = uncachedInput * inputPrice
 *        + cacheRead    * cacheReadPrice   (Anthropic ~10%, OpenAI ~50%)
 *        + cacheWrite   * cacheWritePrice  (Anthropic 125%, OpenAI = input)
 *        + output       * outputPrice
 *
 * If nativeCost is present (OpenRouter), it takes precedence over computation.
 */
export function computeCost(
  model: string,
  tokens: { input: number; output: number; cacheRead?: number; cacheWrite?: number; nativeCost?: number },
): number {
  // OpenRouter reports authoritative cost inline — use it when available
  if (tokens.nativeCost != null) return tokens.nativeCost;

  const pricing = getModelPricing(model);
  if (!pricing) return 0;

  const cacheRead = tokens.cacheRead ?? 0;
  const cacheWrite = tokens.cacheWrite ?? 0;
  const uncachedInput = tokens.input - cacheRead - cacheWrite;

  const mtok = 1_000_000;
  return (
    (uncachedInput * pricing.input) / mtok +
    (cacheRead * pricing.cacheRead) / mtok +
    (cacheWrite * pricing.cacheWrite) / mtok +
    (tokens.output * pricing.output) / mtok
  );
}

/**
 * List models grouped by provider — for UI model picker.
 */
export function listModels(): Record<string, ModelDef[]> {
  const grouped: Record<string, ModelDef[]> = {};
  for (const def of MODEL_REGISTRY) {
    (grouped[def.provider] ??= []).push(def);
  }
  return grouped;
}
