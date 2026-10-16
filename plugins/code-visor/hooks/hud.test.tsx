import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const PLUGIN = 'code-visor'
const band = { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 120, scroll: { offset: 0, bodyRows: 4 }, view: {} }
const CACHE = '#4fb3a9'
const WARN = '#e2a94e'
const ALERT = '#e0846b'
const MIN = 60 * 1000
const CONTEXT = '#6f9fd8'

// What `$.session.usage()` reports as the main session's context fill; set by a test before an answer.
const usage: { percent?: number } = {}

async function session($: Engine, on: On) {
  const clock = mock.clock(on, { now: Date.parse('2026-10-15T10:00:00Z') })
  mock.env(on, { LANG: 'en_US.UTF-8' })
  on('settings.read', async () => ({ value: {} }) as never)
  on('session.model', async () => ({ value: 'claude-opus-5-5' }) as never)
  delete usage.percent
  on('session.usage', async () => ({ value: { startedAt: 0, context: { window: 1_000_000, percent: usage.percent }, rateLimits: [] } }) as never)
  on('session.start', async () => ({ cwd: '/repo' }) as never)
  on('command.register', async () => ({ value: undefined }) as never)
  // Nothing else draws above the prompt: a hidden row leaves it empty.
  on('ui.render', async () => ({ type: 'engine' }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  let n = 0
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: `b${++n}` }))
  on('turn.complete', () => ({ text: '' }) as never)
  on('turn.step', async function* () {
    return { turnId: 'turn', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as never
  })
  await $.session.start({ source: 'startup', cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
  return clock
}

// One request of the main session, on Opus 5.5 at high effort.
async function answer($: Engine) {
  const stream = ($.turn.step as (e: unknown) => AsyncIterable<unknown>)({ turnId: 'turn', index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 1 })
  for await (const _ of stream) void _
}

// The main session starts `n` subagents, b1 to bn: a batch titled "Subagents".
async function spawn($: Engine, n: number) {
  for (let i = 0; i < n; i++) {
    await $.agent.spawn({ tool_use_id: `t${i}`, prompt: 'p', description: 'Look', subagentType: 'Explore', provider: 'engine', parentModel: 'claude-opus-5-5', background: false, fork: false } as never)
  }
}

// Subagents b1 to bn end.
async function finish($: Engine, n: number) {
  for (let i = 1; i <= n; i++) await $.turn.complete({ agentId: `b${i}`, reason: 'answer', turnId: 'x' } as never)
}

const exactly = (s: string) => new RegExp(`^${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)

// Whether the row draws `text`: in the Svg source on the desktop, as a Text of its own on the terminal.
async function shows($: Engine, surface: 'terminal' | 'desktop', text: string): Promise<boolean> {
  const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: band })
  const found =
    surface === 'desktop'
      ? (await ui.findAll({ type: 'Svg' })).some(el => String(el.props.source).includes(xmlText(text)))
      : (await ui.find({ type: 'Text', text: exactly(text) })) !== undefined
  await ui.unmount()
  return found
}

const xmlText = (s: string) => `>${s}</text>`

// The pill at the head of a bar: a rect in `color`, then its text.
const pill = (text: string, color: string) => new RegExp(`fill="${color}"/><text[^>]*>${text}</text>`)

// The colour a figure is drawn in: in its pill on the desktop, on its own Text on the terminal.
async function showsFigure($: Engine, surface: 'terminal' | 'desktop', text: string, color: string) {
  const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: band })
  if (surface === 'desktop') {
    const svg = (await ui.findAll({ type: 'Svg' })).map(el => String(el.props.source)).join('')
    expect(svg).toMatch(pill(text, color))
  } else {
    const el = await ui.find({ type: 'Text', text: exactly(text) })
    expect((el?.props as { color?: string } | undefined)?.color).toBe(color)
  }
  await ui.unmount()
}

// The colour the countdown is drawn in: the fill on the time's text on the desktop, the time's Text on the terminal.
async function showsTime($: Engine, surface: 'terminal' | 'desktop', time: string, color: string) {
  const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: band })
  if (surface === 'desktop') {
    const svg = (await ui.findAll({ type: 'Svg' })).map(el => String(el.props.source)).join('')
    // The time rides in the pill, which is drawn in the countdown's colour.
    expect(svg).toMatch(pill(time, color))
  } else {
    const el = await ui.find({ type: 'Text', text: exactly(time) })
    expect((el?.props as { color?: string } | undefined)?.color).toBe(color)
  }
  await ui.unmount()
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: before the first answer the row shows the model and a cold cache`, async ($, on) => {
    await session($, on)
    expect(await shows($, surface, 'Opus 5.5')).toBe(true)
    expect(await shows($, surface, 'Cache')).toBe(true)
    // A cache with no answer behind it reads "cold", in grey, rather than a dash.
    await showsTime($, surface, 'cold', '#8a8a8a')
  })

  test(`${surface}: an answer starts the countdown, which turns amber, then red, then runs out`, async ($, on) => {
    const clock = await session($, on)
    await answer($)
    await showsTime($, surface, '60:00', CACHE)
    expect(await shows($, surface, 'Opus 5.5 · high')).toBe(true)

    await clock.advance(41 * MIN)
    await showsTime($, surface, '19:00', WARN)
    await clock.advance(10 * MIN)
    await showsTime($, surface, '09:00', ALERT)
    await clock.advance(9 * MIN)
    await showsTime($, surface, 'expired', '#8a8a8a')
  })

  test(`${surface}: the context bar sits beside the cache, empty before the first answer`, async ($, on) => {
    await session($, on)
    expect(await shows($, surface, 'Context')).toBe(true)
    await showsFigure($, surface, '—', '#8a8a8a')
  })

  test(`${surface}: each answer reads the context fill, which turns amber from 70 % and red from 85 %`, async ($, on) => {
    await session($, on)
    usage.percent = 42
    await answer($)
    await showsFigure($, surface, '42%', CONTEXT)
    usage.percent = 74
    await answer($)
    await showsFigure($, surface, '74%', WARN)
    usage.percent = 91
    await $.turn.complete({ reason: 'answer', turnId: 'x' } as never)
    await showsFigure($, surface, '91%', ALERT)
  })

  test(`${surface}: /hud hides and shows the row, demo fakes the deadline`, async ($, on) => {
    await session($, on)
    expect(await $.command.run({ command: 'hud' } as never)).toMatchObject({ text: 'HUD hidden.' })
    // Hidden, the plugin hands the band on and nothing beneath it draws.
    let error = ''
    try {
      await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: band })
    } catch (err) {
      error = String(err)
    }
    expect(error).toContain('drew nothing')

    expect(await $.command.run({ command: 'hud', args: 'demo 8' } as never)).toMatchObject({ text: 'Cache demo: 8 min left until the next answer.' })
    await showsTime($, surface, '08:00', ALERT)
  })
}

test('desktop: while a flow runs the row shows its progress only, without model or cache', async ($, on) => {
  await session($, on)
  await answer($)
  await spawn($, 4)
  await finish($, 1)
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'AbovePrompt', props: band })
  const svgs = (await ui.findAll({ type: 'Svg' })).map(el => String(el.props.source))
  expect(svgs.length).toBe(1)
  expect(svgs[0]).toContain('Subagents')
  expect(svgs[0]).not.toContain('Opus 5.5')
  expect(svgs[0]).not.toContain('Cache')
  expect(svgs[0]).not.toContain(CACHE)
  expect(svgs[0]).not.toContain('Context')
})

// A finished flow steps aside after 10 seconds: the row is model and cache again.
for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: a finished flow gives the row back to model and cache after 10 seconds`, async ($, on) => {
    const clock = await session($, on)
    await answer($)
    await spawn($, 2)
    await finish($, 2)
    expect(await shows($, surface, 'Subagents')).toBe(true)
    expect(await shows($, surface, 'Done')).toBe(true)

    await clock.advance(9 * 1000)
    expect(await shows($, surface, 'Subagents')).toBe(true)
    expect(await shows($, surface, 'Cache')).toBe(false)

    await clock.advance(2 * 1000)
    expect(await shows($, surface, 'Subagents')).toBe(false)
    expect(await shows($, surface, 'Cache')).toBe(true)
  })
}

// The idle cache bar breathes as one soft fade; the progress bar keeps its twinkling pixels.
test('desktop: the cache bar breathes, the progress bar twinkles', async ($, on) => {
  const clock = await session($, on)
  await answer($)
  const idle = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'AbovePrompt', props: band })
  const cacheSvg = String((await idle.find({ type: 'Svg' }))?.props.source)
  await idle.unmount()
  expect(cacheSvg).toContain('class="breathe"')
  expect(cacheSvg).toContain('@keyframes breathe')
  expect(cacheSvg).not.toContain('@keyframes tw')

  await spawn($, 2)
  const busy = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'AbovePrompt', props: band })
  const flowSvg = String((await busy.find({ type: 'Svg' }))?.props.source)
  await busy.unmount()
  expect(flowSvg).toContain('@keyframes tw')
  expect(flowSvg).not.toContain('@keyframes breathe')

  // Once expired the bar rests: no fade.
  await clock.advance(61 * MIN)
  await finish($, 2)
  await clock.advance(11 * 1000)
  const rest = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'AbovePrompt', props: band })
  const restSvg = String((await rest.find({ type: 'Svg' }))?.props.source)
  await rest.unmount()
  expect(restSvg).toContain('expired')
  expect(restSvg).not.toContain('@keyframes breathe')
})

// The idle row spans the window: both bars split the room left after the labels.
test('desktop: the idle bars span the window', async ($, on) => {
  await session($, on)
  await answer($)
  const widthAt = async (bodyColumns: number) => {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'AbovePrompt', props: { ...band, bodyColumns } })
    const svg = await ui.find({ type: 'Svg' })
    await ui.unmount()
    return Number(svg?.props.width)
  }
  // Halving the room for two bars may lose a pixel.
  for (const cols of [125, 180]) {
    const w = await widthAt(cols)
    expect(w).toBeLessThanOrEqual(cols * 8 - 40)
    expect(w).toBeGreaterThanOrEqual(cols * 8 - 41)
  }
})

test('terminal: the idle bars span the band', async ($, on) => {
  const clock = await session($, on)
  await answer($)
  const barsAt = async (bodyColumns: number) => {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: { ...band, bodyColumns } })
    const bars = (await ui.findAll({ type: 'Text', text: /^[█░]+$/ })).map(el => String(el.text).length)
    await ui.unmount()
    return bars
  }
  // "Opus 5.5 · high", both labels, both figure slots and the gaps take 46 columns.
  expect(await barsAt(100)).toEqual([27, 27])
  expect(await barsAt(160)).toEqual([57, 57])
  // The clock's slot is as wide as "expired": "60:00" turning into it moves no bar.
  await clock.advance(61 * MIN)
  expect(await barsAt(100)).toEqual([27, 27])
})

// On the terminal the row keeps one empty line above itself, idle and while a flow runs.
test('terminal: one empty line above the row', async ($, on) => {
  await session($, on)
  await answer($)
  const marginTop = async () => {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: band })
    const top = (await ui.find({ type: 'Box' }))?.props.marginTop
    await ui.unmount()
    return top
  }
  expect(await marginTop()).toBe(1)
  await spawn($, 4)
  expect(await marginTop()).toBe(1)
})

// The row is drawn anew every second as the countdown ticks. Each drawing must pick the
// fade up where the last one left it, or the animation restarts and the bar blinks.
test('desktop: the cache fade keeps its phase across the per-second redraws', async ($, on) => {
  const clock = await session($, on)
  await answer($)
  const delayAt = async () => {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'AbovePrompt', props: band })
    const svg = String((await ui.find({ type: 'Svg' }))?.props.source)
    await ui.unmount()
    const m = /\.breathe\{animation:breathe ([\d.]+)s[^}]*animation-delay:(-[\d.]+)s/.exec(svg)
    expect(m).not.toBeNull()
    return { period: Number(m?.[1]), delay: Number(m?.[2]) }
  }
  const first = await delayAt()
  await clock.advance(1000)
  const second = await delayAt()
  // One second later the animation is one second further along (modulo its period).
  const step = (((first.delay - second.delay) % first.period) + first.period) % first.period
  expect(Math.abs(step - 1)).toBeLessThan(0.01)
})

// A finished flow keeps the running bar's purple: no green for "Done".
for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: "Done" keeps the progress bar's purple`, async ($, on) => {
    await session($, on)
    await spawn($, 1)
    await finish($, 1)
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: band })
    const colors =
      surface === 'desktop'
        ? String((await ui.find({ type: 'Svg' }))?.props.source)
        : (await ui.findAll({ type: 'Text' })).map(el => String((el.props as { color?: string }).color ?? '')).join(' ')
    await ui.unmount()
    expect(colors).toContain('#8f8cf4')
    expect(colors).not.toContain('#5fbf8f')
  })
}
