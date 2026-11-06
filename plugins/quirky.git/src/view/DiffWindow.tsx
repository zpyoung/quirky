import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { Button, Dialog, EmptyState } from '@quirky/ui'
import type { MountFunction, UiPluginContext } from '@quirky/protocol'

import { DIFF_VIEW_ID, SESSIONS_VIEW_ID, type DiffViewInput, type ReviewSnapshot } from '../shared/view-input'
import { ConflictFile } from './ConflictFile'
import { ConflictReview } from './ConflictReview'
import { ReviewDiff } from './ReviewDiff'
import { messageOf } from './data'
import { registerView, reviewViewFor, type ViewHandle } from './registry'
import { activateHostedDiff, claimReviewTab, closeHostedDiff, nameReviewTab, releaseReviewTab, updateHostedDiffDirty } from './hosted-tabs'
import { useDiffSettings } from './settings'
import type { Controller, ViewReport } from './types'

const MODES: ReadonlyArray<DiffViewInput['mode']> = ['file', 'combined', 'conflicts', 'conflict-file', 'review']
type CloseChoice = 'save' | 'discard' | 'cancel'

/**
 * The mount input as a `DiffViewInput`, or null when it names no worktree. A missing mode means a
 * file diff, and `file` and `combined` inputs (from tabs saved before the Review tab) become
 * `review` ones: the file's path is revealed and a commit is the scope.
 */
export function parseInput(input: unknown): DiffViewInput | null {
  if (typeof input !== 'object' || input === null) return null
  const value = input as Partial<DiffViewInput>
  if (typeof value.worktree !== 'string' || value.worktree === '') return null
  const mode = MODES.includes(value.mode as DiffViewInput['mode']) ? (value.mode as DiffViewInput['mode']) : 'file'
  const { review, noteId, ...rest } = value
  const extras = { ...(isReview(review) ? { review } : {}), ...(typeof noteId === 'string' && noteId !== '' ? { noteId } : {}) }
  if (mode === 'file' || mode === 'combined') {
    const { path, source: _source, oldPath: _oldPath, area: _area, commitMessage: _message, title: _title, ...kept } = rest
    return {
      ...kept,
      worktree: value.worktree,
      mode: 'review',
      ...(mode === 'file' && typeof path === 'string' && path !== '' ? { reveal: path } : {}),
      ...extras
    }
  }
  return { ...rest, worktree: value.worktree, mode, ...extras }
}

function isReview(value: unknown): value is ReviewSnapshot {
  if (typeof value !== 'object' || value === null) return false
  const { entries, capturedAt } = value as Partial<ReviewSnapshot>
  return typeof capturedAt === 'number' && Array.isArray(entries) && entries.every((e) => typeof e?.path === 'string' && typeof e?.kind === 'string')
}

/**
 * Whether this hosted tab is a second Review tab for its worktree. The first one mounted keeps the
 * place (and is named Review); a later one shows its path and scope in that tab and closes itself.
 * Views that are not hosted tabs never fold.
 */
function useFoldsIntoReview(context: UiPluginContext, input: DiffViewInput): boolean {
  const tabId = input.mode === 'review' ? input.tabId : undefined
  const [duplicate] = useState(() => tabId !== undefined && !claimReviewTab(input.worktree, tabId))
  useEffect(() => {
    if (tabId === undefined) return
    if (duplicate) {
      const survivor = reviewViewFor(input.worktree)
      survivor?.setScope(input.commit ?? null)
      if (input.reveal !== undefined) survivor?.reveal(input.reveal, input.noteId)
      else survivor?.scrollToTop()
      void (async () => {
        await activateHostedDiff(context, { worktree: input.worktree, mode: 'review' })
        await closeHostedDiff(context, input)
      })().catch((error: unknown) => context.toast('Could not close the duplicate Review tab', messageOf(error)))
      return
    }
    // the name is cosmetic; the tab works without it
    void nameReviewTab(context, input).catch(() => undefined)
    return () => releaseReviewTab(input.worktree, tabId)
  }, [])
  return duplicate
}

/** The view for one input; a second Review tab of a worktree renders nothing while it closes. */
function DiffWindow(props: { context: UiPluginContext; input: DiffViewInput; report(state: ViewReport): void }) {
  const duplicate = useFoldsIntoReview(props.context, props.input)
  return duplicate ? null : <DiffTab {...props} />
}

/** The view's content for one input: the mode's component under the view's settings and handle. */
function DiffTab({ context, input, report }: { context: UiPluginContext; input: DiffViewInput; report(state: ViewReport): void }) {
  const { settings, setSetting } = useDiffSettings(context)
  const controller = useRef<Controller>({})
  const [closeDialogOpen, setCloseDialogOpen] = useState(false)
  const [closeBusy, setCloseBusy] = useState(false)
  const closeChoiceResolver = useRef<((choice: CloseChoice) => void) | null>(null)
  const closeChoicePromise = useRef<Promise<CloseChoice> | null>(null)
  const closeTask = useRef<Promise<void> | null>(null)
  const bind = useCallback((next: Controller) => {
    controller.current = next
  }, [])
  const closeAfterDecision = useCallback(async (restoreDirty: boolean) => {
    if (input.tabId !== undefined) {
      await closeHostedDiff(context, input, restoreDirty)
    } else if (input.mode === 'conflict-file' && input.review) {
      context.openView(DIFF_VIEW_ID, { worktree: input.worktree, mode: 'conflicts', review: input.review })
    } else {
      context.openView(SESSIONS_VIEW_ID, { worktree: input.worktree })
    }
  }, [context, input])
  const askCloseChoice = useCallback(() => {
    if (closeChoicePromise.current !== null) return closeChoicePromise.current
    const pending = Promise.withResolvers<CloseChoice>()
    closeChoiceResolver.current = pending.resolve
    closeChoicePromise.current = pending.promise
    setCloseDialogOpen(true)
    return pending.promise
  }, [])
  const chooseClose = useCallback((choice: CloseChoice) => {
    if (closeBusy) return
    const resolve = closeChoiceResolver.current
    if (!resolve) return
    closeChoiceResolver.current = null
    closeChoicePromise.current = null
    resolve(choice)
  }, [closeBusy])
  const requestClose = useCallback(() => {
    if (closeTask.current !== null) return closeTask.current
    const task = (async () => {
      try {
        let restoreDirty = false
        if (controller.current.isDirty?.() ?? true) {
          const choice = await askCloseChoice()
          if (choice === 'cancel') return
          if (choice === 'save') {
            setCloseBusy(true)
            try {
              await controller.current.save?.()
            } finally {
              setCloseBusy(false)
            }
            if (controller.current.isDirty?.() ?? true) return
          } else {
            restoreDirty = true
            setCloseBusy(true)
          }
        }
        await closeAfterDecision(restoreDirty)
      } finally {
        setCloseBusy(false)
        setCloseDialogOpen(false)
      }
    })()
    closeTask.current = task
    const clear = () => {
      if (closeTask.current === task) closeTask.current = null
    }
    void task.then(clear, clear)
    return task
  }, [askCloseChoice, closeAfterDecision])
  const toastFailure = useCallback((title: string, error: unknown) => {
    try {
      context.toast(title, error instanceof Error ? error.message : String(error))
    } catch {
      // these failures can land after the plugin is revoked, when toast itself throws
    }
  }, [context])
  const close = useCallback(() => {
    void requestClose().catch((error: unknown) => toastFailure('Could not close diff', error))
  }, [requestClose, toastFailure])

  const lastDirty = useRef<boolean | null>(null)
  const send = useCallback((state: ViewReport) => {
    const display = input.display ?? 'source'
    report({
      ...state,
      worktree: input.worktree,
      tabId: input.tabId ?? null,
      groupId: input.groupId ?? null,
      placement: input.split === true ? 'split' : input.preview === true ? 'preview' : 'permanent',
      display
    })
    const dirty = state.dirty === true
    if (input.tabId !== undefined && lastDirty.current !== dirty) {
      lastDirty.current = dirty
      void updateHostedDiffDirty(context, input, dirty).catch((error: unknown) =>
        toastFailure('Could not update diff tab close protection', error)
      )
    }
  }, [context, input, report, toastFailure])

  useEffect(() => {
    const call = <K extends keyof Controller>(name: K) =>
      ((...args: unknown[]) => (controller.current[name] as ((...a: unknown[]) => unknown) | undefined)?.(...args)) as NonNullable<Controller[K]>
    const async = (name: 'save' | 'reloadFromDisk' | 'overwrite') => async () => {
      await controller.current[name]?.()
    }
    const handle: ViewHandle = {
      input,
      nextChange: call('nextChange'),
      previousChange: call('previousChange'),
      nextConflict: call('nextConflict'),
      previousConflict: call('previousConflict'),
      revertChange: call('revertChange'),
      save: async('save'),
      reloadFromDisk: async('reloadFromDisk'),
      overwrite: async('overwrite'),
      requestClose,
      collapseAll: (collapsed) => controller.current.collapseAll?.(collapsed),
      loadDiff: async (path) => {
        await controller.current.loadDiff?.(path)
      }
    }
    return registerView(handle)
  }, [input, requestClose])

  const props = { context, input, settings, setSetting, report: send, bind, close }
  let content: ReactNode
  switch (input.mode) {
    case 'conflicts':
      content = <ConflictReview {...props} />
      break
    case 'conflict-file':
      content = <ConflictFile {...props} />
      break
    default:
      content = <ReviewDiff {...props} />
  }
  return (
    <>
      {content}
      {closeDialogOpen && (
        <Dialog
          open
          title="Unsaved changes"
          onClose={() => { if (!closeBusy) chooseClose('cancel') }}
        >
          <p>Save changes to this diff before closing?</p>
          <div className="ui-dialog__actions">
            <Button variant="secondary" disabled={closeBusy} onClick={() => chooseClose('cancel')}>Cancel</Button>
            <Button variant="secondary" disabled={closeBusy} onClick={() => chooseClose('discard')}>Don't Save</Button>
            <Button variant="primary" disabled={closeBusy} onClick={() => chooseClose('save')}>Save</Button>
          </div>
        </Dialog>
      )}
    </>
  )
}

/** The `view:quirky.git/diff` mount function; the host remounts it with the new input whenever the input changes. */
export function mountDiffView(context: UiPluginContext): MountFunction {
  return (element, { input, report }) => {
    Object.assign(element.style, { display: 'flex', flexDirection: 'column', flex: '1', minHeight: '0' })
    const root = createRoot(element)
    const parsed = parseInput(input)
    const send = (state: ViewReport) => report?.(state)
    if (parsed === null) {
      root.render(<EmptyState message="Open a worktree first." />)
      return () => root.unmount()
    }
    root.render(
      <div data-git-view-root className="ui-stack" style={{ flex: 1, minHeight: 0, minWidth: 0, overflow: 'hidden' }}>
        <DiffWindow context={context} input={parsed} report={send} />
      </div>
    )
    return () => root.unmount()
  }
}
