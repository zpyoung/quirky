import { createHash } from 'node:crypto'
import type { AvatarApp } from '../contracts'
import { sanitize } from '../sanitize'

const TAIL_CHARS = 3000
const TIMEOUT_SECONDS = 600

/** Runs done when and routes the result: a pass moves the worktree to review, a failure goes back to the worker. */
export type DoneWhen = { runDoneWhen(worktreeId: string): Promise<{ pass: boolean; output: string }> }

function tail(text: string): string {
  return text.length > TAIL_CHARS ? text.slice(-TAIL_CHARS) : text
}

/** A short hash of a failure that ignores numbers, so the same failure with different timings looks the same. */
function signature(output: string): string {
  return createHash('sha256').update(tail(output).replace(/\d+/g, '#')).digest('hex').slice(0, 16)
}

/**
 * Builds the done-when runner (R-25). The avatar runs a command done-when itself, because a worker's
 * claim alone never counts. A prose done-when cannot be run, so it wakes the brain and the journal
 * records that the brain judged it. `startReview` is called once a command passes.
 */
export function createDoneWhen(app: AvatarApp, startReview: (worktreeId: string) => Promise<{ started: boolean; reason?: string }>): DoneWhen {
  const setState = (worktreeId: string, state: Parameters<AvatarApp['services']['handoff']['setState']>[1], note: string, kind: Record<string, unknown>) =>
    app.store.transaction(() => {
      app.journal(worktreeId, 'done-check', { ...kind, state })
      app.services.handoff.setState(worktreeId, state, note)
    })

  return {
    async runDoneWhen(worktreeId) {
      const mandate = app.store.mandates.get(worktreeId)
      if (mandate === null) return { pass: false, output: 'no mandate for this worktree' }

      if (mandate.doneWhenKind === 'prose') {
        setState(worktreeId, 'checking-done', 'done when is prose, the brain judges it', {
          kind: 'prose',
          judgedBy: 'brain',
          doneWhen: sanitize(mandate.doneWhen),
          pass: null
        })
        app.services.brain.wake()
        return { pass: false, output: 'done when is prose, so the brain judges it' }
      }

      app.services.handoff.setState(worktreeId, 'checking-done', 'running done when')
      let output: string
      let pass = false
      try {
        const raw = (await app.context.call('quirky.checks/run', { command: mandate.doneWhen, worktree: worktreeId, timeoutSeconds: TIMEOUT_SECONDS })) as Record<string, unknown>
        const stdout = typeof raw.stdoutTail === 'string' ? raw.stdoutTail : ''
        const stderr = typeof raw.stderrTail === 'string' ? raw.stderrTail : ''
        const error = typeof raw.error === 'string' ? raw.error : ''
        output = tail([stdout, stderr, error].filter((part) => part !== '').join('\n'))
        pass = raw.ran !== false && raw.pass === true
        if (raw.timedOut === true) output = tail(`timed out after ${TIMEOUT_SECONDS}s\n${output}`)
      } catch (error) {
        output = `could not run done when: ${error instanceof Error ? error.message : String(error)}`
      }

      if (pass) {
        setState(worktreeId, 'in-review', 'done when passed', { kind: 'command', pass: true, command: mandate.doneWhen })
        await startReview(worktreeId)
        return { pass: true, output }
      }

      setState(worktreeId, 'working', 'done when failed, back to the worker', {
        kind: 'command',
        pass: false,
        command: mandate.doneWhen,
        output,
        signature: signature(output)
      })
      await app.services.supervisor.send(
        worktreeId,
        `Done when is "${mandate.doneWhen}" and it failed when the avatar ran it. Fix this and say when it is done.\n\nOutput tail:\n${sanitize(output)}`
      )
      return { pass: false, output }
    }
  }
}
