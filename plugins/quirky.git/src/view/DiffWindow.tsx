import { useCallback, useEffect, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import type { MountFunction, UiPluginContext } from '@quirky/protocol'
import { DIFF_VIEW_ID, SESSIONS_VIEW_ID, type DiffViewInput, type ReviewSnapshot } from '../shared/view-input'
import { CombinedDiff } from './CombinedDiff'
import { ConflictFile } from './ConflictFile'
import { ConflictReview } from './ConflictReview'
import { FileDiff } from './FileDiff'
import { registerView, type ViewHandle } from './registry'
import { useDiffSettings } from './settings'
import type { Controller, ViewReport } from './types'

const MODES: ReadonlyArray<DiffViewInput['mode']> = ['file', 'combined', 'conflicts', 'conflict-file']

/** The mount input as a `DiffViewInput`, or null when it names no worktree. A missing mode means a file diff. */
export function parseInput(input: unknown): DiffViewInput | null {
  if (typeof input !== 'object' || input === null) return null
  const value = input as Partial<DiffViewInput>
  if (typeof value.worktree !== 'string' || value.worktree === '') return null
  const mode = MODES.includes(value.mode as DiffViewInput['mode']) ? (value.mode as DiffViewInput['mode']) : 'file'
  const { review, noteId, ...rest } = value
  return { ...rest, worktree: value.worktree, mode, ...(isReview(review) ? { review } : {}), ...(typeof noteId === 'string' && noteId !== '' ? { noteId } : {}) }
}

function isReview(value: unknown): value is ReviewSnapshot {
  if (typeof value !== 'object' || value === null) return false
  const { entries, capturedAt } = value as Partial<ReviewSnapshot>
  return typeof capturedAt === 'number' && Array.isArray(entries) && entries.every((e) => typeof e?.path === 'string' && typeof e?.kind === 'string')
}

/** The view's content for one input: the mode's component under the view's settings and handle. */
function DiffWindow({ context, input, report }: { context: UiPluginContext; input: DiffViewInput; report(state: ViewReport): void }) {
  const { settings, setSetting } = useDiffSettings(context)
  const controller = useRef<Controller>({})
  const bind = useCallback((next: Controller) => {
    controller.current = next
  }, [])
  const close = useCallback(() => {
    if (input.mode === 'conflict-file' && input.review) context.openView(DIFF_VIEW_ID, { worktree: input.worktree, mode: 'conflicts', review: input.review })
    else context.openView(SESSIONS_VIEW_ID, { worktree: input.worktree })
  }, [context, input])

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
      collapseAll: (collapsed) => controller.current.collapseAll?.(collapsed),
      loadDiff: async (path) => {
        await controller.current.loadDiff?.(path)
      }
    }
    return registerView(handle)
  }, [input])

  const props = { context, input, settings, setSetting, report, bind, close }
  switch (input.mode) {
    case 'combined':
      return <CombinedDiff {...props} />
    case 'conflicts':
      return <ConflictReview {...props} />
    case 'conflict-file':
      return <ConflictFile {...props} />
    case 'file':
      return <FileDiff {...props} />
  }
}

/** The `view:quirky.git/diff` mount function; the host remounts it with the new input whenever the input changes. */
export function mountDiffView(context: UiPluginContext): MountFunction {
  return (element, { input, report }) => {
    Object.assign(element.style, { display: 'flex', flexDirection: 'column', flex: '1', minHeight: '0' })
    const root = createRoot(element)
    const parsed = parseInput(input)
    const send = (state: ViewReport) => report?.(state)
    if (parsed === null) {
      root.render(<p className="muted pad">Open a worktree first.</p>)
      return () => root.unmount()
    }
    root.render(
      <div className="qgv-root">
        <DiffWindow context={context} input={parsed} report={send} />
      </div>
    )
    return () => root.unmount()
  }
}
