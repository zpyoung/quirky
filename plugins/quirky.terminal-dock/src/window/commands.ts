import type { UiPluginContext } from '@quirky/protocol'
import type { DockState } from '../types'
import type { ComposerActions } from './Composer'

const PLUGIN_METHOD = 'quirky.terminal-dock/'
const SETTINGS_VIEW = 'view:quirky.terminal-dock/settings'

type Args = Record<string, unknown>
type CommandResult = { ok: false; reason: string }
type HandleMap = Map<string, ComposerActions>

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}



function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function readDockState(value: unknown, pane: string): DockState | null {
  if (!record(value) || value.pane !== pane || typeof value.revision !== 'number' || typeof value.docked !== 'boolean' || typeof value.passthrough !== 'boolean') return null
  return value as unknown as DockState
}

async function paneFrom(context: UiPluginContext, args: Args): Promise<string | CommandResult> {
  if ('pane' in args) {
    if (typeof args.pane !== 'string' || args.pane === '') return { ok: false, reason: 'pane must be a non-empty string.' }
    return args.pane
  }
  let value: unknown
  try {
    value = await context.call('ui.state', {})
  } catch (error) {
    return { ok: false, reason: `Could not inspect this window's terminal panes: ${errorText(error)}` }
  }
  if (!record(value) || !Array.isArray(value.slots)) return { ok: false, reason: 'This window has no terminal workspace report.' }
  const candidates: { pane: string; focused: boolean; focusSequence: number }[] = []
  for (const slot of value.slots) {
    if (!record(slot) || (slot.kind !== 'view' && slot.kind !== 'overlay') || slot.plugin !== 'quirky.terminal' ||
      slot.shown !== true || !record(slot.report) || slot.kind === 'overlay' && slot.report.shown !== true) continue
    const pane = slot.report.focusedPane
    if (typeof pane !== 'string' || pane === '') continue
    const focusSequence = typeof slot.report.focusSequence === 'number' &&
      Number.isSafeInteger(slot.report.focusSequence) && slot.report.focusSequence >= 0 ? slot.report.focusSequence : 0
    candidates.push({ pane, focused: slot.report.focused === true, focusSequence })
  }
  if (candidates.length === 0) return { ok: false, reason: 'This window has no active terminal pane.' }
  const focused = candidates.filter((candidate) => candidate.focused)
  const ranked = focused.length > 0 ? focused : candidates.filter((candidate) => candidate.focusSequence > 0)
  if (ranked.length === 0) {
    const panes = [...new Set(candidates.map((candidate) => candidate.pane))]
    return panes.length === 1 ? panes[0]! : { ok: false, reason: 'This window reports ambiguous terminal focus; no pane action was performed.' }
  }
  const latestSequence = Math.max(...ranked.map((candidate) => candidate.focusSequence))
  const panes = [...new Set(ranked.filter((candidate) => candidate.focusSequence === latestSequence).map((candidate) => candidate.pane))]
  return panes.length === 1 ? panes[0]! : { ok: false, reason: 'This window reports ambiguous terminal focus; no pane action was performed.' }
}

async function getState(context: UiPluginContext, pane: string): Promise<DockState | CommandResult> {
  try {
    const state = readDockState(await context.call(`${PLUGIN_METHOD}get`, { pane }), pane)
    return state ?? { ok: false, reason: `The terminal dock has no current state for pane ${pane}.` }
  } catch (error) {
    return { ok: false, reason: errorText(error) }
  }
}

function isFailure(value: DockState | CommandResult): value is CommandResult {
  return 'ok' in value && value.ok === false
}

function fail(reason: string): CommandResult {
  return { ok: false, reason }
}

function stringArray(value: unknown): string[][] | undefined {
  if (!Array.isArray(value) || !value.every((group) => Array.isArray(group) && group.every((answer) => typeof answer === 'string'))) return undefined
  return value as string[][]
}

/** Register every window-targeted dock command. All state changes route through the daemon API. */
export function registerDockCommands(context: UiPluginContext, handles: HandleMap): void {
  const resolve = async (raw: unknown): Promise<{ pane: string; args: Args } | CommandResult> => {
    const args = raw === undefined ? {} : record(raw) ? raw : null
    if (args === null) return fail('Command arguments must be an object.')
    const pane = await paneFrom(context, args)
    return typeof pane === 'string' ? { pane, args } : pane
  }

  context.provide(`command:${PLUGIN_METHOD}settings`, () => context.openView(SETTINGS_VIEW))
  context.provide(`command:${PLUGIN_METHOD}set`, (raw?: unknown) => {
    if (!record(raw)) return fail('Command arguments must be an object.')
    return context.call(`${PLUGIN_METHOD}set`, raw)
  })
  context.provide(`command:${PLUGIN_METHOD}focus`, async (raw?: unknown) => {
    const target = await resolve(raw)
    if ('ok' in target) return target
    const handle = handles.get(target.pane)
    if (!handle) return fail(`The composer is not mounted for pane ${target.pane}.`)
    handle.focus()
    return { ok: true }
  })
  context.provide(`command:${PLUGIN_METHOD}toggle`, async (raw?: unknown) => {
    const target = await resolve(raw)
    if ('ok' in target) return target
    const current = await getState(context, target.pane)
    if (isFailure(current)) return current
    try {
      return await context.call(`${PLUGIN_METHOD}set`, { pane: target.pane, docked: !current.docked })
    } catch (error) {
      return fail(errorText(error))
    }
  })
  context.provide(`command:${PLUGIN_METHOD}passthrough`, async (raw?: unknown) => {
    const target = await resolve(raw)
    if ('ok' in target) return target
    const current = await getState(context, target.pane)
    if (isFailure(current)) return current
    if (!current.mounted) return fail('Passthrough is available only while this composer is mounted.')
    try {
      return await context.call(`${PLUGIN_METHOD}set`, { pane: target.pane, passthrough: !current.passthrough })
    } catch (error) {
      return fail(errorText(error))
    }
  })
  context.provide(`command:${PLUGIN_METHOD}resize`, async (raw?: unknown) => {
    const target = await resolve(raw)
    if ('ok' in target) return target
    const rows = target.args.gutterRows
    if (typeof rows !== 'number' || !Number.isFinite(rows)) return fail('gutterRows must be a finite number.')
    try {
      return await context.call(`${PLUGIN_METHOD}set`, { pane: target.pane, gutterRows: Math.max(3, Math.min(15, Math.round(rows))) })
    } catch (error) {
      return fail(errorText(error))
    }
  })
  context.provide(`command:${PLUGIN_METHOD}draft`, async (raw?: unknown) => {
    const target = await resolve(raw)
    if ('ok' in target) return target
    if (typeof target.args.text !== 'string') return fail('text must be a string.')
    if (target.args.revision !== undefined && (typeof target.args.revision !== 'number' || !Number.isSafeInteger(target.args.revision) || target.args.revision < 0)) return fail('revision must be a non-negative integer.')
    const handle = handles.get(target.pane)
    if (handle && !(await handle.flush())) return fail('The current composer draft is not synchronized; the replacement was refused.')
    const current = await getState(context, target.pane)
    if (isFailure(current)) return current
    const revision = typeof target.args.revision === 'number' ? target.args.revision : current.revision
    try {
      return await context.call(`${PLUGIN_METHOD}set`, { pane: target.pane, revision, draft: target.args.text })
    } catch (error) {
      return fail(errorText(error))
    }
  })
  context.provide(`command:${PLUGIN_METHOD}send`, async (raw?: unknown) => {
    const target = await resolve(raw)
    if ('ok' in target) return target
    if ('id' in target.args && (typeof target.args.id !== 'string' || target.args.id === '')) return fail('id must be a non-empty string.')
    if ('revision' in target.args && (typeof target.args.revision !== 'number' || !Number.isSafeInteger(target.args.revision) || target.args.revision < 0)) return fail('revision must be a non-negative integer.')
    if ('text' in target.args && typeof target.args.text !== 'string') return fail('text must be a string.')
    const handle = handles.get(target.pane)
    if (handle && !(await handle.flush())) return fail('The current composer draft is not synchronized; nothing was sent.')
    const current = await getState(context, target.pane)
    if (isFailure(current)) return current
    const payload: Record<string, unknown> = {
      pane: target.pane,
      id: typeof target.args.id === 'string' ? target.args.id : crypto.randomUUID(),
      ...(typeof target.args.revision === 'number' ? { revision: target.args.revision } : target.args.text === undefined ? { revision: current.revision } : {}),
      ...(typeof target.args.text === 'string' ? { text: target.args.text } : {})
    }
    try {
      return await context.call(`${PLUGIN_METHOD}send`, payload)
    } catch (error) {
      return fail(errorText(error))
    }
  })
  context.provide(`command:${PLUGIN_METHOD}cancel`, async (raw?: unknown) => {
    const target = await resolve(raw)
    if ('ok' in target) return target
    if ('send' in target.args && (typeof target.args.send !== 'string' || target.args.send === '')) return fail('send must be a non-empty identifier.')
    if ('interrupt' in target.args && typeof target.args.interrupt !== 'boolean') return fail('interrupt must be a boolean.')
    try {
      return await context.call(`${PLUGIN_METHOD}cancel`, {
        pane: target.pane,
        ...(typeof target.args.send === 'string' ? { send: target.args.send } : {}),
        ...(typeof target.args.interrupt === 'boolean' ? { interrupt: target.args.interrupt } : {})
      })
    } catch (error) {
      return fail(errorText(error))
    }
  })
  context.provide(`command:${PLUGIN_METHOD}history`, async (raw?: unknown) => {
    const target = await resolve(raw)
    if ('ok' in target) return target
    const direction = target.args.direction
    if (direction !== undefined && direction !== 'previous' && direction !== 'next') return fail('direction must be previous or next.')
    const handle = handles.get(target.pane)
    if (direction !== undefined && handle && !(await handle.flush())) return fail('The current composer draft is not synchronized; history was not changed.')
    try {
      return await context.call(`${PLUGIN_METHOD}history`, { pane: target.pane, ...(direction === undefined ? {} : { direction }) })
    } catch (error) {
      return fail(errorText(error))
    }
  })
  context.provide(`command:${PLUGIN_METHOD}interaction`, async (raw?: unknown) => {
    const target = await resolve(raw)
    if ('ok' in target) return target
    const action = target.args.action
    if (typeof target.args.request !== 'string' || target.args.request === '' ||
      action !== 'answer' && action !== 'collapse' && action !== 'expand' && action !== 'dismiss') return fail('A valid request and interaction action are required.')
    const answers = target.args.answers === undefined ? undefined : stringArray(target.args.answers)
    if (target.args.answers !== undefined && answers === undefined) return fail('answers must be an array of answer groups.')
    try {
      return await context.call(`${PLUGIN_METHOD}interaction`, {
        pane: target.pane,
        request: target.args.request,
        action,
        ...(answers === undefined ? {} : { answers })
      })
    } catch (error) {
      return fail(errorText(error))
    }
  })
  context.provide(`command:${PLUGIN_METHOD}options`, async (raw?: unknown) => {
    const target = await resolve(raw)
    if ('ok' in target) return target
    const kind = target.args.kind
    if (kind !== undefined && kind !== 'model' && kind !== 'effort' && kind !== 'permission') return fail('kind must be model, effort, or permission.')
    if (target.args.value !== undefined && typeof target.args.value !== 'string') return fail('value must be a string.')
    try {
      return await context.call(`${PLUGIN_METHOD}options`, {
        pane: target.pane,
        ...(kind === undefined ? {} : { kind }),
        ...(typeof target.args.value === 'string' ? { value: target.args.value } : {})
      })
    } catch (error) {
      return fail(errorText(error))
    }
  })
}
