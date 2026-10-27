import { createRoot } from 'react-dom/client'
import type { UiPluginContext } from '@quirky/protocol'
import { LedgerApp, LEDGER_PANEL_ID, LEDGER_SETTINGS_VIEW_ID, LEDGER_SIDEBAR_ID, LEDGER_VIEW_ID, type ControlHandler, type LedgerUiMode } from './ui/LedgerApp'
import { LedgerSettings } from './ui/LedgerSettings'
import { LedgerSidebarSection } from './ui/LedgerApp'
import type { LedgerControl, LedgerFilters, LedgerTarget } from './ui/types'

type MountProps = { input?: unknown; report?(state: unknown): void }
type RegisteredController = { id: number; mode: LedgerUiMode; handle: ControlHandler }
type WaitingControl = { command: LedgerControl; resolve(value: unknown): void; reject(error: unknown): void }
const CONTROL_ACTIONS = new Set(['scope', 'filters', 'sort', 'selection', 'detail', 'new', 'edit', 'triage', 'settings'])

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function target(value: unknown): LedgerTarget | undefined {
  const source = record(value)
  const result: LedgerTarget = {}
  if (typeof source.workspaceId === 'string') result.workspaceId = source.workspaceId
  if (typeof source.ledgerId === 'string') result.ledgerId = source.ledgerId
  if (typeof source.group === 'boolean') result.group = source.group
  if (typeof source.groupSelector === 'string') result.groupSelector = source.groupSelector
  if (source.owner !== undefined) {
    const owner = record(source.owner)
    if ((owner.tier !== 'project' && owner.tier !== 'group') || typeof owner.id !== 'string' || owner.id === '') throw new Error('Ledger target owner must include a project/group tier and id.')
    result.owner = { tier: owner.tier, id: owner.id }
  }
  if (Object.keys(result).length === 0 && Object.keys(source).length > 0) throw new Error('Ledger target must include a supported selector.')
  return Object.keys(result).length > 0 ? result : undefined
}

function controlArgs(value: unknown): LedgerControl {
  const source = record(value)
  if (typeof source.action !== 'string' || !CONTROL_ACTIONS.has(source.action)) throw new Error('Ledger control action must be scope, filters, sort, selection, detail, new, edit, triage, or settings.')
  const command: LedgerControl = { action: source.action as LedgerControl['action'] }
  if (source.target !== undefined) {
    const parsed = target(source.target)
    if (!parsed) throw new Error('Ledger target must identify a workspace, owner, or ledger.')
    command.target = parsed
  }
  if (typeof source.id === 'string' && source.id !== '') command.id = source.id
  if (source.scope !== undefined) {
    if (source.scope !== 'worktree' && source.scope !== 'project' && source.scope !== 'group') throw new Error('Ledger scope must be worktree, project, or group.')
    command.scope = source.scope
  }
  if (source.sort !== undefined) {
    if (source.sort !== 'activity' && source.sort !== 'sequence' && source.sort !== 'title') throw new Error('Ledger sort must be activity, sequence, or title.')
    command.sort = source.sort
  }
  if (source.filters !== undefined) {
    const filters = record(source.filters)
    const parsed: LedgerFilters = {}
    if (filters.type !== undefined) {
      if (!['bug', 'deferred', 'test-gap', 'proposal', 'decision'].includes(String(filters.type))) throw new Error('Unknown ledger type filter.')
      parsed.type = filters.type as LedgerFilters['type']
    }
    if (filters.state !== undefined) {
      if (!['open', 'resolved', 'archived'].includes(String(filters.state))) throw new Error('Unknown ledger state filter.')
      parsed.state = filters.state as LedgerFilters['state']
    }
    if (typeof filters.reviewed === 'boolean') parsed.reviewed = filters.reviewed
    if (typeof filters.stale === 'boolean') parsed.stale = filters.stale
    if (typeof filters.workspaceId === 'string') parsed.workspaceId = filters.workspaceId
    if (typeof filters.branch === 'string') parsed.branch = filters.branch
    if (typeof filters.search === 'string') parsed.search = filters.search
    command.filters = parsed
  }
  if (source.selections !== undefined) {
    if (!Array.isArray(source.selections)) throw new Error('Ledger selections must be an array of id/revision snapshots.')
    command.selections = source.selections.filter((selection): selection is { id: string; revision: number } => {
      const item = record(selection)
      return typeof item.id === 'string' && typeof item.revision === 'number' && Number.isSafeInteger(item.revision) && item.revision > 0
    })
  }
  if (command.action === 'scope' && !command.scope) throw new Error('Ledger scope requires a scope.')
  if (command.action === 'sort' && !command.sort) throw new Error('Ledger sort requires a sort mode.')
  if ((command.action === 'detail' || command.action === 'edit') && !command.id) throw new Error(`Ledger ${command.action} requires an entry id.`)
  return command
}

function openArgs(value: unknown): { target?: LedgerTarget } {
  const source = record(value)
  const parsed = target(source.target)
  if (source.target !== undefined && !parsed) throw new Error('Open Ledger target is invalid.')
  return parsed ? { target: parsed } : {}
}

/** Mounts the unified ledger page, panel, navigation entry, settings view and command router. */
export function activate(context: UiPluginContext): void {
  const controllers = new Map<number, RegisteredController>()
  const pending: WaitingControl[] = []
  let nextControllerId = 0

  const registerControl = (handle: ControlHandler, mode: LedgerUiMode) => {
    const id = ++nextControllerId
    controllers.set(id, { id, mode, handle })
    if (mode === 'page') {
      let queue: Promise<void> = Promise.resolve()
      for (const item of pending.splice(0)) {
        queue = queue.then(() => handle(item.command)).then(() => item.resolve(undefined), item.reject)
      }
    }
    return () => { controllers.delete(id) }
  }

  const currentController = (): RegisteredController | undefined => {
    const layout = context.getLayout()
    const mounted = [...controllers.values()]
    const byMode = (mode: LedgerUiMode) => mounted.filter((controller) => controller.mode === mode).at(-1)
    if (layout.focus === 'panel' && layout.panel === LEDGER_PANEL_ID) return byMode('panel')
    if (layout.focus === 'view' && layout.view?.id === LEDGER_VIEW_ID) return byMode('page')
    if (layout.view?.id === LEDGER_VIEW_ID) return byMode('page')
    if (layout.panel === LEDGER_PANEL_ID) return byMode('panel')
    return undefined
  }

  context.provide(LEDGER_VIEW_ID, (element: HTMLElement, props: MountProps) => {
    const root = createRoot(element)
    root.render(<LedgerApp context={context} input={props.input} report={props.report} mode="page" registerControl={registerControl} />)
    return () => root.unmount()
  })
  context.provide(LEDGER_PANEL_ID, (element: HTMLElement, props: MountProps) => {
    const root = createRoot(element)
    root.render(<LedgerApp context={context} input={props.input} report={props.report} mode="panel" registerControl={registerControl} />)
    return () => root.unmount()
  })
  context.provide(LEDGER_SIDEBAR_ID, (element: HTMLElement, props: MountProps) => {
    const root = createRoot(element)
    root.render(<LedgerSidebarSection context={context} report={props.report} />)
    return () => root.unmount()
  })
  context.provide(LEDGER_SETTINGS_VIEW_ID, (element: HTMLElement, props: MountProps) => {
    const root = createRoot(element)
    root.render(<LedgerSettings context={context} input={props.input} report={props.report} />)
    return () => root.unmount()
  })

  context.provide('command:quirky.ledger/open', (args?: unknown) => context.openView(LEDGER_VIEW_ID, openArgs(args)))
  context.provide('command:quirky.ledger/control', async (args?: unknown) => {
    const command = controlArgs(args)
    const controller = currentController()
    if (controller) return controller.handle(command)
    const { promise, resolve, reject } = Promise.withResolvers<unknown>()
    const waiting = { command, resolve, reject }
    pending.push(waiting)
    try {
      context.openView(LEDGER_VIEW_ID, command.target ? { target: command.target } : undefined)
    } catch (error) {
      pending.splice(pending.indexOf(waiting), 1)
      reject(error)
    }
    return promise
  })
}
