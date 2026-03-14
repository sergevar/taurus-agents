import { DEFAULT_LIMIT_OUTPUT_TOKENS } from './defaults.js';

/**
 * Model registry — single source of truth for model metadata + pricing.
 *
 * Model IDs are always provider-prefixed: "anthropic/claude-sonnet-4-20250514",
 * "openai/gpt-4o", "openrouter/deepseek/deepseek-r1". The provider prefix is
 * stripped by the inference factory before sending to the API.
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
  /** Provider-prefixed model ID: "anthropic/claude-sonnet-4-20250514", "openai/gpt-4o", etc. */
  id: string;
  title: string;
  description: string;
  contextTokens: number;
  maxOutputTokens: number;
  /** Output budget per inference call. Defaults to maxOutputTokens if not set. */
  limitOutputTokens?: number;
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

// Anthropic
const OPUS_46: ModelPricing = { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.50 };
const OPUS_4: ModelPricing = { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.50 };
const SONNET: ModelPricing = { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.30 };
const HAIKU_45: ModelPricing = { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.10 };
// OpenAI
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
    id: 'anthropic/claude-opus-4-6',
    title: 'Claude Opus 4.6', description: 'Most capable. Superior reasoning, coding, agentic performance.',
    contextTokens: 200_000, maxOutputTokens: 128_000, pricing: OPUS_46,
  },
  {
    id: 'anthropic/claude-opus-4-5-20251101',
    title: 'Claude Opus 4.5', description: 'Premium intelligence with practical performance.',
    contextTokens: 200_000, maxOutputTokens: 64_000, pricing: OPUS_46,
  },
  {
    id: 'anthropic/claude-sonnet-4-6',
    title: 'Claude Sonnet 4.6', description: 'Best balance of intelligence, speed, and cost.',
    contextTokens: 200_000, maxOutputTokens: 64_000, pricing: SONNET,
  },
  {
    id: 'anthropic/claude-sonnet-4-5-20250929',
    title: 'Claude Sonnet 4.5', description: 'High intelligence at balanced speed and cost.',
    contextTokens: 200_000, maxOutputTokens: 64_000, pricing: SONNET,
  },
  {
    id: 'anthropic/claude-sonnet-4-20250514',
    title: 'Claude Sonnet 4', description: 'High-performance reasoning and efficiency.',
    contextTokens: 200_000, maxOutputTokens: 64_000, pricing: SONNET,
  },
  {
    id: 'anthropic/claude-haiku-4-5-20251001',
    title: 'Claude Haiku 4.5', description: 'Fastest model with near-frontier intelligence.',
    contextTokens: 200_000, maxOutputTokens: 64_000, pricing: HAIKU_45,
  },
  {
    id: 'anthropic/claude-opus-4-1-20250805',
    title: 'Claude Opus 4.1', description: 'Enhanced agentic tasks, reasoning, and coding.',
    contextTokens: 200_000, maxOutputTokens: 64_000, pricing: OPUS_4,
  },
  {
    id: 'anthropic/claude-opus-4-20250514',
    title: 'Claude Opus 4', description: 'Complex reasoning and advanced coding.',
    contextTokens: 200_000, maxOutputTokens: 64_000, pricing: OPUS_4,
  },

  // ── OpenAI ──
  {
    id: 'openai/gpt-4o',
    title: 'GPT-4o', description: 'Multimodal flagship, fast and capable.',
    contextTokens: 128_000, maxOutputTokens: 16_384, pricing: GPT4O,
  },
  {
    id: 'openai/gpt-4o-mini',
    title: 'GPT-4o Mini', description: 'Small, affordable for lightweight tasks.',
    contextTokens: 128_000, maxOutputTokens: 16_384, pricing: GPT4O_MINI,
  },
  {
    id: 'openai/o3',
    title: 'o3', description: 'Reasoning model for math, science, coding.',
    contextTokens: 200_000, maxOutputTokens: 100_000, pricing: O3,
  },
  {
    id: 'openai/o4-mini',
    title: 'o4-mini', description: 'Fast, cost-efficient reasoning.',
    contextTokens: 200_000, maxOutputTokens: 100_000, pricing: O4_MINI,
  },
  {
    id: 'openai/gpt-5',
    title: 'GPT-5', description: 'Reasoning flagship with summaries.',
    contextTokens: 400_000, maxOutputTokens: 128_000, pricing: GPT5,
    // context lengths numbers confirmed: https://openai.com/gpt-5/
  },
  {
    id: 'openai/gpt-5-mini',
    title: 'GPT-5 Mini', description: 'Fast reasoning, affordable.',
    contextTokens: 400_000, maxOutputTokens: 128_000, pricing: GPT5_MINI,
    // context lengths numbers confirmed: https://openai.com/gpt-5/
  },
  {
    id: 'openai/gpt-5-nano',
    title: 'GPT-5 Nano', description: 'Cheapest reasoning model.',
    contextTokens: 400_000, maxOutputTokens: 128_000, pricing: GPT5_NANO,
    // context lengths numbers confirmed: https://openai.com/gpt-5/
  },
  {
    id: 'openai/gpt-5.1',
    title: 'GPT-5.1', description: 'Improved GPT-5 with better coding.',
    contextTokens: 400_000, maxOutputTokens: 128_000, pricing: GPT5_1,
  },
  {
    id: 'openai/gpt-5.2',
    title: 'GPT-5.2', description: 'Enhanced reasoning and tool use.',
    contextTokens: 400_000, maxOutputTokens: 128_000, pricing: GPT5_2,
  },
  {
    id: 'openai/gpt-5.4',
    title: 'GPT-5.4', description: 'Most capable OpenAI model, 1M context.',
    contextTokens: 1_050_000, maxOutputTokens: 128_000, pricing: GPT5_4,
  },

  // ── Groq (fast inference, OpenAI-compatible API) ──
  {
    id: 'groq/llama-3.1-8b-instant',
    title: 'Llama 3.1 8B', description: 'Ultra-fast small model, 131K context.',
    contextTokens: 131_072, maxOutputTokens: 131_072,
    pricing: { input: 0.05, output: 0.08, cacheWrite: 0.05, cacheRead: 0.05 },
  },
  {
    id: 'groq/llama-3.3-70b-versatile',
    title: 'Llama 3.3 70B', description: 'Fast and versatile, 131K context.',
    contextTokens: 131_072, maxOutputTokens: 32_768,
    pricing: { input: 0.59, output: 0.79, cacheWrite: 0.59, cacheRead: 0.59 },
  },
  {
    id: 'groq/openai/gpt-oss-120b',
    title: 'GPT OSS 120B', description: 'Large open-source GPT, 131K context.',
    contextTokens: 131_072, maxOutputTokens: 65_536,
    pricing: { input: 0.15, output: 0.60, cacheWrite: 0.15, cacheRead: 0.15 },
  },
  {
    id: 'groq/openai/gpt-oss-20b',
    title: 'GPT OSS 20B', description: 'Fast open-source GPT, 131K context.',
    contextTokens: 131_072, maxOutputTokens: 65_536,
    pricing: { input: 0.075, output: 0.30, cacheWrite: 0.075, cacheRead: 0.075 },
  },

  // ── OpenRouter (pricing varies — leave undefined, computed by OR) ──
  {
    id: 'openrouter/deepseek/deepseek-r1',
    title: 'DeepSeek R1', description: 'Reasoning model, 64K context.',
    contextTokens: 64_000, maxOutputTokens: 32_768,
  },
  {
    id: 'openrouter/deepseek/deepseek-v3',
    title: 'DeepSeek V3', description: '671B MoE, 128K context.',
    contextTokens: 128_000, maxOutputTokens: 32_768,
  },
  {
    id: 'openrouter/meta-llama/llama-4-scout',
    title: 'Llama 4 Scout', description: '17B active, 10M context.',
    contextTokens: 327_680, maxOutputTokens: 65_536,
  },
  {
    id: 'openrouter/meta-llama/llama-4-maverick',
    title: 'Llama 4 Maverick', description: '400B MoE, 512K context.',
    contextTokens: 1_048_576, maxOutputTokens: 65_536,
  },
  {
    id: 'openrouter/google/gemini-2.5-pro',
    title: 'Gemini 2.5 Pro', description: 'Reasoning-focused, 1M context.',
    contextTokens: 1_048_576, maxOutputTokens: 65_536,
  },
  {
    id: 'openrouter/google/gemini-2.5-flash',
    title: 'Gemini 2.5 Flash', description: 'Best price-performance, 1M context.',
    contextTokens: 1_048_576, maxOutputTokens: 65_536,
  },
  {
    id: 'openrouter/x-ai/grok-4-fast',
    title: 'Grok 4 Fast', description: 'Best agentic tool calling, 2M context.',
    contextTokens: 2_000_000, maxOutputTokens: 131_072,
  },
];

// ── Lookup helpers ──

/** Extract provider from a prefixed model ID: "openai/gpt-4o" → "openai". */
export function getProvider(model: string): string {
  const slash = model.indexOf('/');
  return slash === -1 ? model : model.slice(0, slash);
}

const byId = new Map(MODEL_REGISTRY.map(m => [m.id, m]));

/** Look up a model definition by prefixed ID. */
export function getModel(id: string): ModelDef | undefined {
  return byId.get(id);
}

/** Get the output token limit for a model. Single source of truth for max_tokens.
 *  Returns min(limitOutputTokens, maxOutputTokens) — never exceeds model capacity.
 *  Falls back to DEFAULT_LIMIT_OUTPUT_TOKENS for unknown models. */
export function getLimitOutputTokens(model: string): number {
  const def = getModel(model);
  if (!def) return DEFAULT_LIMIT_OUTPUT_TOKENS;
  return Math.min(def.limitOutputTokens ?? def.maxOutputTokens, def.maxOutputTokens);
}

/**
 * Get pricing for a model ID. Falls back to prefix matching for dated model IDs
 * (e.g. "anthropic/claude-sonnet-4-20250514" matches "anthropic/claude-sonnet-4").
 */
export function getModelPricing(model: string): ModelPricing | null {
  // Exact match first (works for both prefixed and bare via dual-indexed map)
  const exact = byId.get(model);
  if (exact?.pricing) return exact.pricing;

  // Prefix match — "anthropic/claude-sonnet-4-20250514" → try "anthropic/claude-sonnet-4"
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
 * Provider is extracted from the model ID prefix.
 */
export function listModels(): Record<string, ModelDef[]> {
  const grouped: Record<string, ModelDef[]> = {};
  for (const def of MODEL_REGISTRY) {
    const provider = getProvider(def.id);
    (grouped[provider] ??= []).push(def);
  }
  return grouped;
}
