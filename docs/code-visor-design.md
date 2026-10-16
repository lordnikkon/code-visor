# Code Visor for Claude: design

How the mod is built and why. What it does and how to use it is in the [plugin README](../plugins/code-visor/README.md).

## The row

The row has two states:

| State | Content |
| --- | --- |
| Idle | A dot in the cache colour, model and effort, the label "Cache" with the cache bar (time left in its pill), the label "Context" with the context bar (fill in its pill). |
| Batch | The batch title, its progress bar with the count in the pill, the percentage and a crab, then the `×n` button for the panel and `✕`. No model, cache or context. |

`/hud` hides the whole row; the band is then handed on unchanged.

On the desktop the row is one `Svg`, because the desktop wraps sibling elements onto new lines; only `×n` and `✕` are `Button`s beside it. On the terminal it is a row of `Text` elements with block-character bars and an empty line above it (`marginTop`); the empty line below belongs to the prompt. Whatever other mods draw into the band is placed beneath the row, except Claude Code's own placeholder (`type: 'engine'`): the desktop drops a band that nests it.

## Cache countdown

- Claude Code writes one-hour prompt cache entries, and each model request of the main session refreshes them. The deadline restarts after every main-session `turn.step` (no `agentId`) and at the main turn's `turn.complete`.
- A one-second clock writes the seconds left to state only when they change, so the idle row redraws at most once a second.
- Colour: teal, amber below 20 minutes, red below 10, grey when expired or before the first answer. During a turn the cache is being refreshed, so the warning colours are held back.
- `/hud demo <minutes>` moves the deadline for a preview; the next answer resets it.

All bars share one drawing: a dithered fill (`ditherDots`) and a pill at the head of the fill (`pillSvg`). They differ in motion only, so the two row states are told apart at a glance. The progress bar's pixels twinkle in four groups out of phase (`twinkleCss`); the cache bar's fill breathes as a whole (`breatheCss`, 6 s, down to 60 % opacity) and rests once expired. `prefers-reduced-motion` stops both.

Since the idle row is redrawn every second, a CSS animation would restart from its first frame each time and blink. The fade's `animation-delay` is therefore taken from the clock (`-(now mod 6 s)`), so every drawing continues the fade where the previous one stood.

## Context bar

- After every main-session request and turn, and at session start, `$.session.usage()` gives the context fill (`context.percent`, the status line's `used_percentage`). It is stored as `hud.contextPercent`, written only on change, and is `null` without a reading (a fresh or just compacted window), which leaves the bar empty.
- Colour: blue, amber from 70 %, red from 85 %, grey without a reading. No motion: the figure only changes between answers.
- An engine without `$.session.usage()` keeps the last reading; the call is guarded so the row always draws.

Both idle bars come from `dotBarSvg` and split the width left after the labels evenly, so the row spans the window (at least 100 px each). On the terminal the block bars split `bodyColumns` the same way (at least 6 cells each); the clock and the percentage have fixed slots, so a changing figure moves no bar.

## Batches

A subagent spawned by the main session (no `parentAgentId`) joins the batch titled "Subagents": `total` counts started agents, `done` ended ones, and the batch finishes when its last agent ends. Nested subagents are tracked for the panel but not counted.

A spawn while a finished batch still shows (the ten seconds of "Done") reopens it and keeps counting. A workflow starts its next agent milliseconds after the previous one ended; without this, every such gap would split the run into a new batch. After `✕`, or once the finished row has cleared, the next spawn starts a new batch and clears finished runs from the panel; agents still running stay listed, and the ends of agents from the old batch change nothing.

## Agents panel

The pane `code-visor-agents` lists the runs of the current batch with model, effort, context, tokens, cost and runtime. Cost is estimated from the token counts of each request with a per-model price table (`PRICES`), Haiku 5.5 with its long-prompt prices above 100,000 prompt tokens; cache writes count at the one-hour rate. A run whose requests went unseen takes the turn's summed usage instead.

`autoOpen` decides when the pane opens by itself: with the session's first subagent (`subagent`, the default), at session start (`session`), or never (`off`). It opens by itself at most once per session (`panel.autoOpenedFor`); after that, `/agents-info` opens and closes it.

## State

Everything lives in `$.state` under `code-visor`, declared in `types/index.d.ts`:

| Key | Content |
| --- | --- |
| `flow` | The current batch or `null`; `finishedAt` marks a finished one. |
| `agents` | The runs of the current batch plus any still running from an earlier one (at most the last 200). |
| `panel` | The panel's view state and whether it already opened by itself. |
| `now` | A clock value the panel redraws from while agents run. |
| `hud` | Model, effort, cache deadline, seconds left, context fill. |
| `isHidden` | Whether `/hud` hid the row. |

Session state survives a hot reload of the code. `flow`, `agents` and `panel` are therefore kept under a shape tag (`Shaped<T>`, currently `v1`): a version that changes what they hold bumps the tag, and the new code then reads the old value as absent instead of drawing it.

## Code layout

- `hooks/register.tsx`: all hooks, the row, the panel, the cache deadline and the batches.
- `hooks/cache.ts`, `hooks/context.ts`: pure helpers for colour, fill and text of the two idle bars.
- `hooks/state.ts`: initial state values.

Two rules of the hooks runtime shape this layout:

- Each file declares its own `atom(...)` values; `claude plugin validate` rejects an atom imported from another file.
- No function in another file takes `$`. Claude Code 2.1.295, the version the desktop app bundles, follows `$` only into functions of the same file and refuses a module that hands it across an import. Newer releases accept it, so test and validate with the oldest version you support.

## Tests

`claude plugin test plugins/code-visor` runs:

- `hud.test.tsx`: the idle row on both surfaces, colour thresholds and expiry, the context bar, `/hud` and the demo, the row during a batch, the ten-second clear-out, the bar motions and widths.
- `batch.test.ts`: batches, nested agents, a dismissed batch, a batch continued during "Done" and a new one after it, any subagent type with its brief untouched, the `×n` count, the desktop panel under the batch title, and the three `autoOpen` modes.
- `band.test.tsx`: the batch row as text on the terminal and as one `Svg` on the desktop.
- `cost.test.ts`: cost and context estimates per model.
