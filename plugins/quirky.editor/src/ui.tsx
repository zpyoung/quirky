import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { UiPluginContext } from '@quirky/protocol'
import { CloseOverlay } from './window/CloseOverlay'
import { DocumentSurface } from './window/DocumentSurface'
import { ExplorerPanel } from './window/ExplorerPanel'
import { activeDocument } from './window/activeDocument'
import { openExplorerSearch } from './window/explorerIntent'
import { type EditorState, worktreeFromLayout } from './window/editorState'
import { clearOverlayRequests, requestCloseAll, requestSingleClose, showQuickOpen } from './window/overlayState'
import { QuickOpenOverlay } from './window/QuickOpenOverlay'

type MountProps = { input?: unknown; report?(state: unknown): void }
type CommandArgs = Record<string, unknown>

const DOCUMENT_VIEW = 'view:quirky.editor/document'
const EXPLORER_SECTION = 'sidebar-section:quirky.editor/explorer'
const EXPLORER_PANEL = 'panel:quirky.editor/explorer'
const QUICK_OPEN_OVERLAY = 'overlay:quirky.editor/quick-open'
const CLOSE_OVERLAY = 'overlay:quirky.editor/close'
const SOURCE_CONTROL_PANEL = 'panel:quirky.git/source-control'

const editorStyles = `
.qe-document-surface,
.qe-document-message,
.qe-surface-failure,
.qe-explorer,
.qe-modal-layer {
  box-sizing: border-box;
  color: var(--text, #d7dae0);
  font: 13px/1.45 var(--ui-font-family, system-ui, sans-serif);
}
.qe-document-surface *,
.qe-document-message *,
.qe-surface-failure *,
.qe-explorer *,
.qe-modal-layer * {
  box-sizing: border-box;
}
.qe-document-surface {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--bg, #16181d);
}
.qe-document-header {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border, #2b2f3a);
  background: var(--bg-raised, #1d2027);
}
.qe-document-path-group,
.qe-document-actions,
.qe-mode-switch,
.qe-zoom-controls {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.qe-document-path-group { flex: 1 1 auto; overflow: hidden; }
.qe-document-path {
  min-width: 0;
  overflow: hidden;
  color: var(--text, #d7dae0);
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
  background: transparent !important;
  border-color: transparent !important;
}
.qe-document-actions { flex: 0 1 auto; flex-wrap: wrap; justify-content: flex-end; }
.qe-document-surface button,
.qe-explorer button,
.qe-modal-layer button,
.qe-surface-failure button,
.qe-document-message button {
  min-height: 26px;
  padding: 3px 8px;
  color: var(--text, #d7dae0);
  font: inherit;
  white-space: nowrap;
  background: var(--bg-raised, #1d2027);
  border: 1px solid var(--border, #2b2f3a);
  border-radius: 5px;
  cursor: pointer;
}
.qe-document-surface button:hover,
.qe-explorer button:hover,
.qe-modal-layer button:hover,
.qe-surface-failure button:hover,
.qe-document-message button:hover { background: var(--bg-hover, #262a33); }
.qe-document-surface button:disabled,
.qe-explorer button:disabled,
.qe-modal-layer button:disabled { opacity: .55; cursor: not-allowed; }
.qe-document-surface button:focus-visible,
.qe-explorer button:focus-visible,
.qe-modal-layer button:focus-visible,
.qe-surface-failure button:focus-visible,
.qe-document-message button:focus-visible,
.qe-explorer input:focus-visible,
.qe-explorer select:focus-visible,
.qe-modal-layer input:focus-visible { outline: 2px solid var(--accent, #4f8ff7); outline-offset: 1px; }
.qe-document-surface input,
.qe-document-surface select,
.qe-document-surface textarea,
.qe-explorer input,
.qe-explorer select,
.qe-modal-layer input,
.qe-modal-layer textarea {
  min-width: 0;
  padding: 5px 7px;
  color: var(--text, #d7dae0);
  font: inherit;
  background: var(--bg, #16181d);
  border: 1px solid var(--border, #2b2f3a);
  border-radius: 4px;
}
.qe-mode-switch { padding: 2px; background: var(--bg, #16181d); border: 1px solid var(--border, #2b2f3a); border-radius: 6px; }
.qe-mode-switch button { border-color: transparent; background: transparent; }
.qe-mode-switch button[aria-pressed="true"] { color: var(--text, #d7dae0); background: var(--bg-active, #2d3240); border-color: var(--border, #2b2f3a); }
.qe-zoom-controls { gap: 4px; color: var(--muted, #8a909e); }
.qe-file-actions,
.qe-explorer-more-actions,
.qe-explorer-row-actions { position: relative; }
.qe-file-actions > summary,
.qe-explorer-more-actions > summary,
.qe-explorer-row-actions > summary { padding: 4px 7px; color: var(--text, #d7dae0); cursor: pointer; list-style: none; border: 1px solid var(--border, #2b2f3a); border-radius: 5px; }
.qe-file-actions > summary::-webkit-details-marker,
.qe-explorer-more-actions > summary::-webkit-details-marker,
.qe-explorer-row-actions > summary::-webkit-details-marker { display: none; }
.qe-file-actions-menu {
  position: absolute;
  z-index: 8;
  top: calc(100% + 4px);
  right: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 210px;
  max-height: min(70vh, 520px);
  padding: 7px;
  overflow: auto;
  background: var(--bg-raised, #1d2027);
  border: 1px solid var(--border, #2b2f3a);
  border-radius: 7px;
  box-shadow: 0 10px 32px #0008;
}
.qe-file-actions-menu button { width: 100%; text-align: left; }
.qe-file-actions-menu label { display: flex; align-items: center; gap: 7px; padding: 4px; white-space: normal; }
.qe-file-actions-menu input[type="checkbox"],
.qe-explorer input[type="checkbox"] { accent-color: var(--accent, #4f8ff7); }
.qe-range-setting { display: grid !important; grid-template-columns: 1fr auto; align-items: center; gap: 4px 8px !important; }
.qe-range-setting input { grid-column: 1 / -1; width: 100%; padding: 0; }
.qe-inline-rename { display: flex; flex: 0 0 auto; align-items: center; gap: 8px; padding: 8px 10px; border-bottom: 1px solid var(--border, #2b2f3a); }
.qe-inline-rename label { display: flex; flex: 1; align-items: center; gap: 8px; }
.qe-inline-rename input { flex: 1; }
.qe-external-change-banner,
.qe-document-error {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border, #2b2f3a);
}
.qe-external-change-banner { background: color-mix(in srgb, var(--amber, #f0b429) 12%, var(--bg, #16181d)); }
.qe-external-change-banner > span,
.qe-document-error > span { flex: 1 1 260px; }
.qe-document-error,
.qe-editor-error { color: var(--danger, #e5534b); }
.qe-document-content { position: relative; display: flex; flex: 1 1 auto; min-width: 0; min-height: 0; overflow: auto; }
.qe-source-editor { position: relative; display: flex; flex: 1 1 auto; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; }
.qe-source-editor-main { display: flex; flex: 1 1 auto; min-width: 0; min-height: 0; overflow: hidden; }
.qe-codemirror-host { flex: 1 1 auto; min-width: 0; min-height: 0; overflow: hidden; }
.qe-codemirror-host .cm-editor { height: 100%; color: var(--text, #d7dae0); background: var(--bg, #16181d); }
.qe-codemirror-host .cm-scroller { overflow: auto; font-family: var(--terminal-font-family, ui-monospace, SFMono-Regular, monospace); }
.qe-codemirror-host .cm-gutters { color: var(--muted, #8a909e); background: var(--bg-raised, #1d2027); border-right: 1px solid var(--border, #2b2f3a); }
.qe-codemirror-host .cm-activeLineGutter,
.qe-codemirror-host .cm-activeLine { background: color-mix(in srgb, var(--bg-active, #2d3240) 55%, transparent); }
.qe-codemirror-host .cm-focused .cm-selectionBackground,
.qe-codemirror-host .cm-selectionBackground { background: color-mix(in srgb, var(--accent, #4f8ff7) 38%, transparent); }
.qe-editor-minimap { flex: 0 0 96px; width: 96px; height: 100%; border-left: 1px solid var(--border, #2b2f3a); cursor: crosshair; }
.qe-selection-copy-hint { display: flex; flex: 0 0 auto; align-items: center; justify-content: space-between; gap: 8px; padding: 4px 9px; color: var(--muted, #8a909e); border-bottom: 1px solid var(--border, #2b2f3a); }
.qe-editor-error { flex: 0 0 auto; margin: 0; padding: 6px 10px; overflow-wrap: anywhere; }
.qe-source-menu-layer { position: fixed; z-index: 30; inset: 0; }
.qe-source-context-menu { position: fixed; display: flex; flex-direction: column; min-width: 190px; padding: 5px; background: var(--bg-raised, #1d2027); border: 1px solid var(--border, #2b2f3a); border-radius: 6px; box-shadow: 0 8px 28px #0008; }
.qe-source-context-menu button { width: 100%; text-align: left; border: 0; }
.qe-document-message,
.qe-surface-failure { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; padding: 14px; }
.qe-document-message[role="status"],
.qe-surface-loading,
.qe-explorer .muted { color: var(--muted, #8a909e); }
.qe-undo-reload { align-self: flex-start; margin: 6px 10px; }
.qe-compare-dialog,
.qe-close-dialog,
.qe-quick-open {
  width: min(760px, calc(100vw - 28px));
  max-height: min(82vh, 760px);
  padding: 16px;
  overflow: auto;
  color: var(--text, #d7dae0);
  background: var(--bg-raised, #1d2027);
  border: 1px solid var(--border, #2b2f3a);
  border-radius: 10px;
  box-shadow: 0 16px 56px #000a;
}
.qe-close-dialog { width: min(480px, calc(100vw - 28px)); }
.qe-compare-dialog h2,
.qe-close-dialog h2,
.qe-quick-open h2 { margin: 0 0 8px; font-size: 16px; }
.qe-compare-columns { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 10px; margin: 12px 0; }
.qe-compare-columns label { display: flex; flex-direction: column; gap: 5px; min-width: 0; color: var(--muted, #8a909e); }
.qe-compare-columns textarea { min-height: 240px; resize: vertical; color: var(--text, #d7dae0); font-family: var(--terminal-font-family, ui-monospace, monospace); white-space: pre; }
.qe-dialog-actions { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
.qe-dialog-actions .primary { color: #fff; background: var(--accent, #4f8ff7); border-color: var(--accent, #4f8ff7); }
.qe-modal-layer { position: fixed; z-index: 1; inset: 0; display: flex; align-items: center; justify-content: center; padding: 14px; background: #080a0fcc; pointer-events: auto; }
.qe-quick-open { width: min(680px, calc(100vw - 28px)); }
.qe-quick-open > input { width: 100%; margin: 6px 0; }
.qe-quick-open-results { max-height: min(52vh, 460px); margin: 8px 0; padding: 0; overflow: auto; list-style: none; }
.qe-quick-open-results li { margin: 2px 0; }
.qe-quick-open-results button { display: flex; flex-direction: column; align-items: flex-start; width: 100%; padding: 7px 9px; text-align: left; }
.qe-quick-open-results button[aria-selected="true"] { background: var(--bg-active, #2d3240); border-color: var(--accent, #4f8ff7); }
.qe-quick-open-results small { color: var(--muted, #8a909e); overflow-wrap: anywhere; }
.qe-quick-open footer { display: flex; justify-content: space-between; gap: 8px; color: var(--muted, #8a909e); }
.qe-explorer { display: flex; flex-direction: column; width: 100%; height: 100%; min-width: 0; min-height: 0; overflow: hidden; background: var(--bg, #16181d); }
.qe-explorer-toolbar { display: flex; flex: 0 0 auto; align-items: center; flex-wrap: wrap; gap: 5px; padding: 6px; border-bottom: 1px solid var(--border, #2b2f3a); background: var(--bg-raised, #1d2027); }
.qe-explorer-toolbar button { padding-inline: 6px; }
.qe-explorer-root { flex: 1 1 120px; min-width: 0; overflow: hidden; color: var(--muted, #8a909e); text-overflow: ellipsis; white-space: nowrap; }
.qe-explorer-search-mode { display: flex; flex: 0 0 auto; gap: 4px; padding: 7px 8px 2px; }
.qe-explorer-search-mode button { flex: 1; }
.qe-explorer-search-mode button[aria-pressed="true"] { background: var(--bg-active, #2d3240); border-color: var(--accent, #4f8ff7); }
.qe-explorer-query { display: flex; flex: 0 0 auto; gap: 5px; padding: 5px 8px; }
.qe-explorer-query input { flex: 1; width: 100%; }
.qe-content-search-options { display: flex; flex: 0 0 auto; flex-direction: column; gap: 4px; padding: 3px 9px 8px; color: var(--muted, #8a909e); }
.qe-content-search-options label { display: flex; align-items: center; gap: 6px; }
.qe-content-search-options input[placeholder] { width: 100%; }
.qe-explorer-tree,
.qe-explorer-content-results { flex: 1 1 auto; min-height: 0; padding: 4px 5px; overflow: auto; overscroll-behavior: contain; }
.qe-explorer-tree:focus-visible { outline: 1px solid var(--accent, #4f8ff7); outline-offset: -1px; }
.qe-explorer-row { display: flex; align-items: center; gap: 5px; min-width: 0; min-height: 27px; padding: 2px 5px; border-left: 2px solid transparent; cursor: default; }
.qe-explorer-row:hover { background: var(--bg-hover, #262a33); }
.qe-explorer-row.selected { background: var(--bg-active, #2d3240); border-left-color: var(--accent, #4f8ff7); }
.qe-explorer-row.ignored { color: var(--muted, #8a909e); }
.qe-explorer-chevron { flex: 0 0 14px; color: var(--muted, #8a909e); text-align: center; }
.qe-explorer-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.qe-git-status { flex: 0 0 auto; color: var(--amber, #f0b429); font-family: var(--terminal-font-family, monospace); }
.qe-explorer-row-error { color: var(--danger, #e5534b); }
.qe-explorer-row-actions { flex: 0 0 auto; margin-left: auto; }
.qe-explorer-row-actions > summary { padding: 0 5px; border: 0; }
.qe-explorer-row-actions:not([open]) { opacity: .35; }
.qe-explorer-row:hover .qe-explorer-row-actions,
.qe-explorer-row-actions[open] { opacity: 1; }
.qe-explorer-inline-row { display: flex; gap: 5px; padding: 4px 7px; }
.qe-explorer-inline-row input { flex: 1; }
.qe-explorer-content-results > p { margin: 5px; color: var(--muted, #8a909e); }
.qe-search-file { margin: 8px 0; padding: 7px; border: 1px solid var(--border, #2b2f3a); border-radius: 5px; }
.qe-search-file h4 { margin: 0 0 5px; overflow-wrap: anywhere; font-size: 12px; }
.qe-search-file button { display: block; width: 100%; margin: 3px 0; text-align: left; white-space: normal; }
.qe-search-file button small { display: block; color: var(--muted, #8a909e); }
.qe-explorer-footer { display: flex; flex: 0 0 auto; gap: 5px; padding: 6px; border-top: 1px solid var(--border, #2b2f3a); }
.qe-explorer-footer button { flex: 1; }
.qe-editor-error[role="alert"] { overflow-wrap: anywhere; }
@media (max-width: 700px) {
  .qe-document-header { align-items: flex-start; flex-direction: column; }
  .qe-document-actions { justify-content: flex-start; width: 100%; }
  .qe-compare-columns { grid-template-columns: minmax(0, 1fr); }
  .qe-editor-minimap { flex-basis: 64px; width: 64px; }
}
`

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

function installStyles(): () => void {
  const style = document.createElement('style')
  style.dataset.quirkyEditorStyles = 'true'
  style.textContent = editorStyles
  document.head.append(style)
  return () => style.remove()
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

function commandHandlers(context: UiPluginContext): Record<string, (args?: unknown) => unknown> {
  return {
    open: async (rawArgs?: unknown) => {
      const args = asRecord(rawArgs)
      return context.call('quirky.editor/open', { ...args, focus: typeof args.focus === 'boolean' ? args.focus : true })
    },
    'quick-open': (rawArgs?: unknown) => {
      const args = asRecord(rawArgs)
      showQuickOpen(context, worktreeFor(context, args), typeof args.query === 'string' ? args.query : '')
    },
    search: (rawArgs?: unknown) => {
      const args = asRecord(rawArgs)
      const worktree = worktreeFor(context, args)
      if (worktree && typeof args.query === 'string' && args.query !== '') openExplorerSearch(worktree, args.query)
      context.togglePanel(EXPLORER_PANEL, true)
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
    explorer: () => context.togglePanel(EXPLORER_PANEL, true),
    'source-control': () => context.togglePanel(SOURCE_CONTROL_PANEL, true)
  }
}

function configureExplorerPanel(context: UiPluginContext): void {
  try {
    const width = context.getSetting('editorSidebarWidth')
    const activityBarPosition = context.getSetting('activityBarPosition')
    if (typeof width !== 'number' || (activityBarPosition !== 'top' && activityBarPosition !== 'side')) {
      throw new Error('Editor panel settings are missing or have invalid types.')
    }
    void context.call('ui.panel.configure', { id: EXPLORER_PANEL, width, activityBarPosition }).catch((reason: unknown) => {
      context.toast('Unable to configure Explorer layout', reason instanceof Error ? reason.message : String(reason))
    })
  } catch (reason) {
    context.toast('Unable to configure Explorer layout', reason instanceof Error ? reason.message : String(reason))
  }
}

export function activate(context: UiPluginContext): void {
  deactivateCurrent?.()
  const removeStyles = installStyles()

  context.provide(DOCUMENT_VIEW, (element: HTMLElement, props: MountProps) =>
    mount(element, <DocumentSurface context={context} input={props.input} />, props.report, viewReport(props.input))
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
    mount(element, <CloseOverlay report={props.report} />, props.report, { open: false, kind: null, targetCount: 0, dirtyCount: 0, error: null })
  )

  for (const [name, handler] of Object.entries(commandHandlers(context))) {
    context.provide(`command:quirky.editor/${name}`, handler)
  }

  configureExplorerPanel(context)
  const unsubscribe = context.subscribe((event) => {
    if (event.type === 'setting.changed' && (event.id === 'setting:quirky.editor/editorSidebarWidth' || event.id === 'setting:quirky.editor/activityBarPosition')) {
      configureExplorerPanel(context)
    }
  })

  deactivateCurrent = () => {
    unsubscribe()
    clearOverlayRequests()
    removeStyles()
  }
}

export function deactivate(): void {
  deactivateCurrent?.()
  deactivateCurrent = undefined
}
