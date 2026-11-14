import { afterAll, afterEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { UiPluginContext } from '@quirky/protocol'
import type { HostOutcome, SearchStatus } from '../src/types'

const actGlobal = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = actGlobal.IS_REACT_ACT_ENVIRONMENT
GlobalRegistrator.register()
actGlobal.IS_REACT_ACT_ENVIRONMENT = true

// React reads DOM and act support during module initialization, so these imports follow registration.
const { act } = await import('react')
const { mountSearchSettings, mountSearchSettingsView } = await import('../src/window/SearchSettings')

type SearchStatusReply = { status: SearchStatus; hosts: HostOutcome[] }
type SearchStatusHandler = () => unknown
type SearchResponder = (method: string, params: Record<string, unknown>) => unknown

type SearchHandlers = {
  local?: SearchStatusHandler
  all?: SearchStatusHandler
  remotes?: Record<string, SearchStatusHandler>
  enable?: SearchStatusHandler
}

type MountSearchSettings = (
  context: UiPluginContext,
  element: HTMLElement,
  props: { report?(state: unknown): void }
) => () => void

const cleanups: Array<() => void | Promise<void>> = []

function status(overrides: Partial<SearchStatus> = {}): SearchStatus {
  return {
    enabled: false,
    phase: 'idle',
    filesIndexed: 0,
    filesDue: 0,
    filesFailed: 0,
    messagesIndexed: 0,
    degradedRoots: [],
    lastReconcileAt: null,
    lastSweepCompletedAt: null,
    generation: 1,
    supportedAgents: [],
    sessionsByAgent: {},
    ...overrides
  }
}

function host(id: string, overrides: Partial<HostOutcome> = {}): HostOutcome {
  return {
    hostId: id,
    label: `Remote ${id}`,
    kind: 'ok',
    scannedFiles: 0,
    scannedAt: null,
    ...overrides
  }
}

function reply(hosts: HostOutcome[], currentStatus: SearchStatus = status()): SearchStatusReply {
  return { status: currentStatus, hosts }
}

function localReply(): SearchStatusReply {
  return reply([host('local')])
}

function makeResponder(handlers: SearchHandlers = {}): SearchResponder {
  return (method, params) => {
    if (method === 'quirky.vault/searchStatus') {
      const hostId = params.host
      if (hostId === 'local') return handlers.local ? handlers.local() : localReply()
      if (hostId === 'all') return handlers.all ? handlers.all() : localReply()
      if (typeof hostId === 'string') {
        const read = handlers.remotes?.[hostId]
        if (read) return read()
        throw new Error(`Unexpected remote search status read for ${hostId}`)
      }
    }
    if (method === 'quirky.vault/setSearchEnabled' && handlers.enable) return handlers.enable()
    throw new Error(`Unexpected UI call ${method}`)
  }
}

function makeContext(responder: SearchResponder) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const context = {
    call: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params })
      return await responder(method, params)
    },
    subscribe: () => () => {},
    toast: () => {},
    confirm: async () => false,
    togglePanel: () => {}
  } as unknown as UiPluginContext
  return { context, calls }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await act(async () => { await Promise.resolve() })
  }
}

async function mountSettings(
  context: UiPluginContext,
  mount: MountSearchSettings = mountSearchSettingsView
): Promise<HTMLElement> {
  const element = document.createElement('div')
  document.body.appendChild(element)
  let unmount: () => void = () => {}
  await act(async () => { unmount = mount(context, element, {}) })
  cleanups.push(async () => {
    await act(async () => unmount())
    element.remove()
  })
  await settle()
  return element
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
  if (previousActEnvironment === undefined) delete actGlobal.IS_REACT_ACT_ENVIRONMENT
  else actGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

function textLeaves(root: ParentNode, text: string): Element[] {
  return [...root.querySelectorAll('*')].filter((element) => element.children.length === 0 && element.textContent?.trim() === text)
}

test('the settings view shows one shared local loading notice and checking badges', async () => {
  const pending = Promise.withResolvers<unknown>()
  const { context } = makeContext(makeResponder({ local: () => pending.promise, all: () => pending.promise }))
  const root = await mountSettings(context)

  expect(root.querySelector('[data-vault-settings] div[role="status"][data-vault-search-loading] p.ui-notice-line')?.textContent).toBe('Checking search status…')
  const localRow = root.querySelector<HTMLElement>('[data-vault-host-id="local"]')!
  expect(localRow.querySelector('[data-vault-status-summary]')).toBeNull()
  expect(localRow.querySelector('.ui-list-row__description')).toBeNull()
  expect(root.textContent?.match(/Checking search status…/g) ?? []).toHaveLength(1)
  expect(root.querySelector<HTMLInputElement>('[data-vault-search-enabled]')?.disabled).toBe(true)
  expect(textLeaves(root, 'Checking status')).toHaveLength(1)
  expect(textLeaves(localRow, 'Checking')).toHaveLength(1)
})

test('embedded settings show the loading notice without a view heading', async () => {
  const pending = Promise.withResolvers<unknown>()
  const { context } = makeContext(makeResponder({ local: () => pending.promise, all: () => pending.promise }))
  const root = await mountSettings(context, mountSearchSettings)

  expect(root.querySelector('[data-vault-settings] div[role="status"][data-vault-search-loading] p.ui-notice-line')?.textContent).toBe('Checking search status…')
  expect(root.querySelector('.qvh-settings-heading')).toBeNull()
  const localRow = root.querySelector<HTMLElement>('[data-vault-host-id="local"]')!
  expect(localRow.querySelector('[data-vault-status-summary]')).toBeNull()
  expect(localRow.querySelector('.ui-list-row__description')).toBeNull()
  expect(root.textContent?.match(/Checking search status…/g) ?? []).toHaveLength(1)
  expect(root.querySelector<HTMLInputElement>('[data-vault-search-enabled]')?.disabled).toBe(true)
  expect(textLeaves(root, 'Checking status')).toHaveLength(1)
  expect(textLeaves(localRow, 'Checking')).toHaveLength(1)
})

test('loaded local status removes the loading notice and shows the disabled summary', async () => {
  const { context } = makeContext(makeResponder({
    local: () => localReply(),
    all: () => localReply()
  }))
  const root = await mountSettings(context)

  expect(root.querySelector('[data-vault-search-loading]')).toBeNull()
  expect(root.querySelector('[data-vault-status-summary]')?.textContent).toBe('Transcript search is off. Only titles are filtered until enabled.')
})

test('a local status read failure is displayed as an InlineError', async () => {
  const { context } = makeContext(makeResponder({
    local: () => { throw new Error('boom') },
    all: () => localReply()
  }))
  const root = await mountSettings(context)

  expect(root.querySelector('div.ui-inline-error[role="alert"] .ui-inline-error__message')?.textContent).toBe('Could not read local search status. boom')
  expect(root.querySelector('[data-vault-search-loading]')).toBeNull()
  expect(root.querySelector('.qvh-error-inline')).toBeNull()
})

test('a failed enable is displayed as an InlineError', async () => {
  const { context } = makeContext(makeResponder({
    local: () => localReply(),
    all: () => localReply(),
    enable: () => { throw new Error('refused') }
  }))
  const root = await mountSettings(context)
  const toggle = root.querySelector<HTMLInputElement>('[data-vault-search-enabled]')!

  await act(async () => { toggle.click() })
  await settle()

  expect(root.querySelector('div.ui-inline-error[role="alert"]')?.textContent).toBe('Could not enable search. Try again. refused')
})

test('a remote status read failure is an InlineError in its unavailable host row', async () => {
  const { context } = makeContext(makeResponder({
    local: () => localReply(),
    all: () => reply([host('local'), host('h1')]),
    remotes: { h1: () => { throw new Error('offline') } }
  }))
  const root = await mountSettings(context)
  const row = root.querySelector<HTMLElement>('[data-vault-host-id="h1"]')!
  const message = 'Could not read host search status. offline'

  expect(row.querySelector('div.ui-inline-error[role="alert"]')?.textContent).toBe(message)
  expect(row.textContent?.match(/Could not read host search status\. offline/g) ?? []).toHaveLength(1)
  expect(row.querySelector('.ui-list-row__description')).toBeNull()
  expect(row.querySelector('[role="status"]')).toBeNull()
  expect(row.querySelector('.qvh-error-inline')).toBeNull()
  expect(textLeaves(row, 'Unavailable')).toHaveLength(1)
  expect(row.querySelector('[data-vault-retry-host]')).not.toBeNull()
})

test('an other-hosts lookup failure is a NoticeLine advisory rather than an alert', async () => {
  const { context } = makeContext(makeResponder({
    local: () => localReply(),
    all: () => { throw new Error('down') }
  }))
  const root = await mountSettings(context)

  expect(root.querySelector('div[role="status"][data-vault-scope-status] p.ui-notice-line')?.textContent).toBe('Could not check other hosts. down')
  expect([...root.querySelectorAll('[role="alert"]')].filter((element) => element.textContent?.includes('down'))).toHaveLength(0)
  expect(root.querySelector('.qvh-tip')).toBeNull()
})

test('unavailable and unreachable outcomes show their specific InlineErrors without descriptions', async () => {
  const { context } = makeContext(makeResponder({
    local: () => localReply(),
    all: () => reply([
      host('local'),
      host('h2', { kind: 'error', reason: 'Connection refused.' }),
      host('h3', { kind: 'unavailable' }),
      host('h4', { kind: 'error' })
    ])
  }))
  const root = await mountSettings(context)
  const refused = root.querySelector<HTMLElement>('[data-vault-host-id="h2"]')!
  const unsupported = root.querySelector<HTMLElement>('[data-vault-host-id="h3"]')!
  const unreachable = root.querySelector<HTMLElement>('[data-vault-host-id="h4"]')!

  expect(refused.querySelector('div.ui-inline-error[role="alert"]')?.textContent).toBe('Connection refused.')
  expect(refused.querySelector('.ui-list-row__description')).toBeNull()
  expect(refused.dataset.vaultHostStatus).toBe('error')
  expect(refused.dataset.vaultHostOutcome).toBe('error')
  expect(textLeaves(refused, 'Unavailable')).toHaveLength(1)
  expect(refused.querySelector('[data-vault-retry-host]')).not.toBeNull()

  expect(unsupported.querySelector('div.ui-inline-error[role="alert"]')?.textContent).toBe('This host does not provide history search.')
  expect(unsupported.querySelector('.ui-list-row__description')).toBeNull()

  expect(unreachable.querySelector('div.ui-inline-error[role="alert"]')?.textContent).toBe('This host could not be reached.')
  expect(unreachable.querySelector('.ui-list-row__description')).toBeNull()
})

test('a host found through all-hosts is shown as checking until its status read resolves', async () => {
  const remote = Promise.withResolvers<unknown>()
  const { context } = makeContext(makeResponder({
    local: () => localReply(),
    all: () => reply([host('local'), host('h1')]),
    remotes: { h1: () => remote.promise }
  }))
  const root = await mountSettings(context)
  const row = root.querySelector<HTMLElement>('[data-vault-host-id="h1"]')!

  expect(row).not.toBeNull()
  expect(row.querySelector('div[role="status"][data-vault-host-checking] p.ui-notice-line')?.textContent).toBe('Checking search status…')
  expect(row.querySelector('.ui-list-row__description')).toBeNull()
  expect(row.querySelector('[role="alert"]')).toBeNull()
  expect(row.dataset.vaultHostStatus).toBe('checking')
  expect(textLeaves(row, 'Checking')).toHaveLength(1)
  expect(row.querySelector('[data-vault-retry-host]')).not.toBeNull()

  await act(async () => {
    remote.resolve(reply([], status({ enabled: true, phase: 'current' })))
    await remote.promise
  })
  await settle()

  expect(root.querySelector('[data-vault-host-id="h1"] [data-vault-host-checking]')).toBeNull()
  expect(root.querySelector('[data-vault-host-id="h1"] .ui-list-row__description')?.textContent).toBe('0 sessions · 0 messages searchable')
})

test('re-reading keeps a settled remote host steady while its next status read is pending', async () => {
  const pendingReread = Promise.withResolvers<unknown>()
  let allReads = 0
  let h1Reads = 0
  const { context } = makeContext(makeResponder({
    local: () => localReply(),
    all: () => {
      allReads += 1
      return reply([
        host('local'),
        host('h1'),
        host('h2', { kind: 'error', reason: 'Connection refused.' })
      ])
    },
    remotes: {
      h1: () => {
        h1Reads += 1
        return h1Reads === 1 ? reply([], status({ enabled: true, phase: 'current' })) : pendingReread.promise
      }
    }
  }))
  const root = await mountSettings(context)
  const initialRow = root.querySelector<HTMLElement>('[data-vault-host-id="h1"]')!

  expect(initialRow.dataset.vaultHostStatus).toBe('current')
  expect(initialRow.querySelector('.ui-list-row__description')?.textContent).toBe('0 sessions · 0 messages searchable')
  expect(initialRow.querySelector<HTMLInputElement>('[data-vault-host-switch]')?.checked).toBe(true)
  expect(initialRow.querySelector('[role="alert"]')).toBeNull()
  expect(initialRow.querySelector('[data-vault-host-checking]')).toBeNull()

  const retry = root.querySelector<HTMLElement>('[data-vault-host-id="h2"] [data-vault-retry-host]')!
  await act(async () => { retry.click() })
  await settle()

  const rereadRow = root.querySelector<HTMLElement>('[data-vault-host-id="h1"]')!
  expect(allReads).toBe(2)
  expect(h1Reads).toBe(2)
  expect(rereadRow.dataset.vaultHostStatus).toBe('current')
  expect(rereadRow.querySelector('.ui-list-row__description')?.textContent).toBe('0 sessions · 0 messages searchable')
  expect(rereadRow.querySelector<HTMLInputElement>('[data-vault-host-switch]')?.checked).toBe(true)
  expect(rereadRow.querySelector('[role="alert"]')).toBeNull()
  expect(rereadRow.querySelector('[data-vault-host-checking]')).toBeNull()
})

test('a host dropped from the next all-hosts reply is removed after Retry', async () => {
  let allReads = 0
  const { context } = makeContext(makeResponder({
    local: () => localReply(),
    all: () => {
      allReads += 1
      return allReads === 1
        ? reply([host('local'), host('h1'), host('h2', { kind: 'error', reason: 'Connection refused.' })])
        : reply([host('local'), host('h2', { kind: 'error', reason: 'Connection refused.' })])
    },
    remotes: { h1: () => reply([], status({ enabled: true, phase: 'current' })) }
  }))
  const root = await mountSettings(context)

  expect(root.querySelector('[data-vault-host-id="h1"]')).not.toBeNull()
  const retry = root.querySelector<HTMLElement>('[data-vault-host-id="h2"] [data-vault-retry-host]')!
  await act(async () => { retry.click() })
  await settle()

  expect(allReads).toBe(2)
  expect(root.querySelector('[data-vault-host-id="h1"]')).toBeNull()
})
