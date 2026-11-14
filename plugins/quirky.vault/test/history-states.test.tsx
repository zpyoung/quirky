import { afterAll, afterEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { UiPluginContext } from '@quirky/protocol'

const actGlobal = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = actGlobal.IS_REACT_ACT_ENVIRONMENT
GlobalRegistrator.register()
actGlobal.IS_REACT_ACT_ENVIRONMENT = true

// React reads DOM and act support during module initialization, so these imports follow registration.
const { act } = await import('react')
const { activate } = await import('../src/ui')
const { mountHistoryPanel } = await import('../src/window/HistoryPanel')

type CallRecord = { method: string; params: Record<string, unknown> }
type CommandRecord = { id: string; args: unknown }
type Handler = (args?: unknown) => unknown

type SessionFixture = {
  id: string
  sourceId: string
  hostId: string
  agent: string
  sessionId: string
  title: string
  cwd: string | null
  branch: string | null
  model: string | null
  createdAt: number
  updatedAt: number
  modifiedAt: number
  messageCount: number
  totalTokens: number | null
  previewMessages: []
  queuedMessageCount: number
  subagentTranscriptCount: number
  presence: 'present'
  source: { presence: 'present'; filePath: string }
}

const rows: SessionFixture[] = [
  {
    id: 'A', sourceId: 'source-A', hostId: 'local', agent: 'claude', sessionId: 'session-A', title: 'Session A',
    cwd: null, branch: null, model: null, createdAt: 1, updatedAt: 1, modifiedAt: 1, messageCount: 2, totalTokens: null,
    previewMessages: [], queuedMessageCount: 0, subagentTranscriptCount: 0, presence: 'present',
    source: { presence: 'present', filePath: '/tmp/session-A.jsonl' }
  },
  {
    id: 'B', sourceId: 'source-B', hostId: 'local', agent: 'claude', sessionId: 'session-B', title: 'Session B',
    cwd: null, branch: null, model: null, createdAt: 2, updatedAt: 2, modifiedAt: 2, messageCount: 2, totalTokens: null,
    previewMessages: [], queuedMessageCount: 0, subagentTranscriptCount: 0, presence: 'present',
    source: { presence: 'present', filePath: '/tmp/session-B.jsonl' }
  }
]

const initialView = {
  disabledAgents: [], browseSort: 'updated', searchSort: 'relevance', group: 'project', hideEmptySessions: false,
  sessionLimit: 250, host: 'local', scope: 'all', query: '', selectedId: 'A', expandedIds: [], focusedSearch: false
}
const cleanups: Array<() => void | Promise<void>> = []
const clipboardWrites: string[] = []
const previousClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
Object.defineProperty(navigator, 'clipboard', {
  configurable: true,
  value: { writeText: async (text: string) => { clipboardWrites.push(text) } }
})

function makeContext(options: { rows?: SessionFixture[]; firstPrompts?: Record<string, string | null> } = {}) {
  const view = { ...initialView, disabledAgents: [...initialView.disabledAgents], expandedIds: [...initialView.expandedIds] }
  const sessions = options.rows ?? rows
  const calls: CallRecord[] = []
  const commands: CommandRecord[] = []
  const toasts: Array<{ title: string; message: string }> = []
  const handlers = new Map<string, Handler>()
  const host = {
    call: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params })
      if (method === 'quirky.vault/getView') return { ...view, disabledAgents: [...view.disabledAgents], expandedIds: [...view.expandedIds] }
      if (method === 'quirky.vault/setView') {
        Object.assign(view, params)
        return { ...view, disabledAgents: [...view.disabledAgents], expandedIds: [...view.expandedIds] }
      }
      if (method === 'quirky.vault/list') return {
        sessions,
        hosts: [],
        issues: [],
        scannedFiles: sessions.length,
        scannedAt: Date.now(),
        hasMore: false,
        total: sessions.length
      }
      if (method === 'quirky.vault/searchStatus') return { status: { enabled: false, phase: 'idle' }, hosts: [] }
      if (method === 'quirky.vault/getSearchTip') return { id: 'agent-session-search', seen: true }
      if (method === 'quirky.repo/list') return []
      if (method === 'quirky.vault/get') return null
      if (method === 'quirky.vault/firstPrompt') {
        const id = String(params.id)
        if (options.firstPrompts && Object.hasOwn(options.firstPrompts, id)) return { prompt: options.firstPrompts[id] }
        return { prompt: 'First prompt for session A' }
      }
      if (method === 'quirky.vault/subagents') return []
      if (method === 'quirky.worktree/remoteHostList') throw new Error('No remote owner is registered.')
      if (method === 'quirky.worktree/remoteList') return { workspaces: [] }
      if (method === 'quirky.vault/cancelList') return undefined
      throw new Error(`Unexpected UI call ${method}`)
    },
    provide: (id: string, implementation: unknown) => {
      if (typeof implementation === 'function') handlers.set(id, implementation as Handler)
    },
    executeCommand: async (id: string, args?: unknown) => {
      commands.push({ id, args })
      const handler = handlers.get(id)
      if (!handler) throw new Error(`Unknown command ${id}`)
      return await handler(args)
    },
    subscribe: () => () => {},
    onLayout: () => () => {},
    getLayout: () => ({}),
    setPanelBadge: () => {},
    toast: (title: string, message: string) => { toasts.push({ title, message }) },
    openView: () => {},
    confirm: async () => false,
    createCommandDrag: () => 'drag-token',
    cancelCommandDrag: () => {}
  }
  const context = host as unknown as UiPluginContext
  activate(context)
  return { context, host, calls, commands, toasts }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await act(async () => { await Promise.resolve() })
}

async function mountPanel(context: UiPluginContext) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  let unmount: () => void = () => {}
  let mounted = true
  const cleanup = async () => {
    if (!mounted) return
    mounted = false
    await act(async () => unmount())
    container.remove()
  }
  await act(async () => { unmount = mountHistoryPanel(context, container, {}) })
  cleanups.push(cleanup)
  await settle()
  return { container, unmount: cleanup }
}

async function runCommand(context: { executeCommand(id: string, args?: unknown): Promise<unknown> }, args: unknown): Promise<unknown> {
  let result: unknown
  await act(async () => { result = await context.executeCommand('command:quirky.vault/history-control', args) })
  await settle()
  return result
}

function optionsState(container: ParentNode) {
  const button = container.querySelector<HTMLButtonElement>('[aria-label="View options"]')
  const options = container.querySelector<HTMLElement>('[data-vault-view-options]')
  return { expanded: button?.getAttribute('aria-expanded') ?? null, visible: options !== null, text: options?.textContent?.trim() ?? null }
}

function panelInstance(container: ParentNode): string | null {
  return container.querySelector<HTMLElement>('[data-vault-history]')?.getAttribute('data-vault-history-instance') ?? null
}

afterEach(async () => {
  clipboardWrites.length = 0
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

afterAll(async () => {
  if (previousClipboard) Object.defineProperty(navigator, 'clipboard', previousClipboard)
  else Reflect.deleteProperty(navigator, 'clipboard')
  await GlobalRegistrator.unregister()
  if (previousActEnvironment === undefined) delete actGlobal.IS_REACT_ACT_ENVIRONMENT
  else actGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

test('the manifest declares the non-palette history control command', () => {
  const manifest = JSON.parse(readFileSync(new URL('../quirky-plugin.json', import.meta.url), 'utf8')) as {
    contributes: { command: Array<Record<string, unknown>> }
  }
  const command = manifest.contributes.command.find((entry) => entry.id === 'history-control')

  expect(command).toMatchObject({
    id: 'history-control',
    title: 'History Panel Control',
    palette: false,
    description: 'Route Session History panel options, groups, menus, selection, details, retries and copies to a mounted History panel.',
    args: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['set-options', 'toggle-group', 'menu', 'select', 'toggle-details', 'retry-details', 'cancel-remote-resume', 'copy'] },
        instance: { type: 'string' },
        id: { type: 'string' },
        open: { type: 'boolean' },
        field: { type: 'string', enum: ['session-id', 'log-path', 'first-prompt'] }
      },
      required: ['action']
    }
  })
})

test('the command is registered and reports when no History panel is mounted', async () => {
  const { host, commands } = makeContext()

  expect(await runCommand(host, { action: 'set-options' })).toEqual({ ok: false, reason: 'no-panel' })
  expect(commands).toEqual([{ id: 'command:quirky.vault/history-control', args: { action: 'set-options' } }])
})

test('unknown actions throw with the JSON value in the message', async () => {
  const { host } = makeContext()

  await expect(runCommand(host, { action: 'explode' })).rejects.toThrow('Unknown history-control action: "explode"')
  await expect(runCommand(host, {})).rejects.toThrow('Unknown history-control action: undefined')
})

test('row actions reject missing, empty, and null session ids', async () => {
  const { host } = makeContext()

  for (const action of ['select', 'toggle-details', 'retry-details', 'menu', 'copy']) {
    await expect(runCommand(host, { action })).rejects.toThrow(`history-control ${action} requires a session id.`)
    await expect(runCommand(host, { action, id: '' })).rejects.toThrow(`history-control ${action} requires a session id.`)
    await expect(runCommand(host, { action, id: null })).rejects.toThrow(`history-control ${action} requires a session id.`)
  }
})

test('group, open, and copy field arguments are validated', async () => {
  const { host } = makeContext()

  for (const id of [undefined, '', null]) {
    await expect(runCommand(host, { action: 'toggle-group', ...(id === undefined ? {} : { id }) })).rejects.toThrow('history-control toggle-group requires a group id.')
  }
  await expect(runCommand(host, { action: 'set-options', open: 'false' })).rejects.toThrow('history-control set-options open must be true or false.')
  await expect(runCommand(host, { action: 'set-options', open: undefined })).rejects.toThrow('history-control set-options open must be true or false.')
  await expect(runCommand(host, { action: 'menu', id: 'A', open: undefined })).rejects.toThrow('history-control menu open must be true or false.')
  await expect(runCommand(host, { action: 'menu', id: 'A', open: null })).rejects.toThrow('history-control menu open must be true or false.')
  await expect(runCommand(host, { action: 'copy', id: 'A', field: 'title' })).rejects.toThrow('history-control copy field must be session-id, log-path, or first-prompt.')
})

test('an explicit missing instance is reported without changing a mounted panel', async () => {
  const { context, host } = makeContext()
  const panel = await mountPanel(context)
  const before = optionsState(panel.container)

  expect(await runCommand(host, { instance: 'history-404', action: 'set-options', open: true })).toEqual({
    ok: false,
    reason: 'unknown-instance',
    instance: 'history-404'
  })
  expect(optionsState(panel.container)).toEqual(before)
})

test('unknown rows and groups are reported without changing the panel', async () => {
  const { context, host } = makeContext()
  const panel = await mountPanel(context)
  const before = optionsState(panel.container)

  expect(await runCommand(host, { action: 'select', id: 'missing' })).toEqual({ ok: false, reason: 'unknown-row', id: 'missing' })
  expect(await runCommand(host, { action: 'toggle-group', id: 'project:missing' })).toEqual({ ok: false, reason: 'unknown-group', id: 'project:missing' })
  expect(optionsState(panel.container)).toEqual(before)
})

test('set-options command toggles like the local View options click and honors explicit close', async () => {
  const { context, host, commands } = makeContext()
  const panel = await mountPanel(context)
  const button = panel.container.querySelector<HTMLButtonElement>('[aria-label="View options"]')!

  await act(async () => button.click())
  const clickResult = optionsState(panel.container)
  expect(clickResult.expanded).toBe('true')
  expect(clickResult.visible).toBe(true)
  expect(commands).toHaveLength(0)

  await act(async () => button.click())
  expect(optionsState(panel.container).visible).toBe(false)
  expect(await runCommand(host, { action: 'set-options' })).toEqual({ ok: true })
  expect(optionsState(panel.container)).toEqual(clickResult)
  expect(await runCommand(host, { action: 'set-options', open: false })).toEqual({ ok: true })
  expect(optionsState(panel.container).expanded).toBe('false')
  expect(optionsState(panel.container).visible).toBe(false)
})

test('group, menu, selection, and detail commands update their mounted panel', async () => {
  const { context, host } = makeContext()
  const panel = await mountPanel(context)
  const groupButton = () => panel.container.querySelector<HTMLButtonElement>('.qvh-group-heading button[aria-expanded]')!

  expect(groupButton().getAttribute('aria-expanded')).toBe('true')
  expect(await runCommand(host, { action: 'toggle-group', id: 'project:No project' })).toEqual({ ok: true })
  expect(groupButton().getAttribute('aria-expanded')).toBe('false')
  expect(await runCommand(host, { action: 'toggle-group', id: 'project:No project' })).toEqual({ ok: true })
  expect(groupButton().getAttribute('aria-expanded')).toBe('true')

  expect(await runCommand(host, { action: 'menu', id: 'A', open: true })).toEqual({ ok: true })
  expect(document.querySelector('[data-vault-actions="A"]')).not.toBeNull()
  expect(await runCommand(host, { action: 'menu', id: 'A', open: false })).toEqual({ ok: true })
  expect(document.querySelector('[data-vault-actions="A"]')).toBeNull()
  await runCommand(host, { action: 'menu', id: 'A', open: true })
  expect(await runCommand(host, { action: 'menu', id: 'B', open: true })).toEqual({ ok: true })
  expect(document.querySelector('[data-vault-actions="A"]')).toBeNull()
  expect(document.querySelector('[data-vault-actions="B"]')).not.toBeNull()
  expect(await runCommand(host, { action: 'menu', id: 'B' })).toEqual({ ok: true })
  expect(document.querySelector('[data-vault-actions="B"]')).toBeNull()

  expect(await runCommand(host, { action: 'select', id: 'B' })).toEqual({ ok: true })
  expect(panel.container.querySelector('[data-vault-session-row="B"]')?.getAttribute('aria-selected')).toBe('true')
  expect(await runCommand(host, { action: 'toggle-details', id: 'B' })).toEqual({ ok: true })
  expect(panel.container.querySelector('[data-vault-session-details="B"]')).not.toBeNull()
})

test('retry-details re-runs a row detail load through its lifted retry count', async () => {
  const { context, host, calls } = makeContext()
  const panel = await mountPanel(context)

  expect(await runCommand(host, { action: 'toggle-details', id: 'A' })).toEqual({ ok: true })
  expect(panel.container.querySelector('[data-vault-session-details="A"]')).not.toBeNull()
  const getCount = () => calls.filter((call) => call.method === 'quirky.vault/get' && call.params.id === 'A').length
  const loadedCount = getCount()
  expect(loadedCount).toBeGreaterThan(0)

  expect(await runCommand(host, { action: 'retry-details', id: 'A' })).toEqual({ ok: true })
  expect(getCount()).toBe(loadedCount + 1)
})

test('copy actions preserve clipboard text and toast titles', async () => {
  const { context, host, toasts } = makeContext()
  await mountPanel(context)

  expect(await runCommand(host, { action: 'copy', id: 'A', field: 'session-id' })).toEqual({ ok: true })
  expect(clipboardWrites).toEqual(['session-A'])
  expect(toasts.at(-1)?.title).toBe('Session ID copied')

  expect(await runCommand(host, { action: 'copy', id: 'A', field: 'log-path' })).toEqual({ ok: true })
  expect(clipboardWrites).toEqual(['session-A', '/tmp/session-A.jsonl'])
  expect(toasts.at(-1)?.title).toBe('Log path copied')

  expect(await runCommand(host, { action: 'copy', id: 'A', field: 'first-prompt' })).toEqual({ ok: true })
  expect(clipboardWrites).toEqual(['session-A', '/tmp/session-A.jsonl', 'First prompt for session A'])
  expect(toasts.at(-1)?.title).toBe('First prompt copied')
})

test('copying an unavailable first prompt reports the existing error toast', async () => {
  const { context, host, toasts } = makeContext({ firstPrompts: { A: null } })
  await mountPanel(context)

  expect(await runCommand(host, { action: 'copy', id: 'A', field: 'first-prompt' })).toEqual({
    ok: false,
    reason: 'field-unavailable',
    field: 'first-prompt'
  })
  expect(clipboardWrites).toEqual([])
  expect(toasts.at(-1)).toEqual({ title: 'Vault action failed', message: 'This source does not contain a first prompt.' })
})

test('cancel-remote-resume closes the active owner confirmation', async () => {
  const remoteRow = { ...rows[0]!, id: 'remote-A', sourceId: 'source-remote-A', hostId: 'owner-A', sessionId: 'remote-session-A', title: 'Remote session A' }
  const { context, host } = makeContext({ rows: [remoteRow] })
  const panel = await mountPanel(context)

  await act(async () => panel.container.querySelector<HTMLButtonElement>('[aria-label="Resume session"]')!.click())
  await settle()
  expect(panel.container.querySelector('[data-vault-remote-resume]')).not.toBeNull()
  expect(await runCommand(host, { action: 'cancel-remote-resume' })).toEqual({ ok: true })
  expect(panel.container.querySelector('[data-vault-remote-resume]')).toBeNull()
})

test('two mounts use newest-live defaults while clicks remain local to their own mount', async () => {
  const { context, host } = makeContext()
  const first = await mountPanel(context)
  const second = await mountPanel(context)
  expect(panelInstance(first.container)).toBe('history-1')
  expect(panelInstance(second.container)).toBe('history-2')

  expect(await runCommand(host, { action: 'set-options', open: true })).toEqual({ ok: true })
  expect(optionsState(first.container).visible).toBe(false)
  expect(optionsState(second.container).visible).toBe(true)

  await act(async () => first.container.querySelector<HTMLButtonElement>('[aria-label="View options"]')!.click())
  expect(optionsState(first.container).visible).toBe(true)
  expect(optionsState(second.container).visible).toBe(true)

  await second.unmount()
  expect(await runCommand(host, { action: 'set-options', open: true })).toEqual({ ok: true })
  expect(optionsState(first.container).visible).toBe(true)
  expect(await runCommand(host, { instance: 'history-2', action: 'set-options' })).toEqual({
    ok: false,
    reason: 'unknown-instance',
    instance: 'history-2'
  })
  await first.unmount()
  expect(await runCommand(host, { action: 'set-options' })).toEqual({ ok: false, reason: 'no-panel' })
})

test('unmounting the older panel leaves the newer default and its click handler live', async () => {
  const { context, host } = makeContext()
  const first = await mountPanel(context)
  const second = await mountPanel(context)
  await first.unmount()

  expect(await runCommand(host, { action: 'set-options', open: true })).toEqual({ ok: true })
  expect(optionsState(second.container).visible).toBe(true)
  await act(async () => second.container.querySelector<HTMLButtonElement>('[aria-label="View options"]')!.click())
  expect(optionsState(second.container).visible).toBe(false)
  expect(optionsState(second.container).expanded).toBe('false')

  await second.unmount()
  expect(await runCommand(host, { action: 'set-options' })).toEqual({ ok: false, reason: 'no-panel' })
})
