import { Button, Dialog, InlineError, NoticeLine } from '@quirky/ui'
import { useEffect, useRef, useState } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import { activeDocument } from './activeDocument'
import {
  finishCloseRequest,
  isCloseRequestCurrent,
  updateCloseBusy,
  updateCloseError,
  useCloseRequest,
  type CloseRequest,
  type CloseTarget
} from './overlayState'
import {
  useEditorUiControl,
  useEditorUiControlReport,
  useEditorUiControlSurface,
  type EditorUiControl
} from './uiControl'

type Choice = 'save' | 'discard' | 'cancel'
type CloseResult = { closed: boolean; needsDecision?: boolean }


async function saveAndCloseAll(
  targets: CloseTarget[],
  request: CloseRequest,
  isCurrent: () => boolean
): Promise<boolean> {
  if (!isCurrent()) return false
  const active = activeDocument()
  if (active) {
    await active.flush()
    if (!isCurrent()) return false
  }
  const buffers = [...new Set(targets.filter((target) => target.dirty).map((target) => target.bufferId))]
  for (const bufferId of buffers) {
    if (!isCurrent()) return false
    await request.context.call('quirky.editor/save', { bufferId, trigger: 'user' })
    if (!isCurrent()) return false
  }
  if (!isCurrent()) return false
  const closable = await Promise.all(targets.map((target) =>
    request.context.call('quirky.editor/canClose', { bufferId: target.bufferId, tabId: target.tabId })
  ))
  if (!isCurrent()) return false
  if (closable.some((result) => result !== true)) {
    throw new Error('A tab changed while saving. Resolve its new edits before closing all tabs.')
  }
  for (const target of targets) {
    if (!isCurrent()) return false
    await request.context.call('quirky.editor/close', { bufferId: target.bufferId, tabId: target.tabId })
    if (!isCurrent()) return false
  }
  return true
}

async function discardAndCloseAll(
  targets: CloseTarget[],
  request: CloseRequest,
  isCurrent: () => boolean
): Promise<boolean> {
  if (!isCurrent()) return false
  const active = activeDocument()
  if (active && targets.some((target) => target.bufferId === active.bufferId)) {
    await active.flush()
    if (!isCurrent()) return false
  }
  for (const target of targets) {
    if (!isCurrent()) return false
    const params = { bufferId: target.bufferId, tabId: target.tabId, ...(target.dirty ? { choice: 'discard' } : {}) }
    const result = await request.context.call('quirky.editor/close', params) as CloseResult
    if (!isCurrent()) return false
    if (!result.closed) throw new Error(`Unable to close ${target.name}${result.needsDecision ? ': it still has unsaved changes.' : '.'}`)
  }
  return true
}

async function performChoice(
  request: CloseRequest,
  choice: Exclude<Choice, 'cancel'>,
  isCurrent: () => boolean
): Promise<boolean> {
  if (!isCurrent()) return false
  if (request.kind === 'all') {
    return choice === 'save'
      ? saveAndCloseAll(request.targets, request, isCurrent)
      : discardAndCloseAll(request.targets, request, isCurrent)
  }
  const target = request.targets[0]
  if (!target) throw new Error('The file to close is no longer available.')
  const active = activeDocument()
  if (active?.bufferId === target.bufferId) {
    await active.flush()
    if (!isCurrent()) return false
  }
  if (!isCurrent()) return false
  const result = await request.context.call('quirky.editor/close', {
    bufferId: target.bufferId,
    tabId: target.tabId,
    choice
  }) as CloseResult
  if (!isCurrent()) return false
  if (!result.closed) throw new Error(result.needsDecision ? 'The file still has unsaved changes.' : 'The file stayed open.')
  return true
}

let nextCloseMountGeneration = 0

/** Three-way close UI shared by strip closes, Close Tab, and Close All. */
export function CloseOverlay({
  context,
  report
}: {
  context: UiPluginContext
  report?(state: unknown): void
}) {
  const request = useCloseRequest()
  const reportFromScope = useEditorUiControlReport()
  const surface = useEditorUiControlSurface()
  const publishReport = report ?? reportFromScope
  const [busyChoice, setBusyChoice] = useState<{ requestId: number; choice: Exclude<Choice, 'cancel'> } | null>(null)
  const mountGeneration = useRef<string | null>(null)
  const controlIdentity = useRef<{ requestId: number | null; isCurrent(): boolean }>({
    requestId: null,
    isCurrent: () => false
  })
  const busyRef = useRef<{ requestId: number | null; busy: boolean }>({ requestId: null, busy: false })
  if (mountGeneration.current === null) mountGeneration.current = `close-mount-${++nextCloseMountGeneration}`

  const requestId = request?.id ?? null
  const generation = request ? `${mountGeneration.current}:${request.id}` : null
  busyRef.current.requestId = requestId
  busyRef.current.busy = request?.busy ?? false
  const address = request && generation ? {
    surface,
    target: `close:${request.id}`,
    generation,
    actions: ['choose']
  } : null

  useEffect(() => {
    publishReport({
      open: request !== null,
      requestId,
      kind: request?.kind ?? null,
      targetCount: request?.targets.length ?? 0,
      dirtyCount: request?.targets.filter((target) => target.dirty).length ?? 0,
      busy: request?.busy ?? false,
      error: request?.error ?? null
    })
  }, [publishReport, request, requestId])

  const currentRequestId = requestId
  const handler = async (control: EditorUiControl) => {
    const isCurrent = () => currentRequestId !== null &&
      isCloseRequestCurrent(currentRequestId) &&
      controlIdentity.current.requestId === currentRequestId &&
      controlIdentity.current.isCurrent()
    if (!request || !isCurrent() || control.action !== 'choose') return { delivered: false }
    const data = control.data
    if (!data || Object.keys(data).some((key) => key !== 'choice') ||
      (data.choice !== 'save' && data.choice !== 'discard' && data.choice !== 'cancel')) {
      return { delivered: false }
    }
    const choice = data.choice as Choice
    if (request.busy || busyRef.current.requestId !== request.id || busyRef.current.busy || !isCurrent()) {
      return { delivered: false }
    }
    if (choice === 'cancel') {
      finishCloseRequest(request.id, false)
      return { delivered: true }
    }

    busyRef.current.busy = true
    setBusyChoice({ requestId: request.id, choice })
    updateCloseBusy(request.id, true)
    updateCloseError(request.id, null)
    let operationError: string | null = null
    try {
      if (!await performChoice(request, choice, isCurrent)) return { delivered: false }
    } catch (reason) {
      if (!isCurrent()) return { delivered: false }
      operationError = reason instanceof Error ? reason.message : String(reason)
    } finally {
      if (!isCurrent()) updateCloseBusy(request.id, false)
    }
    if (!isCurrent()) return { delivered: false }
    busyRef.current.busy = false
    setBusyChoice(null)
    if (operationError !== null) {
      updateCloseBusy(request.id, false)
      updateCloseError(request.id, operationError)
      return { delivered: true }
    }
    finishCloseRequest(request.id, true)
    return { delivered: true }
  }
  const onControlError = (reason: Error) => {
    if (!request || currentRequestId === null ||
      !isCloseRequestCurrent(currentRequestId) ||
      controlIdentity.current.requestId !== currentRequestId ||
      !controlIdentity.current.isCurrent() ||
      (busyRef.current.requestId === currentRequestId && busyRef.current.busy)) return
    updateCloseError(request.id, reason.message)
  }
  const controls = useEditorUiControl({ context, address, handler, onError: onControlError })
  controlIdentity.current = { requestId, isCurrent: controls.isCurrent }

  if (!request) return null
  const target = request.targets[0]
  const title = request.kind === 'all' ? `Close ${request.targets.length} editor tabs?` : 'Unsaved Changes'
  const body = request.kind === 'all'
    ? 'Some editor tabs have unsaved changes. Save or discard those changes before closing the tabs.'
    : `“${target?.name ?? 'file'}” has unsaved changes. Do you want to save before closing?`
  const currentBusyChoice = busyChoice?.requestId === request.id ? busyChoice.choice : null
  return (
    <Dialog
      open
      title={title}
      onClose={() => { void controls.run('choose', { choice: 'cancel' }) }}
      actions={
        <>
          <Button disabled={request.busy} onClick={() => { void controls.run('choose', { choice: 'cancel' }) }}>Cancel</Button>
          <Button disabled={request.busy} variant="destructive" onClick={() => { void controls.run('choose', { choice: 'discard' }) }}>Don't Save</Button>
          <Button disabled={request.busy} variant="primary" onClick={() => { void controls.run('choose', { choice: 'save' }) }}>Save</Button>
        </>
      }
    >
      <div className="qe-close-dialog">
        <p>{body}</p>
        {request.kind === 'all' && <p className="muted">{request.targets.filter((entry) => entry.dirty).length} dirty tab(s)</p>}
        {request.busy && currentBusyChoice && (
          <NoticeLine>{currentBusyChoice === 'save' ? 'Saving Markdown…' : 'Closing files…'}</NoticeLine>
        )}
        {request.error && <InlineError message={request.error} />}
      </div>
    </Dialog>
  )
}
