import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { MountFunction, Session, UiPluginContext } from '@quirky/protocol'
import type { PanelState } from './types'
import { HistoryView } from './window/HistoryView'
import { SessionInfoPanel } from './window/SessionInfoPanel'
import { TranscriptView } from './window/TranscriptView'
import { publishCopyFeedback } from './window/feedback'

const PLUGIN_ID = 'quirky.session-info'
const PANEL_ID = `panel:${PLUGIN_ID}/info`
const HISTORY_VIEW_ID = `view:${PLUGIN_ID}/history`
const TRANSCRIPT_VIEW_ID = `view:${PLUGIN_ID}/transcript`

type CommandArgs = { session?: string; fork?: boolean }
type CommandHandler = (args?: unknown) => Promise<unknown> | unknown

function argsOf(raw: unknown): CommandArgs {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const args: CommandArgs = {}
  if ('session' in raw && typeof raw.session === 'string' && raw.session !== '') args.session = raw.session
  if ('fork' in raw && typeof raw.fork === 'boolean') args.fork = raw.fork
  return args
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function panelState(context: UiPluginContext, session?: string): Promise<PanelState> {
  return await context.call('quirky.session-info/get', session ? { session } : {}) as PanelState
}

async function stateForAction(context: UiPluginContext, session?: string): Promise<PanelState> {
  const state = await panelState(context, session)
  if (!state.info || !state.session) throw new Error('No agent session is available for this action.')
  return state
}

async function selectedSession(context: UiPluginContext, session?: string): Promise<string> {
  if (session) return session
  const state = await panelState(context)
  if (!state.session) throw new Error('No agent session is available for this action.')
  return state.session
}

async function writeClipboard(text: string): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) throw new Error('The clipboard is not available in this window.')
  await navigator.clipboard.writeText(text)
}

async function withToast<T>(context: UiPluginContext, title: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    context.toast(title, messageOf(error))
    throw error
  }
}

async function resume(context: UiPluginContext, session: string, fork: boolean): Promise<Session> {
  const result = await context.call('quirky.session/resume', { session, ...(fork ? { fork: true } : {}) }) as Session
  await context.executeCommand('command:quirky.terminal/open-session', { session: result.id, workspace: result.worktreeId })
  return result
}

function commands(context: UiPluginContext): Record<string, CommandHandler> {
  return {
    open: () => context.togglePanel(PANEL_ID, true),
    'copy-id': (raw) => withToast(context, 'Could not copy ID', async () => {
      const state = await stateForAction(context, argsOf(raw).session)
      const id = state.info!.identity.providerSessionId
      if (!id) throw new Error('This session has no provider ID to copy.')
      await writeClipboard(id)
      publishCopyFeedback({ session: state.session!, kind: 'id' })
      return { copied: true }
    }),
    'open-history': (raw) => withToast(context, 'Could not open session history', async () => {
      const state = await stateForAction(context, argsOf(raw).session)
      context.openView(HISTORY_VIEW_ID, { query: state.info!.identity.providerSessionId ?? state.info!.identity.sessionId })
    }),
    'focus-pane': (raw) => withToast(context, 'Could not focus pane', async () => {
      const state = await stateForAction(context, argsOf(raw).session)
      if (!state.pane) throw new Error('The selected agent session has no terminal pane to focus.')
      await context.executeCommand('command:quirky.terminal/focus-pane', {
        pane: state.pane,
        ...(state.workspace ? { workspace: state.workspace } : {})
      })
    }),
    'open-transcript': (raw) => withToast(context, 'Could not open transcript', async () => {
      const state = await stateForAction(context, argsOf(raw).session)
      if (!state.info!.identity.transcriptPath) throw new Error('This session has no recorded transcript.')
      context.openView(TRANSCRIPT_VIEW_ID, { session: state.session })
    }),
    'reveal-transcript': (raw) => withToast(context, 'Could not reveal transcript', async () => {
      const state = await stateForAction(context, argsOf(raw).session)
      const path = state.info!.identity.transcriptPath
      if (!path) throw new Error('This session has no recorded transcript.')
      await context.call('quirky.terminal/openExternal', { target: path, reveal: true })
      return { ok: true }
    }),
    resume: (raw) => withToast(context, 'Could not resume session', async () => resume(context, await selectedSession(context, argsOf(raw).session), false)),
    fork: (raw) => withToast(context, 'Could not fork session', async () => resume(context, await selectedSession(context, argsOf(raw).session), true)),
    'copy-resume-command': (raw) => withToast(context, 'Could not copy resume command', async () => {
      const args = argsOf(raw)
      const session = await selectedSession(context, args.session)
      const result = await context.call('quirky.session-info/resumeCommand', { session, ...(args.fork === undefined ? {} : { fork: args.fork }) }) as { command: string }
      await writeClipboard(result.command)
      publishCopyFeedback({ session, kind: 'resume-command' })
      context.toast('Copied resume command', 'The command is on the clipboard.')
      return { copied: true }
    })
  }
}

function mount(element: HTMLElement, implementation: ReactNode, report?: (state: unknown) => void): () => void {
  Object.assign(element.style, { display: 'flex', flexDirection: 'column', flex: '1', minHeight: '0', minWidth: '0' })
  const root = createRoot(element)
  root.render(implementation)
  report?.({ state: 'mounted' })
  return () => root.unmount()
}

export function activate(context: UiPluginContext): void {
  const panel: MountFunction = (element, props) => mount(element, <SessionInfoPanel context={context} report={props.report} />)
  const history: MountFunction = (element, props) => mount(element, <HistoryView context={context} input={props.input} />)
  const transcript: MountFunction = (element, props) => mount(element, <TranscriptView context={context} input={props.input} />)

  context.provide(PANEL_ID, panel)
  context.provide(HISTORY_VIEW_ID, history)
  context.provide(TRANSCRIPT_VIEW_ID, transcript)
  for (const [name, handler] of Object.entries(commands(context))) context.provide(`command:${PLUGIN_ID}/${name}`, handler)
}
