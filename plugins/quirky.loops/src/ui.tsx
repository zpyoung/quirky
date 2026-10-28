import { Button, Dialog } from '@quirky/ui'
import '@quirky/ui/styles.css'
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { UiPluginContext } from '@quirky/protocol'
import { LoopView } from '../window/LoopView'
import { SetupDialog } from '../window/SetupDialog'
import { LOOP_OVERLAY_ID, LOOP_VIEW_ID, type SurfaceHandle } from '../window/contracts'
import type { LoopSnapshot, LoopState } from './types'

type DialogState =
  | { kind: 'setup'; id: number; workspace: string; group?: string }
  | { kind: 'close-loop'; id: number; loopId: string; tabId: string; name: string }
type LoopSummary = Pick<LoopSnapshot, 'id' | 'name' | 'worktreeId' | 'state'>
type MountProps = { input?: unknown; report?(state: unknown): void }

type CloseChoice = 'cancel' | 'keep-running' | 'stop'

const COMMAND_PREFIX = 'command:quirky.loops/'
const CLOSE_COMMAND = `${COMMAND_PREFIX}close-tab`
const CLOSE_CHOICE_COMMAND = `${COMMAND_PREFIX}close-choice`
const CLOSE_METHOD = 'quirky.loops/viewCloseGuard'
const CLOSE_FAILURE_TITLE = 'Could not update the loop, so the tab stays open.'
const LIVE_STATES: readonly LoopState[] = ['running', 'needs-you']

let dialogSequence = 0
let currentDialog: DialogState | null = null
let setupSurface: { dialogId: number; handle: SurfaceHandle } | null = null
let setupReport: { dialogId: number; state: unknown } | null = null
let overlayReporter: ((state: unknown) => void) | null = null
let setOverlayDialog: ((dialog: DialogState | null) => void) | null = null
const loopHandles = new Map<string, SurfaceHandle>()
const loopReports = new Map<string, unknown>()
let loopReportOrder: string[] = []

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} must be a non-empty string`)
  return value
}
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function setupState(dialogId: number): Record<string, unknown> | null {
  if (setupSurface?.dialogId === dialogId) return setupSurface.handle.read()
  if (setupReport?.dialogId === dialogId && isRecord(setupReport.state)) return setupReport.state
  return null
}

function setupIsBusy(dialogId: number): boolean {
  const state = setupState(dialogId)
  return state !== null && Boolean(state.busy)
}
function assertSetupReplaceable(): void {
  if (currentDialog?.kind === 'setup' && setupIsBusy(currentDialog.id)) {
    throw new Error('loop setup is already starting')
  }
}

function argsOf(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('command arguments must be an object')
  return value
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], command: string): void {
  const extra = Object.keys(value).find((key) => !allowed.includes(key))
  if (extra !== undefined) throw new Error(`${command} does not support ${extra}`)
}

function optionalText(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined
  return requiredText(value, name)
}

function objectParams(value: unknown): Record<string, unknown> {
  if (value === undefined) return {}
  if (!isRecord(value)) throw new Error('params must be an object')
  return value
}

function loopSummary(value: unknown): LoopSummary {
  if (!isRecord(value)) throw new Error('loop API returned an invalid snapshot')
  const id = requiredText(value.id, 'loop.id')
  const name = requiredText(value.name, 'loop.name')
  const worktreeId = requiredText(value.worktreeId, 'loop.worktreeId')
  const state = value.state
  if (state !== 'running' && state !== 'needs-you' && state !== 'paused' && state !== 'completed' && state !== 'stopped') {
    throw new Error('loop API returned an invalid state')
  }
  return { id, name, worktreeId, state }
}

function isLive(loop: LoopSummary): boolean {
  return LIVE_STATES.includes(loop.state)
}

function tabById(node: unknown, tabId: string): Record<string, unknown> | null {
  if (!isRecord(node)) return null
  if (node.kind === 'split') return tabById(node.first, tabId) ?? tabById(node.second, tabId)
  if (node.kind !== 'group' || !Array.isArray(node.tabs)) return null
  const tab = node.tabs.find((candidate) => isRecord(candidate) && candidate.id === tabId)
  return isRecord(tab) ? tab : null
}

async function loopTabIsBound(context: UiPluginContext, loop: LoopSummary, tabId: string): Promise<boolean> {
  const result = await context.call('quirky.terminal/workspace', { workspace: loop.worktreeId })
  if (!isRecord(result) || !isRecord(result.workspace)) throw new Error('could not read the terminal workspace')
  const tab = tabById(result.workspace.root, tabId)
  return tab !== null &&
    tab.kind === 'view' &&
    tab.viewId === LOOP_VIEW_ID &&
    tab.key === loop.id &&
    tab.closeMethod === CLOSE_METHOD &&
    tab.closeContext === true &&
    isRecord(tab.closeParams) &&
    tab.closeParams.loopId === loop.id &&
    isRecord(tab.input) &&
    tab.input.loopId === loop.id
}

function latestRailState(): unknown {
  const loopId = loopReportOrder.at(-1)
  if (loopId === undefined) return null
  return loopHandles.get(loopId)?.read() ?? loopReports.get(loopId) ?? null
}

function reportOverlay(): void {
  const dialog = currentDialog
  const rail = latestRailState()
  overlayReporter?.({
    dialog,
    setup: dialog?.kind === 'setup' ? setupState(dialog.id) : null,
    rail,
    detail: isRecord(rail) ? rail.selectedDetail ?? null : null,
    close: dialog?.kind === 'close-loop' ? dialog : null
  })
}

function showDialog(dialog: DialogState): void {
  currentDialog = dialog
  if (setOverlayDialog) setOverlayDialog(dialog)
  else reportOverlay()
}

function clearDialog(id?: number): void {
  if (id !== undefined && currentDialog?.id !== id) return
  currentDialog = null
  if (setOverlayDialog) setOverlayDialog(null)
  else reportOverlay()
}

function noteLoopReport(loopId: string, state: unknown): void {
  loopReports.set(loopId, state)
  loopReportOrder = loopReportOrder.filter((id) => id !== loopId)
  loopReportOrder.push(loopId)
  reportOverlay()
}

function forgetLoop(loopId: string, handle: SurfaceHandle | null): void {
  if (handle !== null && loopHandles.get(loopId) === handle) loopHandles.delete(loopId)
  loopReports.delete(loopId)
  loopReportOrder = loopReportOrder.filter((id) => id !== loopId)
  if (currentDialog?.kind === 'close-loop' && currentDialog.loopId === loopId && !loopHandles.has(loopId)) clearDialog(currentDialog.id)
  reportOverlay()
}

async function openLoopView(
  context: UiPluginContext,
  loop: Pick<LoopSnapshot, 'id' | 'name' | 'worktreeId'>,
  options: { group?: string; activate: boolean }
): Promise<unknown> {
  return context.call('quirky.terminal/openViewTab', {
    workspace: loop.worktreeId,
    ...(options.group === undefined ? {} : { group: options.group }),
    viewId: LOOP_VIEW_ID,
    key: loop.id,
    title: loop.name,
    input: { loopId: loop.id },
    activate: options.activate,
    closeCommand: CLOSE_COMMAND,
    closeMethod: CLOSE_METHOD,
    closeParams: { loopId: loop.id },
    closeContext: true
  })
}

async function resolveWorkspace(
  context: UiPluginContext,
  workspaceValue: unknown,
  groupValue: unknown
): Promise<{ workspace: string; group?: string }> {
  let workspace = optionalText(workspaceValue, 'workspace')
  const group = optionalText(groupValue, 'group')
  if (group !== undefined) {
    const result = await context.call('quirky.terminal/groupInfo', { group })
    if (!isRecord(result) || typeof result.workspace !== 'string' || result.workspace === '') {
      throw new Error('terminal returned an invalid group owner')
    }
    if (workspace !== undefined && workspace !== result.workspace) throw new Error(`group ${group} is not in workspace ${workspace}`)
    workspace = result.workspace
  }
  if (workspace === undefined) {
    const focus = await context.call('quirky.terminal/focusContext', {})
    if (isRecord(focus) && typeof focus.workspace === 'string' && focus.workspace !== '') workspace = focus.workspace
  }
  if (workspace === undefined) throw new Error('workspace or group is required')
  return { workspace, ...(group === undefined ? {} : { group }) }
}

async function newCommand(context: UiPluginContext, raw: unknown): Promise<{ opened: true; workspace: string; group?: string }> {
  const args = argsOf(raw)
  onlyKeys(args, ['workspace', 'group', 'worktree'], 'new')
  void optionalText(args.worktree, 'worktree')
  assertSetupReplaceable()
  const target = await resolveWorkspace(context, args.workspace, args.group)
  assertSetupReplaceable()
  showDialog({ kind: 'setup', id: ++dialogSequence, ...target })
  return { opened: true, ...target }
}

async function openCommand(context: UiPluginContext, raw: unknown): Promise<unknown> {
  const args = argsOf(raw)
  onlyKeys(args, ['loopId'], 'open')
  const loop = loopSummary(await context.call('quirky.loops/get', { loopId: requiredText(args.loopId, 'loopId') }))
  return openLoopView(context, loop, { activate: true })
}

async function setupActionCommand(raw: unknown): Promise<unknown> {
  const args = argsOf(raw)
  onlyKeys(args, ['action', 'params'], 'setup-action')
  const action = requiredText(args.action, 'action')
  const dialog = currentDialog
  const handle = dialog?.kind === 'setup' && setupSurface?.dialogId === dialog.id ? setupSurface.handle : null
  if (handle === null) throw new Error('no live loop setup surface')
  const result = await handle.dispatch(action, objectParams(args.params))
  reportOverlay()
  return result
}

async function loopActionCommand(raw: unknown): Promise<unknown> {
  const args = argsOf(raw)
  onlyKeys(args, ['loopId', 'action', 'params'], 'action')
  const loopId = requiredText(args.loopId, 'loopId')
  const action = requiredText(args.action, 'action')
  const handle = loopHandles.get(loopId)
  if (!handle) throw new Error(`no live loop view surface for ${loopId}`)
  const result = await handle.dispatch(action, objectParams(args.params))
  reportOverlay()
  return result
}

async function closeTabCommand(context: UiPluginContext, raw: unknown): Promise<{ closed: true } | { dialog: true; loopId: string; tabId: string }> {
  const args = argsOf(raw)
  onlyKeys(args, ['loopId', 'tabId'], 'close-tab')
  const loopId = requiredText(args.loopId, 'loopId')
  const tabId = requiredText(args.tabId, 'tabId')
  try {
    const loop = loopSummary(await context.call('quirky.loops/get', { loopId }))
    if (!(await loopTabIsBound(context, loop, tabId))) throw new Error(`no hosted loop tab ${tabId} for ${loopId}`)
    if (isLive(loop)) {
      const dialog = { kind: 'close-loop' as const, id: ++dialogSequence, loopId, tabId, name: loop.name }
      showDialog(dialog)
      return { dialog: true, loopId, tabId }
    }
    await context.call('quirky.terminal/closeTab', { tab: tabId })
    return { closed: true }
  } catch (error) {
    context.toast(CLOSE_FAILURE_TITLE, messageOf(error))
    throw error
  }
}

async function closeChoiceCommand(context: UiPluginContext, raw: unknown): Promise<unknown> {
  const args = argsOf(raw)
  onlyKeys(args, ['choice'], 'close-choice')
  const choice = args.choice
  if (choice !== 'cancel' && choice !== 'keep-running' && choice !== 'stop') {
    throw new Error('choice must be cancel, keep-running, or stop')
  }
  const dialog = currentDialog
  if (dialog?.kind !== 'close-loop') throw new Error('no live loop close dialog')
  const { loopId, tabId } = dialog
  if (choice === 'cancel') {
    clearDialog(dialog.id)
    return { closed: false }
  }
  try {
    const result = await context.call('quirky.loops/closeView', { loopId, tabId, choice })
    if (!isRecord(result) || result.closed !== true) throw new Error('loop service did not confirm the tab close')
    clearDialog(dialog.id)
    return result
  } catch (error) {
    context.toast(CLOSE_FAILURE_TITLE, messageOf(error))
    throw error
  }
}

function CloseLoopDialog({ context, dialog }: { context: UiPluginContext; dialog: Extract<DialogState, { kind: 'close-loop' }> }) {
  const choose = (choice: CloseChoice) => {
    void context.executeCommand(CLOSE_CHOICE_COMMAND, { choice }).catch((error: unknown) => {
      context.toast(CLOSE_FAILURE_TITLE, messageOf(error))
    })
  }
  return (
    <Dialog
      open
      title="Close a running loop?"
      onClose={() => choose('cancel')}
      closeOnBackdrop={false}
      actions={<>
        <Button onClick={() => choose('cancel')}>Cancel</Button>
        <Button onClick={() => choose('keep-running')}>Keep running</Button>
        <Button variant="destructive" onClick={() => choose('stop')}>Stop loop</Button>
      </>}
    >
      <p>{dialog.name}</p>
    </Dialog>
  )
}

function DialogOverlay({ context }: { context: UiPluginContext }) {
  const [dialog, setDialog] = useState<DialogState | null>(() => currentDialog)
  useEffect(() => {
    const update = (next: DialogState | null) => {
      currentDialog = next
      setDialog(next)
      reportOverlay()
    }
    setOverlayDialog = update
    return () => {
      if (setOverlayDialog === update) setOverlayDialog = null
    }
  }, [])
  useEffect(() => {
    reportOverlay()
  }, [dialog])

  if (dialog?.kind === 'setup') {
    return (
      <SetupDialog
        key={dialog.id}
        context={context}
        workspace={dialog.workspace}
        {...(dialog.group === undefined ? {} : { group: dialog.group })}
        onClose={() => clearDialog(dialog.id)}
        onCreated={async (loop) => {
          await openLoopView(context, loop, { group: dialog.group, activate: false })
        }}
        onHandle={(handle) => {
          if (currentDialog?.kind !== 'setup' || currentDialog.id !== dialog.id) return
          if (handle === null) {
            if (setupSurface?.dialogId === dialog.id) setupSurface = null
            if (setupReport?.dialogId === dialog.id) setupReport = null
          } else {
            setupSurface = { dialogId: dialog.id, handle }
          }
          reportOverlay()
        }}
        report={(state) => {
          if (currentDialog?.kind !== 'setup' || currentDialog.id !== dialog.id) return
          setupReport = { dialogId: dialog.id, state }
          reportOverlay()
        }}
      />
    )
  }
  if (dialog?.kind === 'close-loop') return <CloseLoopDialog context={context} dialog={dialog} />
  return null
}

function mountLoopView(context: UiPluginContext, element: HTMLElement, props: MountProps): () => void {
  if (!isRecord(props.input)) throw new Error('loop view input must be an object')
  const loopId = requiredText(props.input.loopId, 'input.loopId')
  const root = createRoot(element)
  let mounted = true
  let handle: SurfaceHandle | null = null
  root.render(
    <LoopView
      context={context}
      loopId={loopId}
      onHandle={(next) => {
        if (!mounted) return
        const previous = handle
        handle = next
        if (next !== null) loopHandles.set(loopId, next)
        else if (previous !== null && loopHandles.get(loopId) === previous) loopHandles.delete(loopId)
        reportOverlay()
      }}
      report={(state) => {
        if (mounted) noteLoopReport(loopId, state)
      }}
    />
  )
  return () => {
    mounted = false
    forgetLoop(loopId, handle)
    queueMicrotask(() => root.unmount())
  }
}

function mountOverlay(context: UiPluginContext, element: HTMLElement, report?: (state: unknown) => void): () => void {
  const root = createRoot(element)
  overlayReporter = report ?? null
  root.render(<DialogOverlay context={context} />)
  reportOverlay()
  return () => {
    root.unmount()
    if (overlayReporter === report) overlayReporter = null
    setOverlayDialog = null
    currentDialog = null
    setupSurface = null
    setupReport = null
    loopHandles.clear()
    loopReports.clear()
    loopReportOrder = []
  }
}

export function activate(context: UiPluginContext): void {
  context.provide(LOOP_VIEW_ID, (element: HTMLElement, props: MountProps) => mountLoopView(context, element, props))
  context.provide(LOOP_OVERLAY_ID, (element: HTMLElement, props: { report?(state: unknown): void }) => mountOverlay(context, element, props.report))
  context.provide(`${COMMAND_PREFIX}new`, (args?: unknown) => newCommand(context, args))
  context.provide(`${COMMAND_PREFIX}setup-action`, (args?: unknown) => setupActionCommand(args))
  context.provide(`${COMMAND_PREFIX}open`, (args?: unknown) => openCommand(context, args))
  context.provide(`${COMMAND_PREFIX}action`, (args?: unknown) => loopActionCommand(args))
  context.provide(`${COMMAND_PREFIX}close-tab`, (args?: unknown) => closeTabCommand(context, args))
  context.provide(`${COMMAND_PREFIX}close-choice`, (args?: unknown) => closeChoiceCommand(context, args))
}

export function deactivate(): void {
  setOverlayDialog = null
  currentDialog = null
  setupSurface = null
  setupReport = null
  overlayReporter = null
  loopHandles.clear()
  loopReports.clear()
  loopReportOrder = []
}
