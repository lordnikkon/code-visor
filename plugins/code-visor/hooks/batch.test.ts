import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const PLUGIN = 'code-visor'
const pane = { title: '', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } as const
const band = { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 120, scroll: { offset: 0, bodyRows: 4 }, view: {} }

let next = 0
// Returns what reached Claude Code: the panels opened and the briefs the subagents got.
function world(on: On) {
  const clock = mock.clock(on)
  const opened: string[] = []
  const briefs: string[] = []
  on('ui.open', (_$, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('agent.spawn', (_$, e) => {
    briefs.push(e.prompt)
    return { model: 'claude-haiku-5-5', agentId: `a${++next}` }
  })
  on('turn.complete', () => ({ text: '' }) as never)
  return { clock, opened, briefs }
}

const spawn = ($: Engine, type: string, parentAgentId?: string) =>
  $.agent.spawn({ tool_use_id: `t${next}`, prompt: 'p', description: 'Look around', subagentType: type, provider: 'engine', parentModel: 'claude-opus-5-5', background: false, fork: false, ...(parentAgentId ? { parentAgentId } : {}) } as never)

const finish = ($: Engine, agentId: string) => $.turn.complete({ agentId, reason: 'answer', turnId: 'x' } as never)

// What the desktop row draws: one Svg holding the flow's title and label.
async function rowSvg($: Engine) {
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'AbovePrompt', props: band })
  const svg = String((await ui.find({ type: 'Svg' }))?.props.source)
  await ui.unmount()
  return svg
}

test('batch: plain subagents report start, progress and finish', async ($, on) => {
  world(on)
  const a = await spawn($, 'Explore')
  const b = await spawn($, 'general-purpose')
  expect(await rowSvg($)).toContain('Subagents')
  expect(await rowSvg($)).toContain('Tasks 0/2')

  await finish($, a.agentId as string)
  expect(await rowSvg($)).toContain('Tasks 1/2')
  await finish($, b.agentId as string)
  expect(await rowSvg($)).toContain('Done')

})

// A workflow starts its next agent right after the last one ended: while "Done" still
// shows, a spawn carries the batch on. Once the row has given it back, a new batch starts.
test('batch: a spawn during "Done" carries the batch on, a later one starts over', async ($, on) => {
  const { clock } = world(on)
  // The session start runs the clock that clears a finished row.
  await start($, on)
  const a = await spawn($, 'Explore')
  await finish($, a.agentId as string)
  expect(await rowSvg($)).toContain('Done')

  const b = await spawn($, 'Explore')
  expect(await rowSvg($)).toContain('Tasks 1/2')
  await finish($, b.agentId as string)
  expect(await rowSvg($)).toContain('Done')

  await clock.advance(11 * 1000)
  await spawn($, 'Explore')
  expect(await rowSvg($)).toContain('Tasks 0/1')
  // The new batch starts with a clean panel: only its own agent is counted.
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: band })
  expect((await ui.find({ key: 'code-visor-agents' }))?.props.label).toBe('×1')
})

// The desktop panel: the batch's title heads it while it runs, each run is one Svg row.
test('panel: the desktop pane draws the runs under the batch title', async ($, on) => {
  world(on)
  const a = await spawn($, 'Explore')
  const b = await spawn($, 'general-purpose')
  const drawn = async () => {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'Pane', requestId: 'code-visor-agents', props: pane })
    const svgs = (await ui.findAll({ type: 'Svg' })).map(el => String(el.props.source)).join('')
    await ui.unmount()
    return svgs
  }
  const running = await drawn()
  expect(running).toContain('>Subagents</text>')
  expect(running).toContain('>Look around</text>')
  expect(running).toContain('c-explore run')
  expect(running).toContain('>general-purpose</tspan>')

  await finish($, a.agentId as string)
  await finish($, b.agentId as string)
  // A finished batch no longer heads the panel; its runs stay listed.
  const done = await drawn()
  expect(done).not.toContain('>Subagents</text>')
  expect(done).toContain('>Look around</text>')
})

test('batch: nested subagents are not counted', async ($, on) => {
  world(on)
  const a = await spawn($, 'Explore')
  await spawn($, 'Explore', a.agentId as string)
  expect(await rowSvg($)).toContain('Tasks 0/1')
  await finish($, a.agentId as string)
  expect(await rowSvg($)).toContain('Done')
})

// Every subagent type counts the same, and its brief reaches it untouched.
test('batch: any subagent type counts and keeps its brief', async ($, on) => {
  const { briefs } = world(on)
  await spawn($, 'general-purpose')
  await spawn($, 'Plan')
  expect(await rowSvg($)).toContain('Subagents')
  expect(await rowSvg($)).toContain('Tasks 0/2')
  expect(briefs).toEqual(['p', 'p'])
})

test('batch: a dismissed batch is followed by a new one', async ($, on) => {
  world(on)
  const a = await spawn($, 'Explore')
  await spawn($, 'Explore')
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'AbovePrompt', props: band })
  await ui.press({ key: 'code-visor-dismiss' })
  await ui.unmount()
  expect(await rowSvg($)).not.toContain('Subagents')

  // An agent of the dismissed batch ending changes nothing; the next spawn starts over.
  await finish($, a.agentId as string)
  await spawn($, 'Explore')
  expect(await rowSvg($)).toContain('Tasks 0/1')
})

// The first subagent opens the panel, once per session; the crew button counts the runs.
test('batch: the first subagent opens the panel, the button counts the runs', async ($, on) => {
  const { opened } = world(on)
  await spawn($, 'Explore')
  await spawn($, 'general-purpose')
  expect(opened).toEqual(['code-visor-agents'])
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: band })
  expect((await ui.find({ key: 'code-visor-agents' }))?.props.label).toBe('×2')
})

// `autoOpen`: `subagent` (the default) opens the panel with the first subagent, `session` as
// the session starts, `off` leaves it to /agents-info.
const start = async ($: Engine, on: On) => {
  mock.env(on, { LANG: 'en_US.UTF-8' })
  on('settings.read', async () => ({ value: {} }) as never)
  on('session.start', async () => ({ cwd: '/repo' }) as never)
  on('command.register', async () => ({ value: undefined }) as never)
  await $.session.start({ source: 'startup', cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
}

test('autoOpen subagent, the default: the session start leaves the panel shut', async ($, on) => {
  const { opened } = world(on)
  await start($, on)
  expect(opened).toEqual([])
  await spawn($, 'Explore')
  expect(opened).toEqual(['code-visor-agents'])
})

test('autoOpen session: the panel opens as the session starts, once', { options: { autoOpen: 'session' } }, async ($, on) => {
  const { opened } = world(on)
  await start($, on)
  expect(opened).toEqual(['code-visor-agents'])
  await spawn($, 'Explore')
  expect(opened).toEqual(['code-visor-agents'])
})

test('autoOpen off: neither the session nor a subagent opens the panel', { options: { autoOpen: 'off' } }, async ($, on) => {
  const { opened } = world(on)
  await start($, on)
  await spawn($, 'Explore')
  expect(opened).toEqual([])
})

// A workflow starts its agents at the same moment: every spawn counts, none starts the batch over.
test('batch: agents spawned at once all count', async ($, on) => {
  world(on)
  const runs = await Promise.all([1, 2, 3, 4, 5].map(() => spawn($, 'Explore')))
  expect(await rowSvg($)).toContain('Tasks 0/5')
  for (const r of runs.slice(0, 4)) await finish($, r.agentId as string)
  expect(await rowSvg($)).toContain('Tasks 4/5')
  await finish($, runs[4]?.agentId as string)
  expect(await rowSvg($)).toContain('Done')
})

// On a narrow terminal the panel the first subagent opens waits undrawn. The person's
// /agents-info then opens it, instead of closing the waiting pane.
test('panel: /agents-info opens a pane that waits undrawn', async ($, on) => {
  mock.clock(on)
  const opened: boolean[] = []
  on('ui.open', () => {
    const isPlaced = opened.length > 0
    opened.push(isPlaced)
    return { value: isPlaced ? { isPlaced } : { isPlaced, reason: 'unasked: 144 columns, 90 now' } }
  })
  // The pane stays open from its first open on; it is drawn once an open placed it.
  on('ui.panes', () => ({
    value: opened.length ? [{ id: 'code-visor-agents', title: 'Agents', isShown: opened.at(-1) === true, isFocused: false, isPlaced: opened.at(-1) === true }] : [],
  }))
  on('ui.close', () => {
    throw new Error('the waiting pane was closed')
  })
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: `a${++next}` }))
  await spawn($, 'Explore')
  expect(opened).toEqual([false])
  const answer = await $.command.run({ command: 'agents-info', args: '' } as never)
  expect(opened).toEqual([false, true])
  expect(JSON.stringify(answer)).toContain('opened')
})

// Where no surface places panes, an open stays undrawn even when asked: the next
// /agents-info closes the waiting pane instead of opening it again and again.
test('panel: /agents-info closes a pane no surface can place', async ($, on) => {
  mock.clock(on)
  let isOpen = false
  const calls: string[] = []
  on('ui.open', () => {
    isOpen = true
    calls.push('open')
    return { value: { isPlaced: false, reason: 'no-surface' } }
  })
  on('ui.close', () => {
    isOpen = false
    calls.push('close')
    return { value: undefined } as never
  })
  on('ui.panes', () => ({ value: isOpen ? [{ id: 'code-visor-agents', title: 'Agents', isShown: false, isFocused: false, isPlaced: false }] : [] }))
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: `a${++next}` }))
  await spawn($, 'Explore')
  const answer = await $.command.run({ command: 'agents-info', args: '' } as never)
  expect(calls).toEqual(['open', 'open', 'close'])
  expect(JSON.stringify(answer)).toContain('closed')
})

// A pane that waits undrawn on a narrow terminal, and the prompts that reach the session.
function waitingWorld(on: On) {
  mock.clock(on)
  const opened: boolean[] = []
  on('ui.open', () => {
    const isPlaced = opened.length > 0
    opened.push(isPlaced)
    return { value: isPlaced ? { isPlaced } : { isPlaced, reason: 'unasked: 144 columns, 90 now' } }
  })
  on('ui.panes', () => ({
    value: opened.length ? [{ id: 'code-visor-agents', title: 'Agents', isShown: opened.at(-1) === true, isFocused: false, isPlaced: opened.at(-1) === true }] : [],
  }))
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: `a${++next}` }))
  const prompts: string[] = []
  on('prompt.submit', (_$, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  return { opened, prompts }
}

const prompt = ($: Engine, text: string, extra: object = {}) =>
  $.prompt.submit({ text, wait: false, origin: { kind: 'composer' }, ...extra } as never)

// The person's next prompt answers them: the waiting pane opens with it, at any width.
test('panel: the next prompt opens a pane that waits undrawn', async ($, on) => {
  const { opened, prompts } = waitingWorld(on)
  await spawn($, 'Explore')
  expect(opened).toEqual([false])
  await prompt($, 'weiter')
  expect(opened).toEqual([false, true])
  expect(prompts).toEqual(['weiter'])
  // Placed now: later prompts leave it be.
  await prompt($, 'noch was')
  expect(opened).toEqual([false, true])
})

test('panel: a prompt opens nothing while no pane waits', async ($, on) => {
  const { opened, prompts } = waitingWorld(on)
  await prompt($, 'hallo')
  expect(opened).toEqual([])
  expect(prompts).toEqual(['hallo'])
})

// Only the person's own Enter opens it: a slash command answers for itself, and a prompt
// from elsewhere (a peer, a notification) is no gesture of theirs.
test('panel: a slash command or a prompt from elsewhere leaves the pane waiting', async ($, on) => {
  const { opened } = waitingWorld(on)
  await spawn($, 'Explore')
  await prompt($, '/hud', { command: { name: 'hud', args: '' } })
  await prompt($, 'from a peer', { origin: { kind: 'peer' } })
  await prompt($, 'hidden', { isMeta: true })
  expect(opened).toEqual([false])
})
