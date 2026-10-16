import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRun, Flow, Hud, Panel } from '../types'
import { CACHE_TTL_MS, cacheColor, cacheRatio, clockText } from './cache'
import { contextColor, contextRatio, percentText } from './context'
import { HUD, PANEL } from './state'

// Kept under a shape tag: a version that changes what these hold bumps it, so a reload
// declines the value the older code stored instead of drawing it.
const SHAPE = { shape: 'v1' }
const flow = atom({ plugin: 'code-visor', key: 'flow' } as const, null, SHAPE)
const agents = atom({ plugin: 'code-visor', key: 'agents' } as const, [], SHAPE)
const panel = atom({ plugin: 'code-visor', key: 'panel' } as const, PANEL, SHAPE)
const now = atom({ plugin: 'code-visor', key: 'now' } as const, 0)
const hud = atom({ plugin: 'code-visor', key: 'hud' } as const, HUD)
// Hidden with /hud: stays so until /hud again.
const isHidden = atom({ plugin: 'code-visor', key: 'isHidden' } as const, false)

// ---------------------------------------------------------------------------
// Cache countdown and model. These take `$`, so they stay in this file (see cache.ts).

// The cache is warm again: the countdown starts over from a full hour.
async function restartCache($: EngineInterface): Promise<void> {
  const at = await $.clock.now()
  await update($, hud, h => ({ ...h, expiresAt: at + CACHE_TTL_MS, secondsLeft: CACHE_TTL_MS / 1000 }))
}

// The model and effort a main-session request ran on; an effort given as a number is not shown.
async function noteModel($: EngineInterface, model: string, effort: unknown): Promise<void> {
  await update($, hud, h => ({ ...h, model: model || h.model, effort: typeof effort === 'string' ? effort : h.effort }))
}

// The main session's context fill, as the status line reads it. Absent until the first
// answer of a live window (a fresh or just compacted session): the bar is then empty.
async function noteContext($: EngineInterface): Promise<void> {
  try {
    const { context } = await $.session.usage()
    const pct = typeof context.percent === 'number' ? context.percent : null
    await update($, hud, h => (h.contextPercent === pct ? h : { ...h, contextPercent: pct }))
  } catch {
    // An engine without the reading keeps the last one.
  }
}

// `/hud demo <minutes>`: a deadline that far out, until the next answer restarts it.
async function fakeCache($: EngineInterface, seconds: number): Promise<void> {
  const at = await $.clock.now()
  await update($, hud, h => ({ ...h, expiresAt: at + seconds * 1000, secondsLeft: seconds }))
}

// A finished flow stays this long, then the row is model and cache again.
const FINISHED_MS = 10 * 1000

// Once a second: a flow finished long enough ago gives the row back.
async function dropFinishedFlow($: EngineInterface): Promise<void> {
  const f = await read($, flow)
  if (!f?.isFinished || f.finishedAt === undefined) return
  const at = await $.clock.now()
  if (at - f.finishedAt >= FINISHED_MS) await update($, flow, p => (p?.isFinished && p.finishedAt === f.finishedAt ? null : p))
}

// Once a second: the seconds left, written only when they changed so idle redraws stay rare.
async function tickCache($: EngineInterface): Promise<void> {
  const { expiresAt, secondsLeft } = await read($, hud)
  if (expiresAt === null) return
  const left = Math.max(0, Math.floor((expiresAt - (await $.clock.now())) / 1000))
  if (left !== secondsLeft) await update($, hud, h => ({ ...h, secondsLeft: left }))
}

// ---------------------------------------------------------------------------
// Subagents of the main session form a batch, drawn as a flow: started from the first
// spawn, finished when the last of them ends. Nested subagents are not counted.
// A spawn while a finished batch still shows carries it on: a workflow starts its next
// agent milliseconds after the last one ended, and that is still the same run.

// Module scope is enough: a reload mid-batch only loses that batch's count.
let batchIds: Set<string> | null = null

// Starts and ends are booked one after another: a workflow spawns its agents at the same
// moment, and spawns that each read "no batch yet" would each start the batch over.
let batchQueue: Promise<void> = Promise.resolve()
function inOrder(job: () => Promise<void>): Promise<void> {
  const run = batchQueue.then(job)
  batchQueue = run.catch(() => undefined)
  return run
}

const batchStarted = ($: EngineInterface, agentId: string, title: string): Promise<void> =>
  inOrder(() => startInBatch($, agentId, title))
const batchEnded = ($: EngineInterface, agentId: string): Promise<void> => inOrder(() => endInBatch($, agentId))

// The decision is taken inside `update`, which sees the latest value: a `read` in a
// dispatch that ran beside another can still see the flow as it was before that one wrote.
async function startInBatch($: EngineInterface, agentId: string, title: string): Promise<void> {
  let step = 'join' as 'join' | 'reopen' | 'new'
  await update($, flow, (p): Flow => {
    if (p?.isFinished) {
      step = 'reopen'
      return { ...p, isFinished: false, finishedAt: undefined, total: p.total + 1 }
    }
    if (p && batchIds) {
      step = 'join'
      return { ...p, total: p.total + 1 }
    }
    step = 'new'
    return { title, total: 1, done: 0, isFinished: false }
  })
  if (step !== 'join' || !batchIds) batchIds = new Set()
  batchIds.add(agentId)
  // A new batch starts with a clean panel; agents still running stay.
  if (step === 'new') await update($, agents, list => list.filter(a => a.status === 'running'))
}

async function endInBatch($: EngineInterface, agentId: string): Promise<void> {
  if (!batchIds?.has(agentId)) return
  batchIds.delete(agentId)
  const isLast = batchIds.size === 0
  if (isLast) batchIds = null
  const at = await $.clock.now()
  await update($, flow, p =>
    p ? { ...p, done: Math.min(p.total, p.done + 1), ...(isLast ? { isFinished: true, finishedAt: at } : {}) } : p,
  )
}

const PANE = 'code-visor-agents'
const ACCENT = '#8f8cf4'

// ---------------------------------------------------------------------------
// Language: the `language` option, else Claude Code's `language` setting, else the
// process locale; English when nothing says Hebrew or Russian.

type Lang = 'en' | 'ru' | 'he'

const STRINGS = {
  en: {
    pane: 'Agents',
    cost: 'Cost',
    tokens: 'Tokens',
    time: 'Time',
    collapse: 'Collapse',
    expand: 'Expand',
    running: 'Running',
    finished: 'Finished',
    empty: 'No subagents yet.',
    round: 'round',
    failed: 'error',
    tokensWord: 'tokens',
    agentsCount: 'agents',
    isRunning: 'running',
    isFinished: 'finished',
    opened: 'Agents panel opened.',
    closed: 'Agents panel closed.',
    paneWaits: 'The agents panel waits for a wider terminal: your next prompt, /agents-info or ×n opens it.',
    done: 'Done',
    tasks: 'Tasks',
    ctx: 'ctx',
    cache: 'Cache',
    context: 'Context',
    expired: 'expired',
    cold: 'cold',
    subagents: 'Subagents',
    hudShown: 'HUD shown.',
    hudHidden: 'HUD hidden.',
    demo: 'Cache demo: {m} min left until the next answer.',
    effort: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
  },
  ru: {
    pane: 'Агенты',
    cost: 'Стоимость',
    tokens: 'Токены',
    time: 'Время',
    collapse: 'Свернуть',
    expand: 'Развернуть',
    running: 'Работают',
    finished: 'Завершены',
    empty: 'Субагентов пока нет.',
    round: 'раунд',
    failed: 'ошибка',
    tokensWord: 'токенов',
    agentsCount: 'агентов',
    isRunning: 'работает',
    isFinished: 'завершён',
    opened: 'Панель агентов открыта.',
    closed: 'Панель агентов закрыта.',
    paneWaits: 'Панель агентов ждёт более широкого терминала: её откроет ваш следующий запрос, /agents-info или ×n.',
    done: 'Готово',
    tasks: 'Задачи',
    ctx: 'ctx',
    cache: 'Кэш',
    context: 'Контекст',
    expired: 'истёк',
    cold: 'cold',
    subagents: 'Субагенты',
    hudShown: 'HUD показан.',
    hudHidden: 'HUD скрыт.',
    demo: 'Демо кэша: {m} мин до следующего ответа.',
    effort: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
  },
  he: {
    pane: 'סוכנים',
    cost: 'עלות',
    tokens: 'טוקנים',
    time: 'זמן',
    collapse: 'כיווץ',
    expand: 'הרחבה',
    running: 'פועלים',
    finished: 'הסתיימו',
    empty: 'עדיין אין סוכנים.',
    round: 'סבב',
    failed: 'שגיאה',
    tokensWord: 'טוקנים',
    agentsCount: 'סוכנים',
    isRunning: 'פועל',
    isFinished: 'הסתיים',
    opened: 'חלונית הסוכנים נפתחה.',
    closed: 'חלונית הסוכנים נסגרה.',
    paneWaits: 'חלונית הסוכנים ממתינה למסוף רחב יותר: ההנחיה הבאה שלך, ‎/agents-info או ‎×n יפתחו אותה.',
    done: 'הושלם',
    tasks: 'משימות',
    ctx: 'הקשר',
    cache: 'מטמון',
    context: 'הקשר',
    expired: 'פג',
    cold: 'cold',
    subagents: 'סוכני משנה',
    hudShown: 'HUD מוצג.',
    hudHidden: 'HUD מוסתר.',
    demo: 'הדגמת מטמון: {m} דק׳ עד התשובה הבאה.',
    effort: { low: 'נמוך', medium: 'בינוני', high: 'גבוה', xhigh: 'גבוה מאוד', max: 'מקסימלי' },
  },
} as const

// Module scope is fine here: session.start sets it again on every (re)load.
let lang: Lang = 'en'
const tr = () => STRINGS[lang]

// Hebrew draws every row mirrored: crab and title on the right, numbers on the left.
const isRtl = () => lang === 'he'

// Effort words as shown; anything unknown shows as it came.
const effortWord = (effort: string): string => (tr().effort as Record<string, string>)[effort] ?? effort

const isRussian = (v: unknown): boolean => typeof v === 'string' && /^(ru|russian|рус)/i.test(v.trim())
const isHebrew = (v: unknown): boolean => typeof v === 'string' && /^(he|iw|hebrew|עברית)/i.test(v.trim())
const langOf = (v: unknown): Lang => (isHebrew(v) ? 'he' : isRussian(v) ? 'ru' : 'en')

async function detectLang($: EngineInterface, option: unknown): Promise<Lang> {
  if (option === 'en' || option === 'ru' || option === 'he') return option
  try {
    const settings = (await $.settings.read()) as Record<string, unknown>
    if (typeof settings.language === 'string' && settings.language.trim()) return langOf(settings.language)
  } catch {
    // No settings: fall through to the locale.
  }
  const locale = (await $.env.get('LC_ALL')) || (await $.env.get('LC_MESSAGES')) || (await $.env.get('LANG'))
  return langOf(locale)
}

const label = (f: Flow): string => (f.isFinished ? tr().done : `${tr().tasks} ${f.done}/${f.total}`)

const ratio = (f: Flow): number => (f.isFinished ? 1 : f.total ? f.done / f.total : 0)

// Deterministic noise so the dither does not shimmer between redraws.
const noise = (x: number, y: number): number => {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453
  return s - Math.floor(s)
}

// The whole row is one SVG: the desktop wraps sibling elements onto new lines,
// so title, bar, percent and the crab live in one drawing; only the count and
// the dismiss are Buttons beside it.
const H = 22
const BAR_H = 16
const CRAB_W = 26
// The crab's drawing grid is 30 units wide, props included.
const CRAB_BOX = 30
const CELL = 3
const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',sans-serif"

const xml = (s: string): string =>
  s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

// CJK, fullwidth forms and emoji advance about 1em; at 0.56em a Chinese title was sized at half its width and the bar drew over it.
// 中日韩文字、全角标点和 emoji 约占 1em；按 0.56em 算时中文标题宽度被低估近一半，进度条会压到标题上。
const WIDE =
  /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF01-\uFF60\uFFE0-\uFFE6\u{1F300}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u

// Rough advance of system UI text, in em; good enough to size the title's slot.
const charEm = (ch: string): number =>
  WIDE.test(ch) ? 1 : /[\s.,:;'|!il1()[\]]/.test(ch) ? 0.3 : /[A-ZА-ЯЁmwшщжюМШЩЖЮ@%]/.test(ch) ? 0.72 : 0.56

const textWidth = (s: string, size: number): number => [...s].reduce((w, ch) => w + charEm(ch) * size, 0)

// Cuts `s` to fit `maxW` pixels, with an ellipsis when it had to cut.
const fitText = (s: string, size: number, maxW: number): string => {
  if (textWidth(s, size) <= maxW) return s
  let out = ''
  for (const ch of s) {
    if (textWidth(out + ch + '…', size) > maxW) break
    out += ch
  }
  return out + '…'
}

// ---------------------------------------------------------------------------
// Drawing shared by the progress bar and the cache bar.

// Dithered fill `fillW` wide: sparse at the start, dense toward the head. `bx` mirrors a box inside the bar.
const ditherDots = (fillW: number, barH: number, bx: (x: number, w: number) => number): string => {
  const dots: string[] = []
  const cols = Math.floor(fillW / CELL)
  const rows = Math.floor(barH / CELL)
  for (let c = 0; c < cols; c++) {
    const density = 0.35 + 0.6 * Math.pow(c / Math.max(1, cols), 1.2)
    for (let r = 0; r < rows; r++) {
      if (noise(c, r) < density) dots.push(`<rect class="t${Math.floor(noise(r, c) * 4)}" x="${bx(c * CELL + 1, 2)}" y="${r * CELL + 1}" width="2" height="2"/>`)
    }
  }
  return dots.join('')
}

// Pixels twinkle in four out-of-phase groups; a calm bar (finished, expired) settles to a slow glow.
const twinkleCss = (isCalm: boolean): string => `.t0,.t1,.t2,.t3{animation:tw ${isCalm ? 3.2 : 2.2}s ease-in-out infinite}
.t1{animation-duration:${isCalm ? 3.8 : 2.8}s;animation-delay:-.7s}.t2{animation-duration:${isCalm ? 4.4 : 1.9}s;animation-delay:-1.3s}.t3{animation-duration:${isCalm ? 3.5 : 3.3}s;animation-delay:-.4s}
@keyframes tw{0%,100%{opacity:1}50%{opacity:${isCalm ? 0.8 : 0.3}}}
@media (prefers-reduced-motion: reduce){.t0,.t1,.t2,.t3{animation:none}}`

// The cache bar's own motion: the whole fill fades in and out as one, slow and soft, so it
// reads as calm next to the progress bar's twinkle. A cache that ran out rests.
// The row is drawn anew every second as the countdown ticks, and a new drawing would start
// the animation over (a blink each second). The delay therefore sets the phase from the
// clock, so every drawing picks the fade up exactly where the last one was.
const BREATHE_MS = 6000
const breatheCss = (isResting: boolean, at: number): string =>
  isResting
    ? ''
    : `.breathe{animation:breathe ${BREATHE_MS / 1000}s ease-in-out infinite;animation-delay:-${((at % BREATHE_MS) / 1000).toFixed(3)}s}
@keyframes breathe{0%,100%{opacity:1}50%{opacity:0.6}}
@media (prefers-reduced-motion: reduce){.breathe{animation:none}}`

// The label riding at the head of the fill, kept inside the bar.
const pillSvg = (text: string, fillW: number, barW: number, barH: number, color: string, bx: (x: number, w: number) => number, rtl: boolean): string => {
  const pillW = Math.round(18 + text.length * 6.6)
  const pillX = bx(Math.max(0, Math.min(barW - pillW, fillW - pillW)), pillW)
  return `<rect x="${pillX}" width="${pillW}" height="${barH}" rx="${barH / 2}" fill="${color}"/>` +
    `<text x="${pillX + pillW / 2}" y="${barH / 2 + 4}" text-anchor="middle"${rtl ? ' direction="rtl"' : ''} font-family="${FONT}" font-size="11" font-weight="600" fill="#ffffff">${xml(text)}</text>`
}

// ---------------------------------------------------------------------------
// The HUD part of the row: the main loop's model and the prompt cache countdown.

type HudView = { model: string; left: number | null; context: number | null; isWorking: boolean }

const hudView = (h: Hud, isWorking: boolean): HudView => ({
  model: h.model ? (h.effort ? `${modelName(h.model)} · ${effortWord(h.effort)}` : modelName(h.model)) : '',
  left: h.secondsLeft,
  // State written before the context bar existed has no reading yet.
  context: h.contextPercent ?? null,
  isWorking,
})

// A bar of the idle row, drawn like the progress bar: a dithered fill `ratio` full in `color`,
// with `text` in the pill at its head. `cls` gives the fill its motion, if any.
const dotBarSvg = (id: string, x: number, w: number, ratio: number, color: string, text: string, cls: string): string => {
  const fillW = Math.round(w * ratio)
  const ltr = (bx: number): number => bx
  return `<defs><clipPath id="${id}"><rect x="0" y="0" width="${w}" height="${BAR_H}" rx="${BAR_H / 2}"/></clipPath></defs>
<g transform="translate(${x},${(H - BAR_H) / 2})">
<rect class="k" width="${w}" height="${BAR_H}" rx="${BAR_H / 2}"/>
<g clip-path="url(#${id})"><g${cls ? ` class="${cls}"` : ''} fill="${color}">${ditherDots(fillW, BAR_H, ltr)}</g></g>
${pillSvg(text, fillW, w, BAR_H, color, ltr, false)}
</g>`
}

// The cache bar drains with the cache's lifetime, in the countdown's colour, with the time
// left in its pill. The fill breathes as one (`breathe`) instead of twinkling pixel by pixel.
const cacheBarSvg = (v: HudView, x: number, w: number, text: string): string =>
  dotBarSvg('cache-clip', x, w, cacheRatio(v.left), cacheColor(v.left, v.isWorking), text, 'breathe')

// The context bar fills with the main session's context window and holds still: it only
// changes between answers, so motion would say nothing.
const contextBarSvg = (v: HudView, x: number, w: number): string =>
  dotBarSvg('context-clip', x, w, contextRatio(v.context), contextColor(v.context), percentText(v.context), '')

// Without a flow the row is the HUD alone: a dot in the countdown's colour, the model,
// the cache bar with the clock in its pill, then the context bar with its percentage.
const idleSvg = (v: HudView, maxW: number, at: number): { w: number; svg: string } => {
  const time = clockText(v.left, tr().expired, tr().cold)
  const color = cacheColor(v.left, v.isWorking)
  const labelW = Math.round(textWidth(tr().cache, 12))
  const ctxLabelW = Math.round(textWidth(tr().context, 12))
  const modelW = v.model ? Math.round(textWidth(v.model, 13)) : 0
  // Both bars split what is left after the labels, so the row spans the window; MIN_BAR each at least.
  const MIN_BAR = 100
  const barsFixed = labelW + 10 + 16 + ctxLabelW + 10
  const showModel = modelW > 0 && maxW >= 16 + modelW + 16 + barsFixed + 2 * MIN_BAR
  let x = 16
  const parts: string[] = [`<circle cx="5" cy="${H / 2}" r="4" fill="${color}"/>`]
  if (showModel) {
    parts.push(`<text class="t" x="${x}" y="${H / 2 + 4.5}" font-family="${FONT}" font-size="13" font-weight="500">${xml(v.model)}</text>`)
    x += modelW + 16
  }
  const barW = Math.max(MIN_BAR, Math.floor((maxW - x - barsFixed - 2) / 2))
  parts.push(`<text class="m" x="${x}" y="${H / 2 + 4}" font-family="${FONT}" font-size="12">${xml(tr().cache)}</text>`)
  x += labelW + 10
  parts.push(cacheBarSvg(v, x, barW, time))
  x += barW + 16
  parts.push(`<text class="m" x="${x}" y="${H / 2 + 4}" font-family="${FONT}" font-size="12">${xml(tr().context)}</text>`)
  x += ctxLabelW + 10
  parts.push(contextBarSvg(v, x, barW))
  const W = x + barW + 2
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<style>
.t{fill:#1f1f1f}.m{fill:#8a8a8a}.k{fill:#e4e4e2}
@media (prefers-color-scheme: dark){.t{fill:#ececec}.m{fill:#9a9a9a}.k{fill:#2c2c2c}}
${breatheCss(v.left === null || v.left === 0, at)}
</style>
${parts.join('')}
</svg>`
  return { w: W, svg }
}

const rowSvg = (f: Flow, W: number, isWorking: boolean): string => {
  // The title takes what it needs, up to 40% of the row; the bar takes the rest.
  const title = fitText(f.title, 13, Math.max(60, W * 0.4))
  const BAR_X = Math.round(16 + textWidth(title, 13) + 12)
  const BAR_W = Math.max(60, W - BAR_X - 46 - CRAB_W)
  // One colour from start to "Done": a finished flow is told by its label, not a new colour.
  const color = ACCENT
  const y0 = (H - BAR_H) / 2
  const fillW = Math.round(BAR_W * ratio(f))
  // Positions are worked out left to right; right to left mirrors each box
  // inside the bar (`bx`) and across the row (`rx`). Text is never mirrored.
  const rtl = isRtl()
  const bx = (x: number, w: number): number => (rtl ? BAR_W - x - w : x)
  const rx = (x: number, w: number): number => (rtl ? W - x - w : x)

  const dots = ditherDots(fillW, BAR_H, bx)

  const ticks: string[] = []
  for (let i = 1; i < f.total; i++) {
    const x = Math.round((BAR_W * i) / f.total)
    if (x > fillW + 4) ticks.push(`<rect x="${bx(x, 1.5)}" y="${BAR_H / 2 - 4}" width="1.5" height="8" rx="0.75"/>`)
  }

  const text = label(f)
  const percent = `${Math.round(ratio(f) * 100)}%`
  // `direction="rtl"` puts Hebrew words and numbers in reading order; `start` is then the right edge.
  const titleAt = rtl ? `x="${W - 16}" direction="rtl" text-anchor="start"` : 'x="16"'
  const percentAt = rtl ? `x="${CRAB_W + 6}" y="${H / 2 + 4.5}"` : `x="${W - CRAB_W - 6}" y="${H / 2 + 4.5}" text-anchor="end"`
  const crabW = CRAB_BOX * 0.8

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<style>
.t{fill:#1f1f1f}.m{fill:#8a8a8a}.k{fill:#e4e4e2}.tk{fill:#b4b4b0}
@media (prefers-color-scheme: dark){.t{fill:#ececec}.m{fill:#9a9a9a}.k{fill:#2c2c2c}.tk{fill:#5a5a5a}}
${twinkleCss(f.isFinished)}
</style>
<defs><clipPath id="c"><rect x="0" y="0" width="${BAR_W}" height="${BAR_H}" rx="${BAR_H / 2}"/></clipPath></defs>
<circle cx="${rtl ? W - 5 : 5}" cy="${H / 2}" r="4" fill="${color}"/>
<text class="t" ${titleAt} y="${H / 2 + 4.5}" font-family="${FONT}" font-size="13" font-weight="500">${xml(title)}</text>
<g transform="translate(${rx(BAR_X, BAR_W)},${y0})">
<rect class="k" width="${BAR_W}" height="${BAR_H}" rx="${BAR_H / 2}"/>
<g clip-path="url(#c)">
<g fill="${color}">${dots}</g>
<g class="tk">${ticks.join('')}</g>
</g>
${pillSvg(text, fillW, BAR_W, BAR_H, color, bx, rtl)}
</g>
<text class="m" ${percentAt} font-family="${FONT}" font-size="12.5" font-variant-numeric="tabular-nums">${percent}</text>
${CRAB_CSS}${crab(rx(W - CRAB_W + 1, crabW), 0, 'other', isWorking, 0.8, rtl)}
</svg>`
}

// A bar as text: full blocks for the part filled, light shade for the rest.
const blocks = (ratio: number, width: number): string => {
  const filled = Math.round(width * ratio)
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled))
}

const barText = (f: Flow, width: number): string => blocks(ratio(f), width)

// ---------------------------------------------------------------------------
// Agents panel: every subagent of the session.

// A run's marks: its type, live dot and progress bar.
const AGENT_COLOR = '#888780'

// "Opus 5.5 · low" for a run, or just the model when no effort was seen.
const runModel = (a: AgentRun): string => (a.effort ? `${modelName(a.model)} · ${effortWord(a.effort)}` : modelName(a.model))

// USD per million tokens: input, output, cache read, cache write. The first row that
// matches a model id wins, so a release sits above its family.
// The engine reports tokens, not money, so the panel's cost is an estimate. It reports
// one cache-write count with no split by lifetime; writes are priced at the 1-hour
// rate (2x input), which is what Claude Code writes on a subscription.
type Price = [input: number, output: number, cacheRead: number, cacheWrite: number]

const PRICES: [RegExp, Price][] = [
  [/(fable|mythos)-5-1/, [10, 50, 0.25, 20]],
  [/fable|mythos/, [10, 50, 1, 20]],
  [/opus-5-5/, [4, 20, 0.2, 8]],
  [/opus/, [5, 25, 0.5, 10]],
  [/sonnet-5-5/, [2, 10, 0.1, 4]],
  [/sonnet-5/, [2, 10, 0.2, 4]],
  [/sonnet/, [3, 15, 0.3, 6]],
  [/haiku-5-5/, [0.1, 0.5, 0.01, 0.2]],
  [/haiku/, [1, 5, 0.1, 2]],
]

// Haiku 5.5 is priced by prompt length: a request whose prompt (input, cache reads and
// cache writes together) is over 100,000 tokens pays these prices instead.
const HAIKU_LONG_PROMPT = 100_000
const HAIKU_LONG: Price = [0.5, 2.5, 0.05, 1]

type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

const priceOf = (model: string, prompt: number): Price => {
  const id = model.toLowerCase()
  if (prompt > HAIKU_LONG_PROMPT && /haiku-5-5/.test(id)) return HAIKU_LONG
  return PRICES.find(([re]) => re.test(id))?.[1] ?? [4, 20, 0.2, 8]
}

// `isRequest` says the usage is one model request, which is what a prompt-length price
// is set by; a turn's sum is priced at the model's ordinary prices.
const costOf = (model: string, u: Usage, isRequest: boolean): number => {
  const prompt = isRequest ? (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) : 0
  const [i, o, r, w] = priceOf(model, prompt)
  return (
    ((u.input_tokens || 0) * i +
      (u.output_tokens || 0) * o +
      (u.cache_read_input_tokens || 0) * r +
      (u.cache_creation_input_tokens || 0) * w) /
    1e6
  )
}

// Haiku 4.5 and the Claude 3 models have a 200K window; the rest, Haiku 5.5 included, 1M.
const windowOf = (model: string): number => (/haiku-4|claude-3/i.test(model) ? 200_000 : 1_000_000)

const modelName = (id: string): string => {
  const m = /(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2})(?!\d))?/i.exec(id)
  const [, family = '', major = '', minor] = m ?? []
  if (!family) return id.replace(/^claude-/, '').replace(/\[.*\]$/, '') || '—'
  return `${family.charAt(0).toUpperCase()}${family.slice(1).toLowerCase()} ${major}${minor ? '.' + minor : ''}`
}

const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

const fmtTokens = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${Math.round(n)}`

const fmtCost = (usd: number): string => `$${usd < 10 ? usd.toFixed(2) : usd.toFixed(1)}`

const fmtTime = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

const elapsed = (a: AgentRun, at: number): number => (a.endedAt ?? Math.max(at, a.startedAt)) - a.startedAt

const totals = (list: AgentRun[], at: number) => {
  const cost = list.reduce((s, a) => s + a.costUsd, 0)
  const tokens = list.reduce((s, a) => s + a.tokens, 0)
  const start = Math.min(...list.map(a => a.startedAt))
  const end = Math.max(...list.map(a => a.endedAt ?? Math.max(at, a.startedAt)))
  return { cost, tokens, time: list.length ? end - start : 0 }
}

// --- desktop drawings: each row is one SVG, as the band above the prompt is.

// The pane's backdrop: a dotted grid as tall as the content laid over it; the
// row SVGs are transparent, so it shows through between their marks.
const GRID_STEP = 16
// A Text or Button row on the desktop is about 20px; the grid errs taller.
const LINE_H = 24
// The engine refuses an Svg taller than 4096px, so a long grid is stacked from
// tiles of at most this height; a multiple of GRID_STEP keeps the dots aligned.
const GRID_TILE = 4096
const gridTiles = (H: number) => Array.from({ length: Math.ceil(H / GRID_TILE) }, (_, i) => Math.min(GRID_TILE, H - i * GRID_TILE))
const gridSvg = (W: number, H: number) => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<style>.d{fill:#d9d8d4}@media (prefers-color-scheme: dark){.d{fill:#3a3a38}}</style>
<defs><pattern id="g" width="${GRID_STEP}" height="${GRID_STEP}" patternUnits="userSpaceOnUse"><circle class="d" cx="${GRID_STEP / 2}" cy="${GRID_STEP / 2}" r="1"/></pattern></defs>
<rect width="${W}" height="${H}" fill="url(#g)"/>
</svg>`

const PANE_CSS = `<style>
.t{fill:#1f1f1f}.s{fill:#6b6b68}.m{fill:#9a9a96}.k{fill:#ecebe8}.ln{stroke:#e4e4e1}.tile{fill:#f4f3f0}
@media (prefers-color-scheme: dark){.t{fill:#ececec}.s{fill:#a8a8a4}.m{fill:#7d7d79}.k{fill:#2c2c2b}.ln{stroke:#333331}.tile{fill:#262625}}
.live{animation:p 1.6s ease-in-out infinite}@keyframes p{50%{opacity:.3}}
@media (prefers-reduced-motion: reduce){.live{animation:none}}
</style>`

// Pixel Clawd from DockCrab (Clawdy): a 24×18 crab on a 30×28 grid in the brand clay;
// an Explore agent wears a pirate costume.
const CLAY = '#D97757'
const INK = '#1F1E1D'

// `cls` puts a pixel in a named group: `bd` (the default) is the body and its
// costume, `la`/`lb` the leg pairs, anything else a prop with its own motion.
type Fill = (x: number, y: number, w: number, h: number, c: string, cls?: string) => void

const stamp = (f: Fill, x: number, y: number, rows: string[], map: Record<string, string>, cls?: string): void =>
  rows.forEach((row, dy) => [...row].forEach((ch, dx) => map[ch] && f(x + dx, y + dy, 1, 1, map[ch] ?? '', cls)))

const crabBody = (f: Fill): void => {
  f(7, 10, 16, 12, CLAY)
  f(3, 14, 4, 4, CLAY)
  f(23, 14, 4, 4, CLAY)
  f(9, 12, 2, 2, INK)
  f(19, 12, 2, 2, INK)
  f(7, 22, 2, 4, CLAY, 'la')
  f(17, 22, 2, 4, CLAY, 'la')
  f(11, 22, 2, 4, CLAY, 'lb')
  f(21, 22, 2, 4, CLAY, 'lb')
}

// Pure CSS, run by the compositor: no redraws. Periods divide one second, so the
// once-a-second redraw of a running row restarts them in phase. Every crab walks;
// a costume adds its prop's own motion on top.
const CRAB_CSS = `<style>
.run .la{animation:st .5s steps(1) infinite}.run .lb{animation:st .5s steps(1) infinite -.25s}
.run .bd{animation:bob .5s steps(1) infinite -.125s}
.run g{transform-box:fill-box}
@keyframes st{50%{transform:translateY(-1px)}}@keyframes bob{50%{transform:translateY(1px)}}
.c-explore.run .it{transform-origin:50% 100%;animation:fence .5s ease-in-out infinite}
@keyframes fence{50%{transform:rotate(25deg)}}
@media (prefers-reduced-motion: reduce){.run,.run g{animation:none!important}}
</style>`

const COSTUMES: Record<string, (f: Fill) => void> = {
  // Explore: pirate scouting the code; the cutlass fences.
  explore: f => {
    crabBody(f)
    stamp(f, 5, 3, ['.kk..............kk.', '.kkk....kkkk....kkk.', '..kkkkkkkwwkkkkkkk..', '..kkkkkkkkkkkkkkkk..', '.gggggggggggggggggg.'], { k: '#55514C', w: '#F8F6F1', g: '#F5C542' })
    f(7, 11, 11, 1, INK); f(18, 11, 4, 3, INK)
    f(27, 6, 1, 9, '#C9CCD2', 'it'); f(26, 15, 3, 1, '#7A4A26', 'it')
  },
  other: f => crabBody(f),
}

const costumeOf = (type: string): string => (type === 'Explore' ? 'explore' : 'other')

const CRAB_SCALE = 1.1

// Body and props nest inside `bd` so a prop rides the bob and adds its own motion;
// legs stay outside it and step on their own. `mirror` flips the crab inside its
// own box (x .. x + CRAB_BOX * scale) so it faces left.
const crab = (x: number, y: number, costume: string, isWalking = false, scale = CRAB_SCALE, mirror = false): string => {
  const groups = new Map<string, string[]>([['bd', []]])
  const f: Fill = (cx, cy, w, h, c, cls = 'bd') => {
    if (!groups.has(cls)) groups.set(cls, [])
    groups.get(cls)?.push(`<rect x="${cx}" y="${cy}" width="${w}" height="${h}" fill="${c}"/>`)
  }
  const draw = COSTUMES[costume] ?? crabBody
  draw(f)
  const group = (cls: string) => `<g class="${cls}">${(groups.get(cls) ?? []).join('')}</g>`
  const props = [...groups.keys()].filter(k => k !== 'bd' && k !== 'la' && k !== 'lb')
  const body = `<g class="bd">${(groups.get('bd') ?? []).join('')}${props.map(group).join('')}</g>`
  const place = mirror ? `translate(${x + CRAB_BOX * scale},${y}) scale(${-scale},${scale})` : `translate(${x},${y}) scale(${scale})`
  return `<g transform="${place}" shape-rendering="crispEdges"><g class="c-${costume}${isWalking ? ' run' : ''}">${body}${group('la')}${group('lb')}</g></g>`
}

const statusMark = (x: number, y: number, status: string, color: string): string => {
  if (status === 'running') return `<circle class="live" cx="${x}" cy="${y}" r="3.5" fill="${color}"/>`
  if (status === 'done') return `<path d="M${x - 5} ${y}l3.5 3.5 6.5-7" fill="none" stroke="#3B9C5F" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`
  return `<path d="M${x - 4} ${y - 4}l8 8M${x + 4} ${y - 4}l-8 8" stroke="#D0453F" stroke-width="1.8" stroke-linecap="round"/>`
}

// Panel rows are laid out left to right; in Hebrew each box mirrors across the
// row (`mx`) and text hugs the mirrored side. `words` text may hold Hebrew and
// takes `direction="rtl"` (whose `start` is the right edge); numbers stay
// left to right so "≈$0.25" keeps its order.
const mx = (W: number, x: number, w = 0): number => (isRtl() ? W - x - w : x)

// Text that starts at x: left-aligned, or right-aligned at the mirrored x.
const startText = (W: number, x: number, y: number, words = true): string =>
  !isRtl()
    ? `x="${x}" y="${y}"`
    : `x="${W - x}" y="${y}"${words ? ' direction="rtl" text-anchor="start"' : ' text-anchor="end"'}`

// Text that ends at x: right-aligned, or left-aligned at the mirrored x.
const endText = (W: number, x: number, y: number, words = false): string =>
  !isRtl() ? `x="${x}" y="${y}" text-anchor="end"` : `x="${W - x}" y="${y}"${words ? ' direction="rtl" text-anchor="end"' : ''}`

const crabWidth = (scale: number): number => Math.round(CRAB_BOX * scale * 100) / 100

// A panel crab at x in a row of width W: on the mirrored side and facing left in Hebrew.
const rowCrab = (W: number, x: number, y: number, costume: string, isWalking = false): string =>
  crab(mx(W, x, crabWidth(CRAB_SCALE)), y, costume, isWalking, CRAB_SCALE, isRtl())

const svg = (W: number, H: number, body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${PANE_CSS}${CRAB_CSS}${body}</svg>`

// The pane's own title already says "Agents": the header names the flow, if any.
const headerSvg = (W: number, title: string, t: ReturnType<typeof totals>): string => {
  const s = tr()
  const gap = 6
  const tw = (W - gap * 2) / 3
  const top = title ? 28 : 0
  const tile = (i: number, k: string, v: string) =>
    `<rect class="tile" x="${mx(W, i * (tw + gap), tw)}" y="${top}" width="${tw}" height="40" rx="8"/>
<text class="s" ${startText(W, i * (tw + gap) + 9, top + 16)} font-family="${FONT}" font-size="11">${k}</text>
<text class="t" ${startText(W, i * (tw + gap) + 9, top + 33, false)} font-family="${FONT}" font-size="15" font-weight="600" font-variant-numeric="tabular-nums">${v}</text>`
  return svg(
    W,
    headerHeight(title),
    `${title ? `<text class="t" ${startText(W, 0, 15)} font-family="${FONT}" font-size="14" font-weight="600">${xml(fitText(title, 14, W))}</text>` : ''}
${tile(0, s.cost, '≈' + fmtCost(t.cost))}${tile(1, s.tokens, fmtTokens(t.tokens))}${tile(2, s.time, fmtTime(t.time))}`,
  )
}

const headerHeight = (title: string): number => (title ? 72 : 44)

// A finished run is full; one still at work, or failed, shows its context instead.
const progressOf = (a: AgentRun): number | null => (a.status === 'done' ? 1 : null)

const ctxOf = (a: AgentRun): number => (a.contextMax ? Math.min(100, Math.round((a.contextTokens / a.contextMax) * 100)) : 0)

const agentSvg = (W: number, a: AgentRun, at: number): string => {
  const s = tr()
  const color = AGENT_COLOR
  const ctx = ctxOf(a)
  const textW = W - 42 - 22
  const meta = [runModel(a)]
  if (a.round > 1) meta.push(`${s.round} ${a.round}`)
  if (a.status === 'failed') meta.push(s.failed)
  const barW = textW
  const progress = progressOf(a)
  const stats = `${s.ctx} ${ctx}% · ${fmtTokens(a.contextTokens)}  ≈${fmtCost(a.costUsd)}  ${fmtTime(elapsed(a, at))}`
  // Until the run is done the bar shows its context, drawn grey.
  const fillW = Math.round(barW * (progress ?? ctx / 100))
  return svg(
    W,
    66,
    `${rowCrab(W, 0, 14, costumeOf(a.type), a.status === 'running')}
<text class="t" ${startText(W, 42, 18)} font-family="${FONT}" font-size="13" font-weight="600">${xml(fitText(a.description || a.type, 13, textW))}</text>
<text ${startText(W, 42, 34)} font-family="${FONT}" font-size="11"><tspan fill="${color}">${xml(a.type)}</tspan><tspan class="s">  ${xml(meta.join('  ·  '))}</tspan></text>
<text class="s" ${endText(W, 42 + barW, 49, true)} font-family="${FONT}" font-size="11" font-variant-numeric="tabular-nums">${stats}</text>
<rect class="k" x="${mx(W, 42, barW)}" y="55" width="${barW}" height="4" rx="2"/><rect${progress === null ? ' class="m"' : ''} x="${mx(W, 42, fillW)}" y="55" width="${fillW}" height="4" rx="2"${progress === null ? '' : ` fill="${color}"`}/>
${statusMark(mx(W, W - 8), 16, a.status, color)}
<line class="ln" x1="0" y1="65.5" x2="${W}" y2="65.5"/>`,
  )
}

const compactSvg = (W: number, list: AgentRun[], t: ReturnType<typeof totals>): string => {
  const icons = [...list.filter(a => a.status === 'running'), ...list.filter(a => a.status !== 'running')].map(a => ({ k: costumeOf(a.type), s: a.status }))
  const fit = Math.max(1, Math.floor((W - 150) / 36))
  const shown = icons.slice(0, fit)
  const more = icons.length - shown.length
  const body = shown
    .map((ic, i) => rowCrab(W, i * 36, 0, ic.k, ic.s === 'running') + (ic.s === 'running' ? `<circle class="live" cx="${mx(W, i * 36 + 32)}" cy="4" r="3" fill="${AGENT_COLOR}"/>` : ''))
    .join('')
  const x = shown.length * 36 + (more ? 4 : 0)
  return svg(
    W,
    32,
    `${body}${more ? `<text class="s" ${startText(W, x, 21, false)} font-family="${FONT}" font-size="12">+${more}</text>` : ''}
<text class="s" ${endText(W, W, 21)} font-family="${FONT}" font-size="12" font-variant-numeric="tabular-nums">≈${fmtCost(t.cost)} · ${fmtTokens(t.tokens)} · ${fmtTime(t.time)}</text>`,
  )
}

// --- terminal drawing: the same rows in text.

const ctxBar = (pct: number, width: number): string => {
  const filled = Math.round((width * pct) / 100)
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled))
}

const STATUS_GLYPH: Record<string, string> = { running: '●', done: '✓', failed: '✗' }

// Opens the agents pane, or closes it when it is up; true when it ends up open. A pane
// opened unasked on a narrow terminal waits undrawn: it counts as shut, so this opens it.
async function togglePane($: EngineInterface): Promise<boolean> {
  const pane = (await $.ui.panes()).find(p => p.id === PANE)
  if (pane?.isPlaced) {
    await $.ui.close({ id: PANE })
    return false
  }
  const at = await $.clock.now()
  await update($, now, () => at)
  const opened = await $.ui.open({ id: PANE, title: tr().pane, rows: 12 })
  // Still undrawn although asked: no surface here places panes. A press then closes the waiting one.
  if (pane && !opened.isPlaced) {
    await $.ui.close({ id: PANE })
    return false
  }
  return true
}

async function autoOpen($: EngineInterface, key: string): Promise<void> {
  // Decided inside `update`: subagents spawned at once would each read the panel as not yet opened.
  let isFirst = false
  await update($, panel, prev => {
    isFirst = prev.autoOpenedFor !== key
    return isFirst ? { ...prev, autoOpenedFor: key } : prev
  })
  if (!isFirst) return
  // Opened unasked, the pane waits undrawn on a terminal narrower than 144 columns: say how to open it.
  const opened = await $.ui.open({ id: PANE, title: tr().pane, rows: 12 })
  // Only for the column floor: on a surface that places no panes, or with none attached, a wider terminal changes nothing.
  if (!opened.isPlaced && /column/i.test(opened.reason)) $.ui.toast(tr().paneWaits)
}

export const register: Register = (on, options) => {
  // When the agents panel opens on its own; `subagent` unless the option says otherwise.
  const openMode = options.autoOpen === 'session' || options.autoOpen === 'off' ? options.autoOpen : 'subagent'
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    lang = await detectLang($, options.language)
    await $.command.register({
      name: 'agents-info',
      description: 'Show or hide the panel of subagents: running and finished, with model, context, cost and time',
    })
    await $.command.register({
      name: 'hud',
      description: 'Show or hide the HUD above the prompt; `demo <minutes>` previews the cache countdown',
    })
    try {
      await noteModel($, await $.session.model(), undefined)
    } catch {
      // No model yet: the first request names it.
    }
    await noteContext($)
    if (openMode === 'session') await autoOpen($, 'session')
    $.clock.every(1000, () => {
      void tickCache($)
      void dropFinishedFlow($)
    })

    // Ticks the running agents' clocks; quiet when nothing runs.
    $.clock.every(1000, () => {
      void (async () => {
        const list = await read($, agents)
        if (!list.some(a => a.status === 'running')) return
        const at = await $.clock.now()
        await update($, now, () => at)
      })()
    })
    return started
  })

  on('command.run', { command: 'agents-info' }, async ($, e) => {
    // `/agents-info open` opens the panel, or brings it forward from behind another tab, without toggling it.
    if ((e.args ?? '').trim() === 'open') {
      const at = await $.clock.now()
      await update($, now, () => at)
      await $.ui.open({ id: PANE, title: tr().pane, rows: 12 })
      return { text: tr().opened }
    }
    const isOpen = await togglePane($)
    return { text: isOpen ? tr().opened : tr().closed }
  })

  // A pane opened unasked on a narrow terminal waits undrawn. The person's next prompt
  // answers them: an open made then is placed at any width. Only their own Enter counts;
  // a slash command answers for itself, and a hidden prompt or one from a peer is no gesture of theirs.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'composer' && !e.command && !e.isMeta) {
      try {
        const pane = (await $.ui.panes()).find(p => p.id === PANE)
        if (pane && !pane.isPlaced) {
          const at = await $.clock.now()
          await update($, now, () => at)
          await $.ui.open({ id: PANE, title: tr().pane, rows: 12 })
        }
      } catch {
        // The panel is a convenience: the prompt goes on whatever became of it.
      }
    }
    return next(e)
  })

  on('command.run', { command: 'hud' }, async ($, e) => {
    // `/hud demo <minutes>` fakes the cache deadline; the next answer restarts it.
    const demo = (e.args ?? '').trim().match(/^demo\s+(\d+(?:\.\d+)?)$/)
    if (demo) {
      await fakeCache($, Math.round(Number(demo[1]) * 60))
      await update($, isHidden, () => false)
      return { text: tr().demo.replace('{m}', demo[1] ?? '') }
    }
    const hidden = await update($, isHidden, h => !h)
    return { text: hidden ? tr().hudHidden : tr().hudShown }
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.deny !== undefined) return started

    const at = await $.clock.now()
    await update($, agents, list => {
      const round = 1 + list.filter(a => norm(a.description) === norm(e.description) && e.description).length
      const run: AgentRun = {
        id: started.agentId ?? e.tool_use_id,
        agentId: started.agentId,
        type: e.subagentType,
        description: e.description,
        model: started.model,
        status: 'running',
        startedAt: at,
        contextTokens: 0,
        contextMax: windowOf(started.model),
        tokens: 0,
        costUsd: 0,
        steps: 0,
        round,
      }
      return [...list.filter(a => a.id !== run.id), run].slice(-200)
    })
    await update($, now, () => at)
    // A subagent of the main session: counted in the batch flow.
    if (!e.parentAgentId && started.agentId) await batchStarted($, started.agentId, tr().subagents)
    // With `subagent` the first subagent of the session opens the panel; after that it is /agents-info's.
    if (openMode === 'subagent') await autoOpen($, 'any-agent')
    return started
  })

  // Each model request of a subagent: live context, tokens and cost.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const agentId = e.agentId
    const usage = result.usage
    if (!agentId) {
      // A main-session request: it ran on this model and left the cache warm.
      await noteModel($, usage?.model || e.model, e.effort)
      await restartCache($)
      await noteContext($)
      return result
    }
    if (!usage) return result

    const model = usage.model || e.model
    await update($, agents, list =>
      list.map((a): AgentRun =>
        a.agentId !== agentId
          ? a
          : {
              ...a,
              model,
              effort: typeof e.effort === 'string' ? e.effort : a.effort,
              status: 'running',
              endedAt: undefined,
              contextTokens:
                (usage.input_tokens || 0) +
                (usage.cache_read_input_tokens || 0) +
                (usage.cache_creation_input_tokens || 0) +
                (usage.output_tokens || 0),
              contextMax: windowOf(model),
              tokens:
                a.tokens +
                (usage.input_tokens || 0) +
                (usage.output_tokens || 0) +
                (usage.cache_read_input_tokens || 0) +
                (usage.cache_creation_input_tokens || 0),
              costUsd: a.costUsd + costOf(model, usage, true),
              steps: a.steps + 1,
            },
      ),
    )
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const agentId = e.agentId
    if (agentId) {
      const at = await $.clock.now()
      await update($, agents, list =>
        list.map((a): AgentRun => {
          if (a.agentId !== agentId) return a
          // A run whose steps went unseen still gets the turn's own sum.
          const fallback = a.steps === 0 && e.usage
          return {
            ...a,
            status: e.reason === 'answer' ? 'done' : 'failed',
            endedAt: at,
            ...(fallback && e.usage
              ? {
                  model: e.usage.model || a.model,
                  tokens:
                    e.usage.input_tokens +
                    e.usage.output_tokens +
                    e.usage.cache_read_input_tokens +
                    e.usage.cache_creation_input_tokens,
                  costUsd: costOf(e.usage.model || a.model, e.usage, false),
                }
              : {}),
          }
        }),
      )
      await update($, now, () => at)
      await batchEnded($, agentId)
    } else {
      await restartCache($)
      await noteContext($)
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const s = tr()
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const list = await read($, agents)
    const f = await read($, flow)
    const p: Panel = await read($, panel)
    const at = Math.max(await read($, now), ...list.map(a => a.startedAt), 0)

    const running = list.filter(a => a.status === 'running').reverse()
    const finished = list.filter(a => a.status !== 'running').reverse()
    const t = totals(list, at)
    // The pane's title says "Agents"; inside, only the flow's own name.
    const title = f && !f.isFinished ? f.title : ''

    const toggleCompact = (
      <Button
        key="compact"
        label={p.isCompact ? s.expand : s.collapse}
        plain
        onPress={() => update($, panel, prev => ({ ...prev, isCompact: !prev.isCompact }))}
      />
    )
    const toggleDone = (
      <Button
        key="done"
        label={`${p.isDoneCollapsed ? (isRtl() ? '◂' : '▸') : '▾'} ${s.finished} · ${finished.length}`}
        plain
        onPress={() => update($, panel, prev => ({ ...prev, isDoneCollapsed: !prev.isDoneCollapsed }))}
      />
    )
    const isEmpty = list.length === 0
    const summary = `≈${fmtCost(t.cost)}, ${fmtTokens(t.tokens)} ${s.tokensWord}, ${fmtTime(t.time)}`

    if (e.surface === 'desktop' && 'Svg' in ui) {
      const { Svg } = ui
      const W = Math.max(240, Math.min(900, (e.props.bodyColumns || 40) * 8 - 8))
      const section = (key: string, text: string) => (
        <Text key={key} dimColor>
          {text}
        </Text>
      )

      // In Hebrew the column hugs the right edge: section heads and buttons right-aligned.
      const align = isRtl() ? 'flex-end' : undefined
      if (p.isCompact) {
        return (
          <Box flexDirection="column" gap={1} alignItems={align}>
            <Svg source={compactSvg(W, list, t)} alt={`${list.length} ${s.agentsCount}, ${summary}`} width={W} height={32} />
            {toggleCompact}
          </Box>
        )
      }
      const shownDone = p.isDoneCollapsed ? 0 : finished.length
      const lines = 1 + (isEmpty ? 1 : 0) + (running.length > 0 ? 1 : 0) + (finished.length > 0 ? 1 : 0)
      const gridH = headerHeight(title) + lines * LINE_H + (running.length + shownDone) * 66
      return (
        <Box flexDirection="column">
          {/* The grid sizes the pane; the content is placed over it, as an
              absolute Box paints over the siblings before it. */}
          {gridTiles(gridH).map((tileH, i) => (
            <Svg key={`grid-${i}`} source={gridSvg(W, tileH)} alt="dotted grid" width={W} height={tileH} />
          ))}
          <Box flexDirection="column" position="absolute" top={0} left={0} right={0} alignItems={align}>
            <Svg source={headerSvg(W, title, t)} alt={title ? `${title}: ${summary}` : summary} width={W} height={headerHeight(title)} />
            {toggleCompact}
            {isEmpty && <Text dimColor>{s.empty}</Text>}
            {running.length > 0 && section('h-run', `${s.running} · ${running.length}`)}
            {running.map(a => (
              <Svg key={a.id} source={agentSvg(W, a, at)} alt={`${a.description}: ${modelName(a.model)}, ${s.isRunning}`} width={W} height={66} />
            ))}
            {finished.length > 0 && toggleDone}
            {!p.isDoneCollapsed &&
              finished.map(a => (
                <Svg key={a.id} source={agentSvg(W, a, at)} alt={`${a.description}: ${modelName(a.model)}, ${s.isFinished}`} width={W} height={66} />
              ))}
          </Box>
        </Box>
      )
    }

    // Terminal: the same content in text rows.
    const cols = Math.max(24, e.props.bodyColumns || 40)
    const barW = Math.max(6, Math.min(20, cols - 34))
    const row = (a: AgentRun) => {
      const color = AGENT_COLOR
      const ctx = ctxOf(a)
      const progress = progressOf(a)
      const model = runModel(a)
      return (
        <Box key={a.id} flexDirection="column" marginBottom={1}>
          <Box flexDirection="row" gap={1}>
            <Text color={color}>▣</Text>
            <Text bold wrap="truncate-end">
              {a.description || a.type}
            </Text>
            <Text color={a.status === 'failed' ? 'red' : a.status === 'done' ? 'green' : color}>{STATUS_GLYPH[a.status]}</Text>
          </Box>
          <Text dimColor wrap="truncate-end">
            {'  '}
            {a.type} · {model}
            {a.round > 1 ? ` · ${s.round} ${a.round}` : ''}
          </Text>
          <Text wrap="truncate-end">
            {'  '}
            {progress === null ? <Text dimColor>{ctxBar(ctx, barW)}</Text> : <Text color={color}>{ctxBar(progress * 100, barW)}</Text>}
            <Text dimColor>
              {' '}
              {s.ctx} {ctx}% · {fmtTokens(a.contextTokens)} ≈{fmtCost(a.costUsd)} {fmtTime(elapsed(a, at))}
            </Text>
          </Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold wrap="truncate-end">
            {title}
          </Text>
          {toggleCompact}
        </Box>
        <Text dimColor>
          ≈{fmtCost(t.cost)} · {fmtTokens(t.tokens)} {s.tokensWord} · {fmtTime(t.time)}
        </Text>
        {p.isCompact ? (
          <Text wrap="truncate-end">
            {[...running, ...finished].map(a => (
              <Text key={a.id} color={AGENT_COLOR}>
                {STATUS_GLYPH[a.status]}{' '}
              </Text>
            ))}
          </Text>
        ) : (
          <Box flexDirection="column" marginTop={1}>
            {isEmpty && <Text dimColor>{s.empty}</Text>}
            {running.length > 0 && <Text dimColor>{s.running} · {running.length}</Text>}
            {running.map(row)}
            {finished.length > 0 && toggleDone}
            {!p.isDoneCollapsed && finished.map(row)}
          </Box>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isHidden))) return next(e)
    const f = await read($, flow)
    const v = hudView(await read($, hud), e.props.isWorking)
    // Draw this row with the other mods' bands beneath it. Claude Code's own placeholder ({ type: 'engine' }) is
    // never nested: the desktop drops a band that nests it.
    const drawn = await Promise.resolve(next(e)).catch(() => null)
    const below = drawn && typeof drawn === 'object' && (drawn as { type?: string }).type !== 'engine' ? drawn : null

    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const cols = e.props.bodyColumns || 100
    const tone = cacheColor(v.left, v.isWorking)
    const isDesktop = e.surface !== 'terminal' && 'Svg' in ui

    // No flow: the HUD alone. While something runs the row shows its progress only.
    if (f === null) {
      if (isDesktop) {
        const { Svg } = ui
        const row = idleSvg(v, Math.max(180, Math.min(1600, cols * 8 - 40)), await $.clock.now())
        const alt = `${v.model ? v.model + ', ' : ''}${tr().cache} ${clockText(v.left, tr().expired, tr().cold)}, ${tr().context} ${percentText(v.context)}`
        return (
          <Box flexDirection="column">
            <Svg source={row.svg} alt={alt} width={row.w} height={H} />
            {below}
          </Box>
        )
      }
      // Both bars split what the model, the labels and the figures leave, so the row spans
      // the band. The figures keep a fixed slot: "—" turning into "58:41" moves no bar.
      const showModel = v.model !== '' && cols >= 60
      const clockW = Math.max(5, tr().expired.length)
      const pctW = 4
      const fixed = (showModel ? v.model.length + 2 : 0) + tr().cache.length + clockW + 2 + tr().context.length + pctW + 4
      const barW = Math.max(6, Math.floor((cols - fixed) / 2))
      const ctxTone = contextColor(v.context)
      // The line above sets the row off from the turn's last line; the gap below is the prompt's own.
      return (
        <Box flexDirection="column" marginTop={1}>
          <Box flexDirection="row" gap={2}>
            {showModel ? <Text bold>{v.model}</Text> : null}
            <Box flexDirection="row" gap={1}>
              <Text dimColor>{tr().cache}</Text>
              <Text color={tone}>{blocks(cacheRatio(v.left), barW)}</Text>
              <Box width={clockW} flexShrink={0}>
                <Text color={tone}>{clockText(v.left, tr().expired, tr().cold)}</Text>
              </Box>
            </Box>
            <Box flexDirection="row" gap={1}>
              <Text dimColor>{tr().context}</Text>
              <Text color={ctxTone}>{blocks(contextRatio(v.context), barW)}</Text>
              <Box width={pctW} flexShrink={0}>
                <Text color={ctxTone}>{percentText(v.context)}</Text>
              </Box>
            </Box>
          </Box>
          {below}
        </Box>
      )
    }

    const list = await read($, agents)
    const crew = list.length
    const isWorking = list.some(a => a.status === 'running')
    const crewButton = (
      <Button key="code-visor-agents" label={`×${crew}`} plain onPress={() => void togglePane($)} />
    )
    const percent = `${Math.round(ratio(f) * 100)}%`
    const dismiss = (
      <Button
        key="code-visor-dismiss"
        label="✕"
        plain
        role="dismiss"
        onPress={() => update($, flow, () => null)}
      />
    )

    // The terminal's element table is completed with an `Svg` that draws nothing: test the surface too.
    if (isDesktop) {
      const { Svg } = ui
      // About 8 CSS px per reported column; the rest is the count, the dismiss
      // and their gaps. No floor above the slot: a row wider than it would wrap.
      const width = Math.max(180, Math.min(1600, cols * 8 - 96))
      return (
        <Box flexDirection="column">
          <Box flexDirection={isRtl() ? 'row-reverse' : 'row'} alignItems="center" gap={1}>
            <Svg source={rowSvg(f, width, isWorking)} alt={`${f.title}: ${label(f)}, ${percent}`} width={width} height={H} />
            {crewButton}
            {dismiss}
          </Box>
          {below}
        </Box>
      )
    }

    const titleW = Math.max(8, Math.min(30, f.title.length + 2, Math.floor(cols / 3)))
    const width = Math.max(6, Math.min(40, cols - titleW - 32))
    return (
      <Box flexDirection="column" marginTop={1}>
        <Box flexDirection="row" gap={2}>
          <Box width={titleW} flexShrink={0}>
            <Text color={ACCENT}>● </Text>
            <Text wrap="truncate-end">{f.title}</Text>
          </Box>
          <Text color={ACCENT}>{barText(f, width)}</Text>
          <Text bold>{label(f)}</Text>
          <Text dimColor>{percent}</Text>
          <Text color={CLAY}>▣</Text>
          {crewButton}
          {dismiss}
        </Box>
        {below}
      </Box>
    )
  })
}
