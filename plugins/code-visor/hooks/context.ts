// Pure helpers for the context bar beside the cache bar: what colour, how full, how written.
// The reading itself takes `$` and lives in register.tsx (see cache.ts for why).

const WARN_PCT = 70
const ALERT_PCT = 85

export const CONTEXT = '#6f9fd8'
export const CONTEXT_WARN = '#e2a94e'
export const CONTEXT_ALERT = '#e0846b'
export const CONTEXT_IDLE = '#8a8a8a'

// Blue while there is room, amber from 70 %, red from 85 %; grey before the first answer.
export const contextColor = (pct: number | null): string =>
  pct === null ? CONTEXT_IDLE : pct >= ALERT_PCT ? CONTEXT_ALERT : pct >= WARN_PCT ? CONTEXT_WARN : CONTEXT

export const contextRatio = (pct: number | null): number => (pct === null ? 0 : Math.max(0, Math.min(1, pct / 100)))

// "42%" in the row; "—" before the first answer.
export const percentText = (pct: number | null): string => (pct === null ? '—' : `${Math.round(pct)}%`)
