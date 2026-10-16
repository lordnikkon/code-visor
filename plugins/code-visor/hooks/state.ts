import type { Hud, Panel } from '../types'

// Initial state values; the atoms themselves are declared in register.tsx,
// where every function that takes `$` lives.
export const PANEL: Panel = { isCompact: false, isDoneCollapsed: false, autoOpenedFor: '' }
export const HUD: Hud = { model: '', expiresAt: null, secondsLeft: null, contextPercent: null }
