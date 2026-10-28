import { Button, Dialog } from '@quirky/ui'
import { useEffect } from 'react'
import { activeDocument } from './activeDocument'
import { finishCloseRequest, updateCloseError, useCloseRequest, type CloseRequest, type CloseTarget } from './overlayState'

type Choice = 'save' | 'discard' | 'cancel'
type CloseResult = { closed: boolean; needsDecision?: boolean }

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

async function saveAndCloseAll(targets: CloseTarget[], request: CloseRequest): Promise<void> {
  const active = activeDocument()
  if (active) await active.flush()
  const buffers = [...new Set(targets.filter((target) => target.dirty).map((target) => target.bufferId))]
  for (const bufferId of buffers) await request.context.call('quirky.editor/save', { bufferId, trigger: 'user' })
  const closable = await Promise.all(targets.map((target) => request.context.call('quirky.editor/canClose', { bufferId: target.bufferId, tabId: target.tabId })))
  if (closable.some((result) => result !== true)) throw new Error('A tab changed while saving. Resolve its new edits before closing all tabs.')
  for (const target of targets) await request.context.call('quirky.editor/close', { bufferId: target.bufferId, tabId: target.tabId })
}

async function discardAndCloseAll(targets: CloseTarget[], request: CloseRequest): Promise<void> {
  const active = activeDocument()
  if (active && targets.some((target) => target.bufferId === active.bufferId)) await active.flush()
  for (const target of targets) {
    const params = { bufferId: target.bufferId, tabId: target.tabId, ...(target.dirty ? { choice: 'discard' } : {}) }
    const result = await request.context.call('quirky.editor/close', params) as CloseResult
    if (!result.closed) throw new Error(`Unable to close ${target.name}${result.needsDecision ? ': it still has unsaved changes.' : '.'}`)
  }
}

async function flushActiveTarget(target: CloseTarget): Promise<void> {
  const active = activeDocument()
  if (active?.bufferId === target.bufferId) await active.flush()
}

async function choose(request: CloseRequest, choice: Choice): Promise<void> {
  if (choice === 'cancel') {
    finishCloseRequest(request.id, false)
    return
  }
  updateCloseError(request.id, null)
  try {
    if (request.kind === 'single') {
      const target = request.targets[0]
      if (!target) throw new Error('The file to close is no longer available.')
      await flushActiveTarget(target)
      const result = await request.context.call('quirky.editor/close', {
        bufferId: target.bufferId,
        tabId: target.tabId,
        choice
      }) as CloseResult
      if (!result.closed) throw new Error(result.needsDecision ? 'The file still has unsaved changes.' : 'The file stayed open.')
    } else if (choice === 'save') {
      await saveAndCloseAll(request.targets, request)
    } else {
      await discardAndCloseAll(request.targets, request)
    }
    finishCloseRequest(request.id, true)
  } catch (reason) {
    updateCloseError(request.id, messageOf(reason))
  }
}

/** Three-way close UI shared by strip closes, Close Tab, and Close All. */
export function CloseOverlay({ report }: { report?(state: unknown): void }) {
  const request = useCloseRequest()
  useEffect(() => {
    report?.({
      open: request !== null,
      kind: request?.kind ?? null,
      targetCount: request?.targets.length ?? 0,
      dirtyCount: request?.targets.filter((target) => target.dirty).length ?? 0,
      error: request?.error ?? null
    })
  }, [report, request])

  if (!request) return null
  const target = request.targets[0]
  const title = request.kind === 'all' ? `Close ${request.targets.length} editor tabs?` : 'Unsaved Changes'
  const body = request.kind === 'all'
    ? 'Some editor tabs have unsaved changes. Save or discard those changes before closing the tabs.'
    : `“${target?.name ?? 'file'}” has unsaved changes. Do you want to save before closing?`
  return (
    <Dialog
      open
      title={title}
      onClose={() => { void choose(request, 'cancel') }}
      actions={
        <>
          <Button onClick={() => void choose(request, 'cancel')}>Cancel</Button>
          <Button variant="destructive" onClick={() => void choose(request, 'discard')}>Don't Save</Button>
          <Button variant="primary" onClick={() => void choose(request, 'save')}>Save</Button>
        </>
      }
    >
      <div className="qe-close-dialog">
        <p>{body}</p>
        {request.kind === 'all' && <p className="muted">{request.targets.filter((entry) => entry.dirty).length} dirty tab(s)</p>}
        {request.error && <p className="qe-editor-error" role="alert">{request.error}</p>}
      </div>
    </Dialog>
  )
}
