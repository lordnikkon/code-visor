// Pure helpers for the cache countdown: what colour, how full, how written. Everything
// that takes `$` lives in register.tsx: Claude Code 2.1.295 follows `$` only into
// functions of the same file and refuses to load a module that passes it across an import.

// Claude Code writes 1-hour cache entries; every main-session request refreshes them.
export const CACHE_TTL_MS = 60 * 60 * 1000
const WARN_S = 20 * 60
const ALERT_S = 10 * 60

export const CACHE = '#4fb3a9'
export const WARN = '#e2a94e'
export const ALERT = '#e0846b'
export const IDLE = '#8a8a8a'

// While a turn runs the cache is being refreshed: no warning colour then.
export const cacheColor = (left: number | null, isWorking: boolean): string =>
  left === null || left <= 0 ? IDLE : isWorking ? CACHE : left <= ALERT_S ? ALERT : left <= WARN_S ? WARN : CACHE

export const cacheRatio = (left: number | null): number =>
  left === null ? 0 : Math.max(0, Math.min(1, left / (CACHE_TTL_MS / 1000)))

const pad = (n: number): string => String(n).padStart(2, '0')

// "42:10" in the idle row. `cold` is the word for a cache no answer has warmed yet (before the
// first answer, after a compaction), `expired` the word for 0; both in the row's language.
export const clockText = (left: number | null, expired: string, cold: string): string =>
  left === null ? cold : left === 0 ? expired : `${pad(Math.floor(left / 60))}:${pad(left % 60)}`

