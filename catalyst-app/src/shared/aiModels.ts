import type { AiProvider } from './types.js'

// Anthropic lineup verified against https://platform.claude.com/docs/en/models/overview
// on 2026-09-18. Keep defaults and the selector in sync.
export const AI_MODELS: Record<AiProvider, readonly (readonly [string, string])[]> = {
  openai: [
    ['gpt-6-astra', 'Astra — gpt-6-astra · x-high'],
    ['gpt-5.6-sol', 'Sol — gpt-5.6-sol · x-high'],
    ['gpt-5.6-terra', 'Terra — gpt-5.6-terra · x-high'],
  ],
  anthropic: [
    ['claude-fable-5-1', 'Fable 5.1 — claude-fable-5-1'],
    ['claude-opus-5', 'Opus 5 — claude-opus-5'],
    ['claude-sonnet-5', 'Sonnet 5 — claude-sonnet-5'],
    ['claude-haiku-4-5-20251001', 'Haiku 4.5 — claude-haiku-4-5'],
  ],
}
export const defaultModelFor = (provider: AiProvider): string =>
  provider === 'openai' ? 'gpt-5.6-terra' : 'claude-sonnet-5'

export function configuredModelFor(model: string | undefined, provider: AiProvider): string {
  if (provider === 'anthropic') {
    if (model?.startsWith('claude-opus-4')) return 'claude-opus-5'
    if (model?.startsWith('claude-sonnet-4')) return 'claude-sonnet-5'
    if (model === 'claude-fable-5') return 'claude-fable-5-1'
  }
  return AI_MODELS[provider].some(([id]) => id === model) ? model! : defaultModelFor(provider)
}
