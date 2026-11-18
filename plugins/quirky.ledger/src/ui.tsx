import { createRoot } from 'react-dom/client'
import type { UiPluginContext } from '@quirky/protocol'
import { LedgerApp, LEDGER_PANEL_ID, LEDGER_SETTINGS_VIEW_ID, LEDGER_SIDEBAR_ID, LEDGER_VIEW_ID, type ControlHandler, type LedgerUiMode } from './ui/LedgerApp'
import { LedgerSettings } from './ui/LedgerSettings'
import { LedgerSidebarSection } from './ui/LedgerApp'
import type { LedgerControl, LedgerFilters, LedgerTarget } from './ui/types'

type MountProps = { input?: unknown; report?(state: unknown): void }
type RegisteredController = { id: number; mode: LedgerUiMode; instance: string; handle: ControlHandler }
type WaitingControl = { command: LedgerControl; resolve(value: unknown): void; reject(error: unknown): void }
const CONTROL_ACTIONS: Record<string, true> = {
  scope: true, filters: true, sort: true, selection: true, detail: true, new: true, edit: true, triage: true, settings: true,
  choose: true, chooser: true, refresh: true, 'filters-open': true, prepare: true, confirm: true, dismiss: true
}
const CONTROL_RESOURCES: Record<string, true> = { entries: true, catalog: true, directory: true, candidates: true, detail: true }
const PREPARE_KINDS: Record<string, true> = { 'bulk-state': true, 'delete-entries': true, 'delete-ledger': true, attach: true }
const DIALOGS: Record<string, true> = { confirmation: true, detail: true, form: true, triage: true }
const MAX_SELECTIONS = 10_000

function owner(value: unknown): { tier: 'project' | 'group'; id: string } {
  const source = record(value)
  if ((source.tier !== 'project' && source.tier !== 'group') || typeof source.id !== 'string' || source.id.trim() === '') {
    throw new Error('Ledger owner must include a project/group tier and id.')
  }
  return { tier: source.tier, id: source.id }
}

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
  if (source.owner !== undefined) result.owner = owner(source.owner)
  if (Object.keys(result).length === 0 && Object.keys(source).length > 0) throw new Error('Ledger target must include a supported selector.')
  return Object.keys(result).length > 0 ? result : undefined
}

function controlArgs(value: unknown): LedgerControl {
  const source = record(value)
  if (typeof source.action !== 'string' || !Object.hasOwn(CONTROL_ACTIONS, source.action)) {
    throw new Error('Ledger control action is not supported.')
  }
  const action = source.action as LedgerControl['action']
  const command: LedgerControl = { action }
  if (source.instance !== undefined) {
    if (typeof source.instance !== 'string' || source.instance.trim() === '') throw new Error('Ledger UI instance must be a nonempty string.')
    command.instance = source.instance
  }
  if (source.target !== undefined) {
    if (action === 'prepare' || action === 'confirm' || action === 'dismiss') throw new Error(`Ledger ${action} cannot include a target.`)
    const parsed = target(source.target)
    if (!parsed) throw new Error('Ledger target must identify a workspace, owner, or ledger.')
    command.target = parsed
  }
  if (action === 'confirm' && Object.keys(source).some((key) => key !== 'action' && key !== 'instance')) throw new Error('Ledger confirm does not accept a confirmation body.')
  if (action === 'dismiss' && Object.keys(source).some((key) => key !== 'action' && key !== 'instance' && key !== 'dialog')) throw new Error('Ledger dismiss accepts only a dialog.')
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
    if (action === 'prepare') {
      if (source.selections.length < 1 || source.selections.length > MAX_SELECTIONS) throw new Error(`Ledger preparation requires 1 to ${MAX_SELECTIONS} entry snapshots.`)
      const seen = new Set<string>()
      command.selections = source.selections.map((selection) => {
        const item = record(selection)
        if (typeof item.id !== 'string' || item.id.trim() === '' || typeof item.revision !== 'number' || !Number.isSafeInteger(item.revision) || item.revision < 1) {
          throw new Error('Ledger preparation selections require nonempty ids and positive safe revisions.')
        }
        if (seen.has(item.id)) throw new Error('Ledger preparation selections cannot contain duplicate entry ids.')
        seen.add(item.id)
        return { id: item.id, revision: item.revision }
      })
    } else {
      command.selections = source.selections.filter((selection): selection is { id: string; revision: number } => {
        const item = record(selection)
        return typeof item.id === 'string' && typeof item.revision === 'number' && Number.isSafeInteger(item.revision) && item.revision > 0
      })
    }
  }
  if (source.resource !== undefined) {
    if (typeof source.resource !== 'string' || !Object.hasOwn(CONTROL_RESOURCES, source.resource)) throw new Error('Ledger refresh resource is not supported.')
    command.resource = source.resource as NonNullable<LedgerControl['resource']>
  }
  if (source.open !== undefined) {
    if (typeof source.open !== 'boolean') throw new Error('Ledger filters-open requires a boolean open value.')
    command.open = source.open
  }
  if (source.replace !== undefined) {
    if (typeof source.replace !== 'boolean') throw new Error('Ledger filters replace must be boolean.')
    command.replace = source.replace
  }
  if (source.selectionScope !== undefined) {
    if (source.selectionScope !== 'entries' && source.selectionScope !== 'triage') throw new Error('Ledger selection scope must be entries or triage.')
    command.selectionScope = source.selectionScope
  }
  if (source.kind !== undefined) {
    if (typeof source.kind !== 'string' || !Object.hasOwn(PREPARE_KINDS, source.kind)) throw new Error('Ledger confirmation kind is not supported.')
    command.kind = source.kind as NonNullable<LedgerControl['kind']>
  }
  if (source.state !== undefined) {
    if (source.state !== 'resolved' && source.state !== 'archived') throw new Error('Ledger bulk state must be resolved or archived.')
    command.state = source.state
  }
  if (source.attachTo !== undefined) command.attachTo = owner(source.attachTo)
  if (source.dialog !== undefined) {
    if (typeof source.dialog !== 'string' || !Object.hasOwn(DIALOGS, source.dialog)) throw new Error('Ledger dialog is not supported.')
    command.dialog = source.dialog as NonNullable<LedgerControl['dialog']>
  }
  if (action === 'scope' && !command.scope) throw new Error('Ledger scope requires a scope.')
  if (action === 'sort' && !command.sort) throw new Error('Ledger sort requires a sort mode.')
  if ((action === 'detail' || action === 'edit') && !command.id) throw new Error(`Ledger ${action} requires an entry id.`)
  if (action === 'choose' && !command.target) throw new Error('Ledger choose requires a target.')
  if (action === 'refresh' && !command.resource) throw new Error('Ledger refresh requires a resource.')
  if (action === 'filters-open' && command.open === undefined) throw new Error('Ledger filters-open requires a boolean open value.')
  if (action === 'prepare') {
    if (!command.kind) throw new Error('Ledger prepare requires a confirmation kind.')
    if (command.kind === 'bulk-state' && !command.state) throw new Error('Ledger bulk-state preparation requires a state.')
    if (command.kind === 'attach' && !command.attachTo) throw new Error('Ledger attach preparation requires an owner.')
  }
  if (action === 'dismiss' && !command.dialog) throw new Error('Ledger dismiss requires a dialog.')
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

  const registerControl = (handle: ControlHandler, mode: LedgerUiMode, instance: string) => {
    const id = ++nextControllerId
    controllers.set(id, { id, mode, instance, handle })
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

  // Slot cleanup may run during the shell's React commit; nested roots unmount afterward.
  context.provide(LEDGER_VIEW_ID, (element: HTMLElement, props: MountProps) => {
    const root = createRoot(element)
    root.render(<LedgerApp context={context} input={props.input} report={props.report} mode="page" registerControl={registerControl} />)
    return () => queueMicrotask(() => root.unmount())
  })
  context.provide(LEDGER_PANEL_ID, (element: HTMLElement, props: MountProps) => {
    const root = createRoot(element)
    root.render(<LedgerApp context={context} input={props.input} report={props.report} mode="panel" registerControl={registerControl} />)
    return () => queueMicrotask(() => root.unmount())
  })
  context.provide(LEDGER_SIDEBAR_ID, (element: HTMLElement, props: MountProps) => {
    const root = createRoot(element)
    root.render(<LedgerSidebarSection context={context} report={props.report} />)
    return () => queueMicrotask(() => root.unmount())
  })
  context.provide(LEDGER_SETTINGS_VIEW_ID, (element: HTMLElement, props: MountProps) => {
    const root = createRoot(element)
    root.render(<LedgerSettings context={context} input={props.input} report={props.report} />)
    return () => queueMicrotask(() => root.unmount())
  })

  context.provide('command:quirky.ledger/open', (args?: unknown) => context.openView(LEDGER_VIEW_ID, openArgs(args)))
  context.provide('command:quirky.ledger/control', async (args?: unknown) => {
    const command = controlArgs(args)
    const controller = command.instance === undefined
      ? currentController()
      : [...controllers.values()].find((candidate) => candidate.instance === command.instance)
    if (command.instance !== undefined && !controller) throw new Error('Ledger UI instance is no longer mounted.')
    if (controller) return controller.handle(command)
    if (command.action === 'prepare' || command.action === 'confirm' || command.action === 'dismiss') {
      throw new Error('Ledger action requires a mounted ledger.')
    }
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
