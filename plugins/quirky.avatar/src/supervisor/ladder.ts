import type { AvatarApp, StuckRow, SupervisorService } from '../contracts'
import { quoteAsData } from '../sanitize'
import type { StuckSignal } from './stuck'

const ATTEMPTS_IN_NOTE = 3
const ATTEMPT_CHARS = 600
const DIFF_CHARS = 2000
const JOURNAL_WINDOW = 200
const RESTART_RUNGS = 2
const LAST_RUNG = 3

const EMPTY_COUNTERS = { denialsConsecutive: 0, denialsTotal: 0 }

export type LadderDeps = {
  send: SupervisorService['send']
  restartWorker: SupervisorService['restartWorker']
  park: SupervisorService['park']
}

export type Ladder = {
  /** Takes the next step for a stuck worker. `acted` is false when the step could not be taken and the rung was kept. */
  climb(worktreeId: string, signal: StuckSignal): Promise<{ acted: boolean; reason?: string }>
  /** Progress was made: back to the first rung with the denial counters cleared. */
  reset(worktreeId: string): void
  row(worktreeId: string): StuckRow
  patchCounters(worktreeId: string, patch: Record<string, number>): void
}

const tail = (text: string, chars: number): string => (text.length > chars ? text.slice(-chars) : text)
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

function nudgeText(signal: StuckSignal): string {
  return `Heads up from the avatar: ${signal.detail}. Step back, work out why it keeps happening, and try a different approach before repeating it.`
}

/**
 * The stuck ladder (R-27): a nudge naming the signal, then a restart with a recovery note, a
 * second restart, then parking. Every step is journaled with its signal before it runs, and a
 * step is taken only from fresh evidence, because each step zeroes the denial counters and stamps
 * `stepAt` for the caller to ignore older evidence.
 */
export function createLadder(app: AvatarApp, deps: LadderDeps): Ladder {
  const row = (worktreeId: string): StuckRow =>
    app.store.stuck.get(worktreeId) ?? { worktreeId, rung: 0, counters: { ...EMPTY_COUNTERS }, updatedAt: app.now() }

  const write = (next: StuckRow): void => app.store.stuck.put({ ...next, updatedAt: app.now() })

  async function diffStat(worktreeId: string): Promise<string> {
    try {
      const raw = (await app.context.call('quirky.checks/run', { command: 'git diff --stat', worktree: worktreeId, timeoutSeconds: 30 })) as Record<string, unknown>
      const out = typeof raw.stdoutTail === 'string' ? raw.stdoutTail : ''
      return out.trim() === '' ? 'no uncommitted changes' : tail(out, DIFF_CHARS)
    } catch (error) {
      return `could not read the diff: ${message(error)}`
    }
  }

  function attempts(worktreeId: string): string[] {
    const entries = app.store.journalPage({ worktreeId, limit: JOURNAL_WINDOW }).reverse()
    const failures = entries
      .filter((entry) => entry.kind === 'done-check' && entry.data.kind === 'command' && entry.data.pass === false)
      .slice(-ATTEMPTS_IN_NOTE)
      .map((entry) => `- done when failed:\n${quoteAsData('done-when output', tail(String(entry.data.output ?? ''), ATTEMPT_CHARS))}`)
    const steps = entries
      .filter((entry) => entry.kind === 'ladder')
      .map((entry) => `- the avatar stepped in (rung ${String(entry.data.rung)}) because ${String(entry.data.detail ?? entry.data.signal)}`)
    return [...failures, ...steps]
  }

  async function recoveryNote(worktreeId: string, signal: StuckSignal): Promise<string> {
    const mandate = app.store.mandates.get(worktreeId)
    const guesses = app.store.guesses.list({ worktreeId }).filter((guess) => guess.confirmedAt === null && guess.redoneAt === null)
    const tried = attempts(worktreeId)
    return [
      `You are being restarted because the avatar saw: ${signal.detail}.`,
      '',
      `Goal: ${mandate?.goal ?? 'see the mandate'}`,
      `Done when: ${mandate?.doneWhen ?? 'see the mandate'}`,
      '',
      'What was tried and why each attempt failed:',
      ...(tried.length > 0 ? tried : ['- nothing recorded beyond the signal above']),
      '',
      'Changes so far (git diff --stat):',
      quoteAsData('git diff --stat', await diffStat(worktreeId)),
      '',
      'Guesses in play:',
      ...(guesses.length > 0 ? guesses.map((guess) => `- ${guess.question} -> ${guess.choice}`) : ['- none']),
      '',
      'Start from the current state of the branch and do not repeat the approach that failed.'
    ].join('\n')
  }

  function parkStory(worktreeId: string, signal: StuckSignal): string {
    const tried = attempts(worktreeId).filter((line) => line.startsWith('- the avatar stepped in'))
    return [`Parked after ${RESTART_RUNGS} restarts. It kept hitting: ${signal.detail}.`, ...tried].join('\n')
  }

  function record(worktreeId: string, current: StuckRow, signal: StuckSignal, rung: number): void {
    const counters = { ...current.counters, ...EMPTY_COUNTERS, stepAt: app.now() }
    app.store.transaction(() => {
      app.journal(worktreeId, 'stuck', { rung, signal: signal.kind, detail: signal.detail, counters: current.counters })
      app.journal(worktreeId, 'ladder', { rung, signal: signal.kind, detail: signal.detail })
      write({ ...current, rung: Math.min(LAST_RUNG, rung + 1) as StuckRow['rung'], counters })
    })
  }

  return {
    row,

    patchCounters(worktreeId, patch) {
      const current = row(worktreeId)
      write({ ...current, counters: { ...current.counters, ...patch } })
    },

    reset(worktreeId) {
      const current = row(worktreeId)
      write({ ...current, rung: 0, counters: { ...current.counters, ...EMPTY_COUNTERS } })
    },

    async climb(worktreeId, signal) {
      const current = row(worktreeId)
      const rung = current.rung

      if (rung === 0) {
        const nudge = await deps.send(worktreeId, nudgeText(signal))
        if (!nudge.sent) return { acted: false, reason: nudge.reason ?? 'not sent' }
        record(worktreeId, current, signal, rung)
        return { acted: true }
      }

      if (rung < LAST_RUNG) {
        const note = await recoveryNote(worktreeId, signal)
        record(worktreeId, current, signal, rung)
        const restarted = await deps.restartWorker(worktreeId, note)
        if (restarted.sessionId === null) app.journal(worktreeId, 'event', { type: 'restart-failed', error: restarted.error ?? 'no session' })
        return { acted: true }
      }

      const story = parkStory(worktreeId, signal)
      record(worktreeId, current, signal, rung)
      deps.park(worktreeId, story)
      return { acted: true }
    }
  }
}
