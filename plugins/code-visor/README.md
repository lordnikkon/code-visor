# Code Visor for Claude

A Claude Code mod that puts a heads-up display above the prompt and an agents panel beside the conversation. Its plugin ID is `code-visor`: that is the name to install, configure and load it by.

## The HUD row

![HUD row in the desktop app: Opus 5.5 · high, cache 59:45, context 59%](../../docs/images/hud-idle-desktop.png)

When nothing runs in the background, the row shows three things:

- **Model**: the main session's model and effort, e.g. `Opus 5.5 · high`.
- **Cache**: how long the prompt cache stays warm. Claude Code keeps it for one hour after each model request of the main session, so the bar fills up again with every answer and then drains. The time left rides in the bar (`42:10`). The bar is teal, turns amber below 20 minutes and red below 10, and reads `expired` when the hour is over. While a turn is running the cache is being refreshed, so the warning colours wait. On the desktop the fill breathes slowly; once expired it rests.
- **Context**: how full the main session's context window is, the same figure as the status line (`42%`). Blue, amber from 70 %, red from 85 %. It changes only between answers, so it holds still.

![Context bar in amber at 70 %, cache 59:45](../../docs/images/hud-context-warn-desktop.png)

Before the first answer, and right after a compaction, both bars are empty: the cache reads `cold`, the context bar `—`.

![HUD row on the terminal: Opus 5.5 · high, cache 43:29, context 9%](../../docs/images/hud-idle-terminal.png)

When subagents run, the row switches to their progress:

![Progress bar for a batch of three subagents: Tasks 1/3, 33%](../../docs/images/hud-subagents-running.png)

- All subagents started by the main session form one batch titled **Subagents**. The bar counts finished agents against started ones (`Tasks 3/5`), with the percentage beside it, and reads **Done** when the last one has ended.
- Subagents started by other subagents appear in the panel but are not counted.
- A subagent that starts while the row still reads **Done** continues the same batch. A workflow's agents therefore stay in one bar, even when one ends a moment before the next begins.
- `×n` opens the agents panel. `✕` dismisses the batch at once. Otherwise model, cache and context return ten seconds after **Done**.

![Finished batch: Done, 100%](../../docs/images/hud-subagents-done.png)

On the terminal the row is drawn with block characters and keeps an empty line above itself.

## Agents panel

The panel lists the subagents of the current batch, running ones first, each with its type, model and effort, context fill, tokens, estimated cost and runtime. A repeated task is marked `round 2`, a failed one `error`. On top are the totals for cost, tokens and time. **Collapse** switches to a single compact line; the finished section can be folded away.

Busy agents are drawn as walking crabs; an Explore agent wears a pirate hat and fences with a cutlass. With `prefers-reduced-motion` all animations stand still.

Costs are an estimate: Claude Code reports tokens, not money. They are computed from a price table per model (`PRICES` in `hooks/register.tsx`, list prices as of 2026-10-10). Cache writes are priced at the one-hour rate that Claude Code uses on a subscription, so sessions with five-minute cache entries appear slightly too expensive.

## Commands

| Command | Effect |
| --- | --- |
| `/hud` | Hide or show the HUD row. |
| `/hud demo <minutes>` | Pretend the cache has that many minutes left, to preview the colours; the next answer resets it. |
| `/agents-info` | Open or close the agents panel. |
| `/agents-info open` | Open the panel, or bring it to the front. |

## Configuration

### Options

| Option | Values | Default | Meaning |
| --- | --- | --- | --- |
| `language` | `auto`, `en`, `ru`, `he` | `auto` | The language of row and panel. `auto` follows Claude Code's `language` setting, then the system locale, and falls back to English. Hebrew is laid out right to left. |
| `autoOpen` | `subagent`, `session`, `off` | `subagent` | When the agents panel opens by itself: `subagent` when the session's first subagent starts, `session` as soon as a session starts, `off` never. It opens by itself at most once per session; `/agents-info` and `×n` work in every mode. On a terminal narrower than 144 columns Claude Code holds a pane opened this way back and a toast says so; your next prompt opens it at any width. |

### Setting them

**In Claude Code**: `/config` lists both options under the plugin, each as a picker over its values. A change there applies right away.

**From the shell**, for a marketplace install:

```bash
claude plugin configure code-visor@chvlr
```

shows the current values; to change them, pass a JSON object on stdin (options left out keep their value):

```bash
echo '{"language":"en","autoOpen":"session"}' | claude plugin configure code-visor@chvlr --values-stdin
```

**In `~/.claude/settings.json`**, under `pluginConfigs`. The key is `code-visor@chvlr` for a marketplace install and `code-visor` for a mod loaded from a folder:

```json
{
  "pluginConfigs": {
    "code-visor@chvlr": {
      "options": { "language": "en", "autoOpen": "session" }
    }
  }
}
```

Changes made from the shell or in `settings.json` take effect after Claude Code restarts. A value outside the listed ones counts as unset, and the default applies.

### Fixed values

These are built in and not configurable:

| What | Value |
| --- | --- |
| Cache lifetime the countdown assumes | 60 minutes after each main-session request |
| Cache colour | teal; amber below 20 min; red below 10 min; grey when expired or before the first answer |
| Context colour | blue; amber from 70 %; red from 85 % |
| Row returns to model, cache and context | 10 seconds after **Done** |
| Cache fade on the desktop | one breath every 6 seconds; stops with `prefers-reduced-motion` |

To hide the row for a while without changing any setting, use `/hud`.

## Installation

```
/plugin marketplace add lordnikkon/code-visor
/plugin install code-visor@chvlr
```

Claude Code 2.1.275 and later can do both in one step: `/plugin install code-visor --marketplace lordnikkon/code-visor`. The [repository README](../../README.md) shows how to load the mod from a clone.

## Code

| File | Contents |
| --- | --- |
| `hooks/register.tsx` | All hooks and everything that needs `$`: the row, the panel, cache and context tracking, the batch, the commands. |
| `hooks/cache.ts` | Colour, fill and text of the cache countdown. |
| `hooks/context.ts` | Colour, fill and text of the context bar. |
| `hooks/state.ts` | Initial state values. |
| `types/index.d.ts` | The `$.state` contract. |

Claude Code 2.1.295 follows `$` only into functions of the same file and refuses a module that hands it across an import, so no helper in another file takes `$`. Validate with the oldest Claude Code you support; newer releases accept what older ones refuse. Design notes: [docs/code-visor-design.md](../../docs/code-visor-design.md).
