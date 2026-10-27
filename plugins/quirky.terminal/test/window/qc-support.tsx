import { act, type ReactElement } from 'react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { RpcError, RpcErrorCode, type QuirkyEvent } from '@quirky/protocol'
import type { QuickCommand } from '../../src/layout/types'
import { normalizeQuickCommands, validateQuickCommand, visibleQuickCommands } from '../../src/quick-commands/normalize'
import { fakeContext, settle, type FakeContext } from '../ui-fake'

type Modules = {
  panel: typeof import('../../src/window/quick-commands/QuickCommandsPanel')
  dialog: typeof import('../../src/window/quick-commands/QuickCommandDialog')
  strip: typeof import('../../src/window/quick-commands/QuickCommandsStripButton')
  items: typeof import('../../src/window/quick-commands/pane-items')
}

let modules: Modules
let createRoot: typeof import('react-dom/client').createRoot

/** Registers happy-dom, then loads the quick-command components, which read `document` when used. */
export async function loadQuickCommands(): Promise<void> {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // react-dom decides which input events exist when it loads, so it must load after the DOM does
  ;({ createRoot } = await import('react-dom/client'))
  modules = {
    panel: await import('../../src/window/quick-commands/QuickCommandsPanel'),
    dialog: await import('../../src/window/quick-commands/QuickCommandDialog'),
    strip: await import('../../src/window/quick-commands/QuickCommandsStripButton'),
    items: await import('../../src/window/quick-commands/pane-items')
  }
}

export async function unloadQuickCommands(): Promise<void> {
  await GlobalRegistrator.unregister()
}

export const qc = (): Modules => modules

export function command(over: Partial<QuickCommand> & { id: string }): QuickCommand {
  return { label: over.id, kind: 'terminal', agent: null, command: `echo ${over.id}`, appendEnter: true, scope: 'global', repo: null, ...over }
}

export type AgentRow = { id: string; label: string; installed: boolean; enabled: boolean; promptMode: string }

export function agent(id: string, over: Partial<AgentRow> = {}): AgentRow {
  return { id, label: id.toUpperCase(), installed: true, enabled: true, promptMode: 'argv', ...over }
}

export type World = {
  commands: QuickCommand[]
  agents: AgentRow[]
  repos: { id: string; name: string }[]
  /** Worktree ID to the repo it belongs to. */
  worktrees: Record<string, string>
  /** The next add or update fails with this message. */
  failNext: string | null
}

/**
 * A fake window context whose daemon keeps quick commands in `world` and applies the real
 * normalization and validation, so a saved command reads back as the daemon would return it.
 */
export function qcFake(init: Partial<World> = {}): { fake: FakeContext; world: World } {
  const world: World = { commands: [], agents: [agent('claude'), agent('codex')], repos: [{ id: 'api', name: 'api' }], worktrees: { wt_main: 'api' }, failNext: null, ...init }
  const reject = (message: string) => new RpcError(RpcErrorCode.InvalidParams, message)
  const fake = fakeContext({
    'quirky.terminal/quickCommands': (params) => {
      if (params.all === true) return { commands: world.commands }
      return { commands: visibleQuickCommands(world.commands, world.worktrees[params.workspace] ?? null) }
    },
    'quirky.terminal/addQuickCommand': (params) => {
      if (world.failNext) throw reject(world.failNext)
      const problems = validateQuickCommand(params)
      if (problems.length > 0) throw reject(problems.map((problem) => problem.message).join('; '))
      world.commands = normalizeQuickCommands([...world.commands, params])
      return { commands: world.commands }
    },
    'quirky.terminal/updateQuickCommand': (params) => {
      if (world.failNext) throw reject(world.failNext)
      const found = world.commands.find((entry) => entry.id === params.id)
      if (!found) throw new RpcError(RpcErrorCode.NotFound, `no quick command ${params.id}`)
      world.commands = normalizeQuickCommands(world.commands.map((entry) => (entry === found ? { ...found, ...params } : entry)))
      return { commands: world.commands }
    },
    'quirky.terminal/removeQuickCommand': (params) => {
      if (params.yes !== true) throw new RpcError(RpcErrorCode.ConfirmationRequired, 'confirmation required')
      if (!world.commands.some((entry) => entry.id === params.id)) throw new RpcError(RpcErrorCode.NotFound, `no quick command ${params.id}`)
      world.commands = world.commands.filter((entry) => entry.id !== params.id)
      return { commands: world.commands }
    },
    'quirky.terminal/runQuickCommand': () => ({ ok: true }),
    'quirky.agents/list': () => ({ agents: world.agents }),
    'quirky.repo/list': () => world.repos,
    'quirky.worktree/resolve': (params) => {
      const id = String(params.selector).replace(/^id:/, '')
      const repoId = world.worktrees[id]
      if (!repoId) throw new RpcError(RpcErrorCode.NotFound, `no worktree ${id}`)
      return { id, repoId, name: id }
    }
  })
  return { fake, world }
}

export const quickCommandsChanged = { type: 'quirky.terminal/quickCommands' } as unknown as QuirkyEvent

export type Rendered = Awaited<ReturnType<typeof render>>

const roots: { unmount(): void }[] = []

export async function render(ui: ReactElement) {
  const element = document.createElement('div')
  document.body.appendChild(element)
  const root = createRoot(element)
  roots.push(root)
  await act(async () => root.render(ui))
  await settle()
  return {
    element,
    rerender: async (next: ReactElement) => {
      await act(async () => root.render(next))
      await settle()
    },
    unmount: () => act(async () => root.unmount())
  }
}

export const $ = <T extends Element = HTMLElement>(selector: string, root: ParentNode = document.body): T | null => root.querySelector<T>(selector)
export const $$ = <T extends Element = HTMLElement>(selector: string, root: ParentNode = document.body): T[] => [...root.querySelectorAll<T>(selector)]

/** The button whose accessible name (aria-label, else text) is exactly `name`. */
export function button(name: string, root: ParentNode = document.body): HTMLButtonElement {
  const found = $$<HTMLButtonElement>('button', root).find((candidate) => (candidate.getAttribute('aria-label') ?? candidate.textContent ?? '').trim() === name)
  if (!found) throw new Error(`no button named ${name}; buttons: ${$$('button', root).map((entry) => entry.getAttribute('aria-label') ?? entry.textContent).join(' | ')}`)
  return found
}

export async function click(target: Element): Promise<void> {
  await act(async () => void (target as HTMLElement).click())
  await settle()
}

/** Sets an input's or textarea's value the way typing does, so React's onChange runs. */
export async function fill(target: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  const proto = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const set = Object.getOwnPropertyDescriptor(proto, 'value')!.set!
  await act(async () => {
    set.call(target, value)
    target.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

export async function pick(target: HTMLSelectElement, value: string): Promise<void> {
  const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
  await act(async () => {
    set.call(target, value)
    target.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

export async function key(target: Element, name: string, init: KeyboardEventInit = {}): Promise<void> {
  await act(async () => void target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init })))
  await settle()
}

/**
 * Unmounts what a test rendered and empties the body. Escape goes first so a dialog opened
 * through `openQuickCommandDialog` closes and drops its window listener; a stale listener would
 * otherwise act on a node that is already gone.
 */
export async function cleanup(): Promise<void> {
  await act(async () => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  await settle()
  await act(async () => void roots.splice(0).forEach((root) => root.unmount()))
  document.body.innerHTML = ''
}

export { fakeContext, settle, type FakeContext }
