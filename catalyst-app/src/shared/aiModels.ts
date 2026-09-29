import type { AiProvider } from './types.js'

// Anthropic lineup verified against the Claude API model table on 2026-09-29.
// Keep defaults, the selector and the capability helpers below in sync.
export const AI_MODELS: Record<AiProvider, readonly (readonly [string, string])[]> = {
  openai: [
    ['gpt-6-astra', 'Astra — gpt-6-astra · x-high'],
    ['gpt-5.6-sol', 'Sol — gpt-5.6-sol · x-high'],
    ['gpt-5.6-terra', 'Terra — gpt-5.6-terra · x-high'],
  ],
  anthropic: [
    ['claude-fable-5-1', 'Fable 5.1 — claude-fable-5-1 · x-high'],
    ['claude-opus-5-5', 'Opus 5.5 — claude-opus-5-5 · x-high'],
    ['claude-sonnet-5-5', 'Sonnet 5.5 — claude-sonnet-5-5 · x-high'],
    ['claude-opus-5', 'Opus 5 — claude-opus-5 · x-high'],
    ['claude-sonnet-5', 'Sonnet 5 — claude-sonnet-5 · x-high'],
    ['claude-haiku-4-5-20251001', 'Haiku 4.5 — claude-haiku-4-5'],
  ],
}
export const defaultModelFor = (provider: AiProvider): string =>
  provider === 'openai' ? 'gpt-6-astra' : 'claude-fable-5-1'

export function configuredModelFor(model: string | undefined, provider: AiProvider): string {
  if (provider === 'anthropic') {
    if (model?.startsWith('claude-opus-4')) return 'claude-opus-5-5'
    if (model?.startsWith('claude-sonnet-4')) return 'claude-sonnet-5-5'
    if (model === 'claude-fable-5') return 'claude-fable-5-1'
  }
  return AI_MODELS[provider].some(([id]) => id === model) ? model! : defaultModelFor(provider)
}

// Every model here reasons at x-high unless it has no effort control.
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'xhigh'

// Anthropic models that accept `output_config.effort` (Haiku 4.5 does not).
export function anthropicSupportsEffort(model: string): boolean {
  return /^claude-(fable-5|opus-5|sonnet-5)/.test(model)
}

// These models reject forced tool choice (`any` / `tool`) with a 400; they
// get `auto` plus an explicit instruction and a retry when no call is made.
export function anthropicRejectsForcedTool(model: string): boolean {
  return ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5'].includes(model)
}

// Adaptive thinking is always on for these models; asking for summarized
// display lets the progress log show what the model is working on.
export function anthropicHasAdaptiveThinking(model: string): boolean {
  return /^claude-(fable-5|opus-5|sonnet-5)/.test(model)
}

// Output ceiling for one coaching response, thinking included.
export function maxOutputTokensFor(provider: AiProvider, model: string): number {
  if (provider === 'openai') return 64000
  return model.startsWith('claude-haiku') ? 32000 : 100000
}
