import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Button, Dialog, FormRow } from '@quirky/ui'
import { createRoot } from 'react-dom/client'
import type { UiPluginContext } from '@quirky/protocol'
import { CloseOverlay } from './window/CloseOverlay'
import { DocumentSurface } from './window/DocumentSurface'
import { ExplorerPanel } from './window/ExplorerPanel'
import { activeDocument, type ActiveDocumentCommand } from './window/activeDocument'
import { openExplorerSearch } from './window/explorerIntent'
import { type EditorState, worktreeFromLayout } from './window/editorState'
import { clearOverlayRequests, requestCloseAll, requestSingleClose, showMarkdownOpen, showNewMarkdown, showQuickOpen } from './window/overlayState'
import { QuickOpenOverlay } from './window/QuickOpenOverlay'

type MountProps = { input?: unknown; report?(state: unknown): void }
type CommandArgs = Record<string, unknown>

const DOCUMENT_VIEW = 'view:quirky.editor/document'
const EXPLORER_SECTION = 'sidebar-section:quirky.editor/explorer'
const EXPLORER_PANEL = 'panel:quirky.editor/explorer'
const QUICK_OPEN_OVERLAY = 'overlay:quirky.editor/quick-open'
const CLOSE_OVERLAY = 'overlay:quirky.editor/close'
const SOURCE_CONTROL_PANEL = 'panel:quirky.git/source-control'


let deactivateCurrent: (() => void) | undefined

function asRecord(value: unknown): CommandArgs {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as CommandArgs : {}
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function worktreeFor(context: UiPluginContext, args: CommandArgs): string | undefined {
  return nonEmptyString(args.worktree) ?? activeDocument()?.worktreeId ?? worktreeFromLayout(context)
}


function mount(element: HTMLElement, node: ReactNode, report: MountProps['report'], state: unknown): () => void {
  const root = createRoot(element)
  root.render(node)
  report?.(state)
  return () => root.unmount()
}

function viewReport(input: unknown): Record<string, unknown> {
  const value = asRecord(input)
  const mode = value.mode
  return {
    mounted: true,
    bufferId: nonEmptyString(value.bufferId) ?? null,
    tabId: nonEmptyString(value.tabId) ?? null,
    mode: mode === 'source' || mode === 'rich' || mode === 'preview' ? mode : null
  }
}
type SaveAsBuffer = { id: string; relativePath: string; contentRevision: number; untitled: boolean }
type SaveAsReadResult = { buffer?: SaveAsBuffer }
type SaveAsRequest = {
  id: number
  context: UiPluginContext
  bufferId: string
  relativePath: string
  expectedRevision: number
  resolve(value: unknown): void
  reject(reason: Error): void
}

let nextSaveAsId = 0
let saveAsRequest: SaveAsRequest | null = null
const saveAsListeners = new Set<() => void>()

function notifySaveAs(): void {
  for (const listener of saveAsListeners) listener()
}

function subscribeSaveAs(listener: () => void): () => void {
  saveAsListeners.add(listener)
  return () => saveAsListeners.delete(listener)
}

function useSaveAsRequest(): SaveAsRequest | null {
  return useSyncExternalStore(subscribeSaveAs, () => saveAsRequest, () => null)
}

function suggestedSaveAsPath(relativePath: string): string {
  const slash = relativePath.lastIndexOf('/')
  const directory = slash < 0 ? '' : relativePath.slice(0, slash + 1)
  const filename = slash < 0 ? relativePath : relativePath.slice(slash + 1)
  const replacement = /^untitled(?:-\d+)?(\.(?:md|markdown|mdx))$/i.exec(filename)
  return `${directory}${replacement ? `document${replacement[1]}` : filename}`
}

function requestSaveAs(context: UiPluginContext, buffer: SaveAsBuffer): Promise<unknown> {
  if (saveAsRequest !== null) return Promise.reject(new Error('A Save As dialog is already open.'))
  const { promise, resolve, reject } = Promise.withResolvers<unknown>()
  saveAsRequest = {
    id: ++nextSaveAsId,
    context,
    bufferId: buffer.id,
    relativePath: buffer.relativePath,
    expectedRevision: buffer.contentRevision,
    resolve,
    reject
  }
  notifySaveAs()
  return promise
}

function cancelSaveAs(id: number): void {
  if (saveAsRequest?.id !== id) return
  const request = saveAsRequest
  saveAsRequest = null
  notifySaveAs()
  request.reject(new Error('Save As canceled; the untitled document remains open.'))
}

function clearSaveAsRequest(): void {
  if (saveAsRequest === null) return
  cancelSaveAs(saveAsRequest.id)
}

function editorUiContext(context: UiPluginContext): UiPluginContext {
  const originalCall = context.call.bind(context)
  const call = async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
    const request = params ?? {}
    if (method === 'quirky.editor/save' && params && params.trigger !== 'autosave') {
      const bufferId = nonEmptyString(request.bufferId)
      if (bufferId) {
        const result = await originalCall('quirky.editor/read', { bufferId, action: 'buffer' }) as SaveAsReadResult
        if (result.buffer?.untitled) return await requestSaveAs(context, result.buffer)
      }
    }
    if (method === 'quirky.editor/close' && params?.choice === 'save') {
      const bufferId = nonEmptyString(request.bufferId)
      if (bufferId) {
        const result = await originalCall('quirky.editor/read', { bufferId, action: 'buffer' }) as SaveAsReadResult
        if (result.buffer?.untitled) {
          try {
            await requestSaveAs(context, result.buffer)
          } catch (reason) {
            await originalCall(method, { ...request, choice: 'cancel' }).catch(() => undefined)
            throw reason
          }
          const closeParams = { ...request }
          delete closeParams.choice
          return await originalCall(method, closeParams)
        }
      }
    }
    return await originalCall(method, params)
  }
  return new Proxy(context, {
    get(target, property, receiver) {
      if (property === 'call') return call
      const value = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
}

function SaveAsOverlay() {
  const request = useSaveAsRequest()
  const [path, setPath] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const pathInput = useRef<HTMLInputElement>(null)
  useEffect(() => {
    setPath(request ? suggestedSaveAsPath(request.relativePath) : '')
    setError(null)
    setBusy(false)
  }, [request?.id, request?.relativePath])
  useEffect(() => {
    if (!request) return
    const focusTimer = window.setTimeout(() => pathInput.current?.focus(), 0)
    return () => window.clearTimeout(focusTimer)
  }, [request?.id])

  if (!request) return null
  const cancel = () => {
    if (!busy) cancelSaveAs(request.id)
  }
  const submit = async () => {
    const destination = path.trim()
    if (destination === '') {
      setError('Enter a worktree-relative Markdown path.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const saved = await request.context.call('quirky.editor/saveAs', {
        bufferId: request.bufferId,
        path: destination,
        expectedRevision: request.expectedRevision
      })
      if (saveAsRequest?.id !== request.id) return
      saveAsRequest = null
      notifySaveAs()
      request.resolve(saved)
    } catch (reason) {
      if (saveAsRequest?.id !== request.id) return
      setError(reason instanceof Error ? reason.message : String(reason))
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      title="Save Markdown As"
      onClose={cancel}
      actions={
        <>
          <Button disabled={busy} onClick={cancel}>Cancel</Button>
          <Button variant="primary" disabled={busy || path.trim() === ''} onClick={() => void submit()}>Save</Button>
        </>
      }
    >
      <div className="qe-saveas-dialog">
        <p>Choose a new worktree-relative path for <strong>{request.relativePath}</strong>. Existing files are never replaced.</p>
        <FormRow label="Relative path" htmlFor="qe-saveas-path">
          <input
            ref={pathInput}
            id="qe-saveas-path"
            className="ui-text-field__input qe-saveas-field"
            value={path}
            placeholder="notes/plan.md"
            disabled={busy}
            onChange={(event) => setPath(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') { event.preventDefault(); void submit() }
              if (event.key === 'Escape') { event.preventDefault(); cancel() }
            }}
          />
        </FormRow>
        {error && <p className="qe-editor-error" role="alert">{error}</p>}
      </div>
    </Dialog>
  )
}


async function closeTarget(context: UiPluginContext, rawArgs: unknown): Promise<boolean> {
  const args = asRecord(rawArgs)
  let bufferId = nonEmptyString(args.bufferId)
  let tabId = nonEmptyString(args.tabId)
  const active = activeDocument()

  if (tabId && !bufferId) {
    const state = await context.call('quirky.editor/state', {})
    const tab = (state as EditorState).tabs.find((candidate) => candidate.tabId === tabId)
    if (tab) bufferId = tab.bufferId
  }
  if (!bufferId && active) {
    bufferId = active.bufferId
    tabId ??= active.tabId ?? undefined
  } else if (bufferId && !tabId && active?.bufferId === bufferId) {
    tabId = active.tabId ?? undefined
  }
  if (!bufferId) throw new Error('There is no active editor document to close.')
  return requestSingleClose(context, bufferId, tabId)
}

function runActiveDocumentCommand(command: ActiveDocumentCommand, rawArgs?: unknown): Promise<unknown> {
  const active = activeDocument()
  if (!active) throw new Error(`There is no focused editor document for ${command}.`)
  return active.runCommand(command, asRecord(rawArgs))
}

function commandHandlers(context: UiPluginContext): Record<string, (args?: unknown) => unknown> {
  return {
    open: async (rawArgs?: unknown) => {
      const args = asRecord(rawArgs)
      return context.call('quirky.editor/open', { ...args, focus: typeof args.focus === 'boolean' ? args.focus : true })
    },
    'quick-open': (rawArgs?: unknown) => {
      const args = asRecord(rawArgs)
      showQuickOpen(context, worktreeFor(context, args), typeof args.query === 'string' ? args.query : '', 'files', typeof args.group === 'string' ? args.group : undefined)
      return { opened: true }
    },
    search: (rawArgs?: unknown) => {
      const args = asRecord(rawArgs)
      const worktree = worktreeFor(context, args)
      if (worktree && typeof args.query === 'string' && args.query !== '') openExplorerSearch(worktree, args.query)
      context.togglePanel(EXPLORER_PANEL, true)
      return { panel: EXPLORER_PANEL, opened: true }
    },
    save: async (rawArgs?: unknown) => {
      const bufferId = nonEmptyString(asRecord(rawArgs).bufferId)
      const active = activeDocument()
      if (active && (!bufferId || bufferId === active.bufferId)) return active.save()
      if (active) await active.flush()
      const target = bufferId ?? active?.bufferId
      if (!target) throw new Error('There is no active editor document to save.')
      return context.call('quirky.editor/save', { bufferId: target, trigger: 'user' })
    },
    close: (rawArgs?: unknown) => closeTarget(context, rawArgs),
    'close-all': (rawArgs?: unknown) => requestCloseAll(context, worktreeFor(context, asRecord(rawArgs))),
    reopen: async (rawArgs?: unknown) => {
      const args = asRecord(rawArgs)
      const worktree = worktreeFor(context, args)
      const result = await context.call('quirky.editor/reopen', {
        ...(worktree ? { worktree } : {}),
        focus: typeof args.focus === 'boolean' ? args.focus : true
      })
      if (result === null) context.toast('Nothing to reopen', 'There are no recently closed editor files.')
      return result
    },
    explorer: () => {
      context.togglePanel(EXPLORER_PANEL, true)
      return { panel: EXPLORER_PANEL, opened: true }
    },
    'source-control': () => {
      context.togglePanel(SOURCE_CONTROL_PANEL, true)
      return { panel: SOURCE_CONTROL_PANEL, opened: true }
    },
    find: (args?: unknown) => runActiveDocumentCommand('find', args),
    replace: (args?: unknown) => runActiveDocumentCommand('replace', args),
    'markdown-preview': (args?: unknown) => runActiveDocumentCommand('markdown-preview', args),
    'toggle-word-wrap': (args?: unknown) => runActiveDocumentCommand('toggle-word-wrap', args),
    'copy-context': (args?: unknown) => runActiveDocumentCommand('copy-context', args),
    'add-review-note': (args?: unknown) => runActiveDocumentCommand('add-review-note', args),
    'zoom-in': (args?: unknown) => runActiveDocumentCommand('zoom-in', args),
    'zoom-out': (args?: unknown) => runActiveDocumentCommand('zoom-out', args),
    'reset-zoom': (args?: unknown) => runActiveDocumentCommand('reset-zoom', args),
    'toggle-right-sidebar': () => {
      const layout = context.getLayout()
      return layout.panel === EXPLORER_PANEL
        ? context.call('ui.panel.close', {})
        : context.call('ui.panel.open', { id: EXPLORER_PANEL })
    },
    'new-markdown': (rawArgs?: unknown) => {
      const args = asRecord(rawArgs)
      showNewMarkdown(context, worktreeFor(context, args), typeof args.group === 'string' ? args.group : undefined)
      return { opened: true, dialog: 'new-markdown' }
    },
    'open-markdown': (rawArgs?: unknown) => {
      const args = asRecord(rawArgs)
      showMarkdownOpen(context, worktreeFor(context, args), typeof args.group === 'string' ? args.group : undefined)
      return { opened: true, dialog: 'open-markdown' }
    }
  }
}

function configureExplorerPanel(context: UiPluginContext): void {
  try {
    const width = context.getSetting('editorSidebarWidth')
    if (typeof width !== 'number') {
      throw new Error('Editor panel width is missing or has an invalid type.')
    }
    void context.call('ui.panel.configure', { id: EXPLORER_PANEL, width }).catch((reason: unknown) => {
      context.toast('Unable to configure Explorer layout', reason instanceof Error ? reason.message : String(reason))
    })
  } catch (reason) {
    context.toast('Unable to configure Explorer layout', reason instanceof Error ? reason.message : String(reason))
  }
}

export function activate(context: UiPluginContext): void {
  const uiContext = editorUiContext(context)
  deactivateCurrent?.()

  context.provide(DOCUMENT_VIEW, (element: HTMLElement, props: MountProps) =>
    mount(element, <DocumentSurface context={uiContext} input={props.input} />, props.report, viewReport(props.input))
  )
  const mountExplorer = (element: HTMLElement, props: MountProps) =>
    mount(element, <ExplorerPanel context={context} report={props.report} />, props.report, {
      mounted: true,
      worktreeId: worktreeFor(context, {}) ?? null
    })
  context.provide(EXPLORER_SECTION, mountExplorer)
  context.provide(EXPLORER_PANEL, mountExplorer)
  context.provide(QUICK_OPEN_OVERLAY, (element: HTMLElement, props: MountProps) =>
    mount(element, <QuickOpenOverlay context={context} report={props.report} />, props.report, { open: false, requestId: null })
  )
  context.provide(CLOSE_OVERLAY, (element: HTMLElement, props: MountProps) =>
    mount(element, <><CloseOverlay report={props.report} /><SaveAsOverlay /></>, props.report, { open: false, kind: null, targetCount: 0, dirtyCount: 0, error: null })
  )

  for (const [name, handler] of Object.entries(commandHandlers(uiContext))) {
    context.provide(`command:quirky.editor/${name}`, handler)
  }

  configureExplorerPanel(context)
  const unsubscribe = context.subscribe((event) => {
    if (event.type === 'setting.changed' && event.id === 'setting:quirky.editor/editorSidebarWidth') {
      configureExplorerPanel(context)
    }
  })

  deactivateCurrent = () => {
    unsubscribe()
    clearOverlayRequests()
    clearSaveAsRequest()
  }
}

export function deactivate(): void {
  deactivateCurrent?.()
  deactivateCurrent = undefined
}
