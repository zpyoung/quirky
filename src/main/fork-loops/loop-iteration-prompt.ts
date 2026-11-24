import { composeIterationPrompt } from '../../shared/fork-loops/loop-prompt'
import type { IterationPhase, IterationRecord } from '../../shared/fork-loops/loop-types'
import {
  errorMessage,
  isAgentBusy,
  isUserTyping,
  LoopUserInputDuringSendError,
  sendAgentPrompt,
  waitForInputIdle
} from './loop-agent-session'
import type { QueueItem, StoredLoop } from './loop-database'
import type { IterationContext, LoopDriverDeps, PaneRef } from './loop-driver-types'
import { loopNotesPath } from './loop-notes-file'

/** The prompt for one iteration: the queue item or repeated body plus the carried-over evidence. */
export function composeLoopPrompt(args: {
  loop: StoredLoop
  ctx: IterationContext
  item: QueueItem | null
  notes: string[]
  history: IterationRecord[]
  includePreamble: boolean
}): string {
  const { loop, ctx, item, notes, history } = args
  const { config } = loop
  const body = item?.body ?? (config.promptSource.kind === 'repeat' ? config.promptSource.body : '')
  return composeIterationPrompt({
    loop: config,
    iteration: ctx.n,
    maxIterations: config.caps.maxIterations ?? null,
    previousCheck: history.at(-1)?.check ?? null,
    steerNotes: notes,
    body,
    notesPath: ctx.targets
      ? loopNotesPath(ctx.targets.workspace, loop.slug)
      : `.quirky/loops/${loop.slug}/notes.md`,
    includePreamble: args.includePreamble
  })
}

export type PromptDelivery =
  | { kind: 'sent'; sentAt: number }
  | { kind: 'aborted' }
  | { kind: 'failed'; message: string }

/**
 * Waits for the user and agent to go idle, then writes the iteration prompt. A write the runtime
 * vetoed because the user typed after the idle check returns its steer notes and waits again;
 * any other write failure also returns them so the retry carries them.
 */
export async function deliverIterationPrompt(args: {
  deps: LoopDriverDeps
  ctx: IterationContext
  item: QueueItem | null
  pane: PaneRef
  includePreamble: boolean
  history(): IterationRecord[]
  signal: AbortSignal
  stopped(): boolean
  onPhase(phase: IterationPhase): void
}): Promise<PromptDelivery> {
  const { deps, ctx, item, pane, signal } = args
  const { loop } = ctx
  const now = (): number => deps.now?.() ?? Date.now()
  for (;;) {
    ctx.before = ctx.targets ? await deps.tools.snapshotTree(ctx.targets.workspace) : null
    ctx.usageBefore = loop.paneKey
      ? await deps.tools.readUsage(loop.paneKey, loop.worktreeId, loop.agent)
      : null
    const idleAt = now()
    if (!isUserTyping(deps, loop.paneKey) && !isAgentBusy(deps.runtime, loop.paneKey)) {
      const notes = deps.store.takePendingSteerNotes(loop.id, ctx.n).map((note) => note.body)
      const prompt = composeLoopPrompt({
        loop,
        ctx,
        item,
        notes,
        history: args.history(),
        includePreamble: args.includePreamble
      })
      ctx.promptSent = prompt
      const sentAt = now()
      deps.store.updateIteration(loop.id, ctx.n, ctx.attempt, { promptSent: prompt })
      try {
        await sendAgentPrompt(deps.runtime, deps.inputAttribution, pane, prompt, now, idleAt)
        return { kind: 'sent', sentAt }
      } catch (error) {
        for (const body of notes) {
          deps.store.addSteerNote(loop.id, body)
        }
        if (!(error instanceof LoopUserInputDuringSendError)) {
          return { kind: 'failed', message: errorMessage(error) }
        }
        deps.store.updateIteration(loop.id, ctx.n, ctx.attempt, { promptSent: '' })
      }
      if (signal.aborted || args.stopped()) {
        return { kind: 'aborted' }
      }
    }
    args.onPhase('waiting')
    if (!(await waitForInputIdle(deps, loop.paneKey, signal, args.stopped))) {
      return { kind: 'aborted' }
    }
    args.onPhase('sending')
  }
}
