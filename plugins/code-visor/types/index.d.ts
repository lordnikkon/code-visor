/** A batch of the main session's subagents, drawn as one progress bar. */
export type Flow = {
  title: string
  /** Subagents started in this batch. */
  total: number
  /** Subagents of this batch that ended. */
  done: number
  isFinished: boolean
  /** When the flow finished; 10 seconds later the row is model and cache again. */
  finishedAt?: number
}

export type AgentStatus = 'running' | 'done' | 'failed'

export type AgentRun = {
  id: string
  agentId?: string
  type: string
  description: string
  model: string
  effort?: string
  status: AgentStatus
  startedAt: number
  endedAt?: number
  contextTokens: number
  contextMax: number
  tokens: number
  costUsd: number
  steps: number
  round: number
}

export type Panel = {
  isCompact: boolean
  isDoneCollapsed: boolean
  autoOpenedFor: string
}

export type Hud = {
  /** The main loop's model id; '' until known. */
  model: string
  effort?: string
  /** When the prompt cache runs out; null before the first answer. */
  expiresAt: number | null
  secondsLeft: number | null
  /** The main session's context window fill, 0 to 100; null until the first answer. */
  contextPercent: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'code-visor': {
      // Shaped: a value an older version left in the session reads as absent after a reload.
      flow: Shaped<Flow | null>
      agents: Shaped<AgentRun[]>
      panel: Shaped<Panel>
      now: number
      hud: Hud
      isHidden: boolean
    }
  }
}
