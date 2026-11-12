import type { AvatarApp, SupervisorService } from '../contracts'

const ESCAPE = '\x1b'
const DOUBLE_ESCAPE_AGENTS: ReadonlySet<string> = new Set(['claude', 'codex'])
const DEFAULT_INTERRUPT_GAP_MS = 150

type Result = { sent: boolean; reason?: string }

export type StepInDeps = {
  /** When the agent last showed a prompt or changed turn, if the caller tracks it beyond the session's own status. */
  promptAt?(sessionId: string): number | null
  /** Pause between the two Escapes of a double interrupt. */
  interruptGapMs?: number
}

/**
 * True when the user typed into the pane after the agent last prompted, which means text is
 * sitting unsent in the input. Nothing is ever written into a pane in that state. With no agent
 * prompt on record, any user input counts as unsent.
 */
export function hasUnsentUserText(lastUserInputAt: number | null, lastAgentPromptAt: number | null): boolean {
  if (lastUserInputAt === null) return false
  return lastAgentPromptAt === null || lastUserInputAt > lastAgentPromptAt
}

const errorReason = (error: unknown): string => {
  const reason = (error as { data?: { reason?: unknown } } | null)?.data?.reason
  return typeof reason === 'string' && reason !== '' ? reason : error instanceof Error ? error.message : String(error)
}

const number = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

/**
 * The supervisor's way into a worker's pane. `send` types a prompt through agent-status; `stepIn`
 * interrupts the worker first. Both refuse at Shadow and over the user's unsent text, and answer
 * with `{sent:false, reason}` instead of throwing.
 */
export function createStepIn(app: AvatarApp, deps: StepInDeps = {}): Pick<SupervisorService, 'send' | 'stepIn'> {
  const call = (method: string, params: Record<string, unknown>): Promise<unknown> => app.context.call(method, params)

  async function target(worktreeId: string): Promise<{ sessionId: string; agent: string } | Result> {
    const active = app.services.handoff.active().find((entry) => entry.worktreeId === worktreeId)
    const level = active?.mandate.level ?? app.store.mandates.get(worktreeId)?.level
    if (level === 'shadow') return { sent: false, reason: 'shadow' }
    if (active?.sessionId == null) return { sent: false, reason: 'no-session' }
    const session = (await call('quirky.session/get', { session: active.sessionId })) as { agent?: unknown } | null
    return { sessionId: active.sessionId, agent: typeof session?.agent === 'string' ? session.agent : '' }
  }

  async function userIsTyping(sessionId: string): Promise<boolean> {
    const session = (await call('quirky.session/get', { session: sessionId })) as { agentStatus?: { stateStartedAt?: unknown } | null } | null
    const sessionPrompt = number(session?.agentStatus?.stateStartedAt)
    const tracked = deps.promptAt?.(sessionId) ?? null
    const promptAt = sessionPrompt === null || tracked === null ? (sessionPrompt ?? tracked) : Math.max(sessionPrompt, tracked)
    return hasUnsentUserText(number(app.context.pty.lastUserInput(sessionId)?.at), promptAt)
  }

  async function type(sessionId: string, text: string): Promise<Result> {
    try {
      await call('quirky.agent-status/send', { session: sessionId, text })
      return { sent: true }
    } catch (error) {
      return { sent: false, reason: errorReason(error) }
    }
  }

  async function guarded(worktreeId: string, act: (sessionId: string, agent: string) => Promise<Result>): Promise<Result> {
    try {
      const found = await target(worktreeId)
      if ('sent' in found) return found
      if (await userIsTyping(found.sessionId)) return { sent: false, reason: 'user-typing' }
      return await act(found.sessionId, found.agent)
    } catch (error) {
      return { sent: false, reason: errorReason(error) }
    }
  }

  return {
    send: (worktreeId, text) => guarded(worktreeId, (sessionId) => type(sessionId, text)),

    stepIn: (worktreeId, text) =>
      guarded(worktreeId, async (sessionId, agent) => {
        app.journal(worktreeId, 'event', { type: 'step-in', text, agent, sessionId })
        const escapes = DOUBLE_ESCAPE_AGENTS.has(agent) ? 2 : 1
        for (let press = 0; press < escapes; press++) {
          if (press > 0) await new Promise((resolve) => setTimeout(resolve, deps.interruptGapMs ?? DEFAULT_INTERRUPT_GAP_MS))
          await call('quirky.terminal/write', { session: sessionId, data: ESCAPE })
        }
        if (await userIsTyping(sessionId)) return { sent: false, reason: 'user-typing' }
        return type(sessionId, text)
      })
  }
}
