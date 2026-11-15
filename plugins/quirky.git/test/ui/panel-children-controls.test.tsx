import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { registerDom } from './register-dom'
import type { GitChange, GitCommit, GitHistory } from '@quirky/protocol'
import type { RowHandlers, RowItem } from '../../src/panel/Rows'

registerDom()
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const s = await import('./panel-support')
const { act, PANEL, byLabel, buttonText, click, entry, failure, fakeContext, layoutFor, mountPanel, q, qa, settle, statusOf, type } = s
const { createElement } = await import('react')
const { createRoot } = await import('react-dom/client')
const { Rows } = await import('../../src/panel/Rows')
const { GIT_UI_CONTROL_COMMAND } = await import('../../src/ui-control')

afterAll(() => GlobalRegistrator.unregister())
beforeEach(() => {
  document.body.innerHTML = ''
})

const mountedPanels = new Set<() => void>()
afterEach(() => {
  for (const unmount of [...mountedPanels]) unmount()
})

type Fake = ReturnType<typeof fakeContext>

async function openPanel(configure: (fake: Fake) => void = () => {}) {
  const fake = fakeContext(layoutFor('feat'))
  configure(fake)
  const mounted = mountPanel(fake)
  let live = true
  const unmount = () => {
    if (!live) return
    live = false
    mountedPanels.delete(unmount)
    mounted.unmount()
  }
  mountedPanels.add(unmount)
  await settle()
  return { fake, ...mounted, unmount }
}

const dialog = () => q(document.body, '[role="dialog"]')

async function openBaseDialog(element: HTMLElement) {
  await click(byLabel(element, 'More source control actions'))
  await click(buttonText(document.body, 'Change base…'))
  return dialog()!
}

async function openHistory(element: HTMLElement) {
  await click(byLabel(element, 'Expand Commits'))
  return q(element, '[data-history-content]')!
}

const commitA = 'a7'.padEnd(40, '0')
const commit = (oid: string = commitA, subject = `Commit ${oid.slice(0, 7)}`): GitCommit => ({
  oid,
  parents: [],
  author: 'Fixture Author',
  email: 'fixture@example.test',
  authoredAt: 1_700_000_000_000,
  committedAt: 1_700_000_000_000,
  subject,
  body: '',
  refs: []
})
const historyOf = (commits: GitCommit[], hasMore = false): GitHistory => ({ commits, hasMore })

const baseRow = (root: ParentNode, name?: string) =>
  qa(root, '[aria-label="Branches"] .ui-list-row__main').find((row) => name === undefined || row.textContent?.includes(name))

const historyRow = (root: ParentNode, oid = commitA) =>
  qa(root, '[data-commit-row]').find((row) => row.textContent?.includes(oid.slice(0, 7)))

describe('Change Base Ref states', () => {
  test('shows the loading notice instead of an empty state while branches are pending', async () => {
    const pending = Promise.withResolvers<{ refs: { name: string; kind: 'local' }[] }>()
    const { fake, element } = await openPanel((f) => f.on('quirky.git/branches', () => pending.promise))
    try {
      const picker = await openBaseDialog(element)
      expect(q(picker, '.ui-notice-line')?.textContent).toBe('Loading branches…')
      expect(q(picker, '.ui-empty-state')).toBeNull()
      expect(fake.called('quirky.git/branches').map(({ params }) => params)).toEqual([{ worktree: 'feat' }])
    } finally {
      await act(async () => pending.resolve({ refs: [] }))
      await settle()
    }
  })

  test('keeps the shown branch rows visible and disabled without a loading notice during a new query', async () => {
    const pending = Promise.withResolvers<{ refs: { name: string; kind: 'local' }[] }>()
    const { fake, element } = await openPanel((f) => {
      f.on('quirky.git/branches', (params) => params.query === 'rel'
        ? pending.promise
        : { refs: [{ name: 'release', kind: 'local' }] })
    })
    try {
      const picker = await openBaseDialog(element)
      const search = byLabel(picker, 'Search branches') as HTMLInputElement
      expect(baseRow(picker, 'release')).toBeDefined()
      await type(search, 'rel')
      expect(fake.called('quirky.git/branches').at(-1)?.params).toEqual({ worktree: 'feat', query: 'rel' })
      expect(q(picker, '.ui-notice-line')).toBeNull()
      expect(q(picker, '.ui-empty-state')).toBeNull()
      expect(baseRow(picker, 'release')).toBeDefined()
      expect(qa(q(picker, '[aria-label="Branches"]')!, 'button').length).toBeGreaterThan(0)
      expect(qa(q(picker, '[aria-label="Branches"]')!, 'button').every((button) => (button as HTMLButtonElement).disabled)).toBe(true)
    } finally {
      await act(async () => pending.resolve({ refs: [{ name: 'release', kind: 'local' }] }))
      await settle()
    }
  })

  test('retries branch read failures exactly once with the same initial and queried params', async () => {
    const { fake, element } = await openPanel((f) => {
      f.on('quirky.git/branches', () => { throw failure('fixture read failed') })
    })
    const picker = await openBaseDialog(element)
    expect(q(picker, '.ui-inline-error .ui-inline-error__message')?.textContent).toBe('fixture read failed')
    expect(buttonText(picker, 'Retry')).toBeDefined()
    expect(q(picker, '.ui-empty-state')).toBeNull()

    fake.on('quirky.git/branches', () => ({ refs: [{ name: 'main', kind: 'local' }] }))
    await click(buttonText(picker, 'Retry'))
    expect(fake.called('quirky.git/branches').map(({ params }) => params)).toEqual([
      { worktree: 'feat' },
      { worktree: 'feat' }
    ])
    expect(q(picker, '.ui-inline-error')).toBeNull()
    expect(baseRow(picker, 'main')).toBeDefined()

    fake.on('quirky.git/branches', (params) => {
      if (params.query === 'rel') throw failure('fixture read failed')
      return { refs: [{ name: 'main', kind: 'local' }] }
    })
    await type(byLabel(picker, 'Search branches') as HTMLInputElement, 'rel')
    expect(q(picker, '.ui-inline-error .ui-inline-error__message')?.textContent).toBe('fixture read failed')
    expect(buttonText(picker, 'Retry')).toBeDefined()
    fake.on('quirky.git/branches', () => ({ refs: [{ name: 'release', kind: 'local' }] }))
    await click(buttonText(picker, 'Retry'))
    expect(fake.called('quirky.git/branches').map(({ params }) => params)).toEqual([
      { worktree: 'feat' },
      { worktree: 'feat' },
      { worktree: 'feat', query: 'rel' },
      { worktree: 'feat', query: 'rel' }
    ])
    expect(q(picker, '.ui-inline-error')).toBeNull()
    expect(baseRow(picker, 'release')).toBeDefined()
  })

  test('a late reply for an older branch query cannot replace the newer results', async () => {
    const oldQuery = Promise.withResolvers<{ refs: { name: string; kind: 'local' }[] }>()
    const { element } = await openPanel((fake) => fake.on('quirky.git/branches', (params) => {
      if (params.query === 'old') return oldQuery.promise
      if (params.query === 'new') return { refs: [{ name: 'new-result', kind: 'local' }] }
      return { refs: [{ name: 'initial', kind: 'local' }] }
    }))
    const picker = await openBaseDialog(element)
    const search = byLabel(picker, 'Search branches') as HTMLInputElement
    await type(search, 'old')
    expect(baseRow(picker, 'initial')).toBeDefined()
    await type(search, 'new')
    expect(baseRow(picker, 'new-result')).toBeDefined()
    await act(async () => oldQuery.resolve({ refs: [{ name: 'stale-result', kind: 'local' }] }))
    await settle()
    expect(baseRow(picker, 'new-result')).toBeDefined()
    expect(baseRow(picker, 'stale-result')).toBeUndefined()
  })

  test('shows the shared empty state for no matches and separates save errors from read retries', async () => {
    const { fake, element } = await openPanel((f) => {
      f.on('quirky.git/branches', () => ({ refs: [] }))
      f.on('quirky.git/setBase', () => { throw failure('Cannot save base') })
    })
    const picker = await openBaseDialog(element)
    expect(q(picker, '.ui-empty-state')?.textContent).toBe('No matching branches')
    expect(q(picker, '.ui-notice-line')).toBeNull()

    fake.on('quirky.git/branches', () => ({ refs: [{ name: 'release', kind: 'local' }] }))
    await type(byLabel(picker, 'Search branches') as HTMLInputElement, 'rel')
    await click(baseRow(picker, 'release'))
    expect(q(picker, '[role="alert"]')?.textContent).toContain('Cannot save base')
    expect(q(picker, '.ui-inline-error .ui-inline-error__action')).toBeNull()
    expect(buttonText(picker, 'Retry')).toBeUndefined()
    expect(baseRow(picker, 'release')).toBeDefined()

    fake.on('quirky.git/setBase', () => ({}))
    await click(baseRow(picker, 'release'))
    expect(dialog()).toBeNull()
    expect(q(document.body, '[role="alert"]')).toBeNull()
  })
})

describe('Commits dock states', () => {
  test('shows a loading notice and retries a history read with the current worktree params', async () => {
    const pending = Promise.withResolvers<GitHistory>()
    const { fake, element } = await openPanel((f) => f.on('quirky.git/history', () => pending.promise))
    const content = await openHistory(element)
    expect(q(content, '.ui-notice-line')?.textContent).toBe('Loading commits…')
    expect(q(content, '.ui-empty-state')).toBeNull()
    expect(fake.called('quirky.git/history').map(({ params }) => params)).toEqual([{ worktree: 'feat' }])

    await act(async () => pending.reject(failure('fixture read failed')))
    await settle()
    expect(q(content, '.ui-inline-error .ui-inline-error__message')?.textContent).toBe('fixture read failed')
    expect(buttonText(content, 'Retry')).toBeDefined()

    fake.on('quirky.git/history', () => historyOf([commit()]))
    await click(buttonText(content, 'Retry'))
    expect(fake.called('quirky.git/history').map(({ params }) => params)).toEqual([
      { worktree: 'feat' },
      { worktree: 'feat' }
    ])
    expect(q(content, '.ui-inline-error')).toBeNull()
    expect(historyRow(content)).toBeDefined()
  })

  test('keeps earlier commits visible under a Load more failure and retries with limit 200', async () => {
    const initial = historyOf([commit()], true)
    let failMore = true
    const { fake, element } = await openPanel((f) => f.on('quirky.git/history', (params) => {
      if (params.limit === 200 && failMore) throw failure('fixture read failed')
      return params.limit === 200 ? historyOf([commit()], false) : initial
    }))
    const content = await openHistory(element)
    expect(historyRow(content)).toBeDefined()
    await click(buttonText(content, 'Load more'))
    expect(q(content, '.ui-inline-error .ui-inline-error__message')?.textContent).toBe('fixture read failed')
    expect(historyRow(content)).toBeDefined()
    expect(buttonText(content, 'Retry')).toBeDefined()

    failMore = false
    await click(buttonText(content, 'Retry'))
    expect(fake.called('quirky.git/history').map(({ params }) => params)).toEqual([
      { worktree: 'feat' },
      { worktree: 'feat', limit: 200 },
      { worktree: 'feat', limit: 200 }
    ])
    expect(q(content, '.ui-inline-error')).toBeNull()
    expect(historyRow(content)).toBeDefined()
  })

  test('renders the shared empty state when history has no commits', async () => {
    const { element } = await openPanel((f) => f.on('quirky.git/history', () => historyOf([], false)))
    const content = await openHistory(element)
    expect(q(content, '.ui-empty-state')?.textContent).toBe('No commits yet.')
    expect(q(content, '.ui-notice-line')).toBeNull()
  })

  test('shows pending and failed commit-file states, retries once, then caches the successful read', async () => {
    const pending = Promise.withResolvers<{ entries: GitChange[] }>()
    const changed: GitChange = { path: 'src/a.ts', status: 'modified', added: 1, removed: 0, binary: false }
    const { fake, element } = await openPanel((f) => {
      f.on('quirky.git/history', () => historyOf([commit()]))
      f.on('quirky.git/commitFiles', () => pending.promise)
    })
    const content = await openHistory(element)
    const expand = () => byLabel(element, `Expand commit ${commitA.slice(0, 7)}`)
    const collapse = () => byLabel(element, `Collapse commit ${commitA.slice(0, 7)}`)
    await click(expand())
    expect(q(historyRow(content)!, '.ui-notice-line')?.textContent).toBe('Loading files…')
    expect(fake.called('quirky.git/commitFiles').map(({ params }) => params)).toEqual([{ worktree: 'feat', commit: commitA }])

    await act(async () => pending.reject(failure('fixture files failed')))
    await settle()
    const row = historyRow(content)!
    expect(q(row, '.ui-inline-error .ui-inline-error__message')?.textContent).toBe('fixture files failed')
    expect(buttonText(row, 'Retry')).toBeDefined()

    fake.on('quirky.git/commitFiles', () => ({ entries: [changed] }))
    await click(buttonText(row, 'Retry'))
    expect(fake.called('quirky.git/commitFiles').map(({ params }) => params)).toEqual([
      { worktree: 'feat', commit: commitA },
      { worktree: 'feat', commit: commitA }
    ])
    expect(q(row, '.ui-inline-error')).toBeNull()
    expect(q(row, '[data-row-path="src/a.ts"]')).not.toBeNull()

    await click(collapse())
    await click(expand())
    expect(fake.called('quirky.git/commitFiles')).toHaveLength(2)
  })

  test('renders the shared empty state when a commit has no changed files', async () => {
    const { element } = await openPanel((f) => {
      f.on('quirky.git/history', () => historyOf([commit()]))
      f.on('quirky.git/commitFiles', () => ({ entries: [] }))
    })
    const content = await openHistory(element)
    await click(byLabel(element, `Expand commit ${commitA.slice(0, 7)}`))
    expect(q(historyRow(content)!, '.ui-empty-state')?.textContent).toBe('No files changed in this commit.')
  })
})

describe('Submodule expansion states', () => {
  test('uses shared loading, error, and empty states without a Retry action', async () => {
    const pending = Promise.withResolvers<{ entries: ReturnType<typeof entry>[] }>()
    const submodule = { commitChanged: false, trackedChanges: true, untrackedChanges: false }
    const { fake, element } = await openPanel((f) => {
      f.status = statusOf([entry('vendor/lib', 'unstaged', 'modified', { submodule })])
      f.on('quirky.git/submoduleStatus', () => pending.promise)
    })
    await click(byLabel(element, 'Expand vendor/lib'))
    expect(q(element, '[data-submodule-message]')?.textContent).toBe('Loading…')
    expect(q(element, '[data-submodule-message] .ui-notice-line')?.textContent).toBe('Loading…')

    await act(async () => pending.reject(failure('fixture submodule failed')))
    await settle()
    const failed = q(element, '[data-submodule-message]')!
    expect(failed.textContent).toBe('Could not load the submodule changes')
    expect(q(failed, '.ui-inline-error')).not.toBeNull()
    expect(q(failed, 'button')).toBeNull()

    await click(byLabel(element, 'Collapse vendor/lib'))
    fake.on('quirky.git/submoduleStatus', () => ({ entries: [] }))
    await click(byLabel(element, 'Expand vendor/lib'))
    const empty = q(element, '[data-submodule-message]')!
    expect(empty.textContent).toBe('No changes inside')
    expect(q(empty, '.ui-empty-state')?.textContent).toBe('No changes inside')
    expect(fake.called('quirky.git/submoduleStatus').map(({ params }) => params)).toEqual([
      { worktree: 'feat', path: 'vendor/lib' },
      { worktree: 'feat', path: 'vendor/lib' }
    ])
  })
})

describe('Rows forwarders', () => {
  test('routes each row control to its one handler and preserves event plumbing', async () => {
    const item: RowItem = { key: 'a.ts', path: 'a.ts', letter: 'M', uncommitted: true }
    const calls = {
      click: [] as RowItem[],
      toggleCheck: [] as RowItem[],
      toggleExpansion: [] as RowItem[],
      contextMenu: [] as Array<[RowItem, number, number]>,
      run: 0
    }
    const handlers: RowHandlers = {
      click: (row) => calls.click.push(row),
      contextMenu: (row, x, y) => calls.contextMenu.push([row, x, y]),
      buttons: () => [{ label: 'Test action', glyph: '✓', run: () => { calls.run++ } }],
      dragText: (row) => row.path,
      expansion: () => ({ open: false, entries: null, failed: false }),
      toggleExpansion: (row) => calls.toggleExpansion.push(row),
      check: () => false,
      toggleCheck: (row) => calls.toggleCheck.push(row)
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => root.render(createElement(Rows, { items: [item], selected: ['a.ts'], handlers })))
    try {
      const checkbox = byLabel(host, 'Include a.ts in the commit') as HTMLInputElement
      await act(async () => checkbox.click())
      await settle()
      expect(calls.toggleCheck).toEqual([item])
      expect(calls.click).toEqual([])

      await click(q(host, '[data-row-name]'))
      expect(calls.click).toEqual([item])
      expect(calls.toggleCheck).toEqual([item])

      await click(byLabel(host, 'Expand a.ts'))
      expect(calls.toggleExpansion).toEqual([item])
      expect(calls.click).toEqual([item])

      await click(byLabel(host, 'Test action a.ts'))
      expect(calls.run).toBe(1)
      expect(calls.click).toEqual([item])

      const row = q(host, '[data-row-path="a.ts"]')!
      const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 31, clientY: 47 })
      await act(async () => { row.dispatchEvent(event) })
      expect(event.defaultPrevented).toBe(true)
      expect(calls.contextMenu).toEqual([[item, 31, 47]])
      expect(calls.click).toEqual([item])
    } finally {
      await act(async () => root.unmount())
      host.remove()
    }
  })
})

type ControlAddress = { surface: string; target: string; generation: string; actions: string[] }
type ControlResult = { delivered: boolean }
type ControlHandler = (args: unknown) => ControlResult

function addressFromReport(fake: Fake, target: string): ControlAddress {
  const addresses = (fake.reports.at(-1)?.uiControls ?? []) as ControlAddress[]
  const matches = addresses.filter((address) => address.target === target)
  if (matches.length !== 1) throw new Error(`Expected one reported control address for ${target}, found ${matches.length}`)
  return matches[0]!
}

function historyAddress(fake: Fake): ControlAddress {
  return addressFromReport(fake, 'history:feat')
}

function panelCommand(fake: Fake): ControlHandler {
  const command = fake.provided.get(GIT_UI_CONTROL_COMMAND)
  if (typeof command !== 'function') throw new Error('The activated panel did not provide its UI control command')
  return command as ControlHandler
}

const controlArgs = (address: ControlAddress, action: string, data?: Record<string, unknown>) => ({
  surface: address.surface,
  target: address.target,
  generation: address.generation,
  action,
  ...(data === undefined ? {} : { data })
})

async function dispatchControl(fake: Fake, args: unknown): Promise<ControlResult> {
  let result: ControlResult | undefined
  await act(async () => {
    result = panelCommand(fake)(args)
  })
  await settle()
  return result!
}

function mountExistingPanel(fake: Fake) {
  const mounted = mountPanel(fake)
  let live = true
  const unmount = () => {
    if (!live) return
    live = false
    mountedPanels.delete(unmount)
    mounted.unmount()
  }
  mountedPanels.add(unmount)
  return { ...mounted, unmount }
}

describe('History dock mounted controls', () => {
  test('reports one scoped history address and routes pointer and direct commands through it', async () => {
    const secondCommit = 'b7'.padEnd(40, '0')
    const { fake, element } = await openPanel((f) => {
      f.on('quirky.git/history', () => historyOf([commit(), commit(secondCommit)], true))
      f.on('quirky.git/commitFiles', () => ({ entries: [] }))
    })
    fake.on('ui.window.self', () => ({ connId: 22 }))
    const content = await openHistory(element)
    const address = historyAddress(fake)
    expect(address).toEqual({
      surface: PANEL,
      target: 'history:feat',
      generation: expect.any(String),
      actions: ['toggle-commit', 'load-more']
    })

    await click(byLabel(element, `Expand commit ${commitA.slice(0, 7)}`))
    const args = controlArgs(address, 'toggle-commit', { commit: commitA, open: true })
    expect(fake.called('ui.window.command.run').at(-1)?.params).toEqual({
      connId: 22,
      id: GIT_UI_CONTROL_COMMAND,
      args
    })
    expect(fake.called('quirky.git/commitFiles').map(({ params }) => params)).toEqual([
      { worktree: 'feat', commit: commitA }
    ])

    expect(await dispatchControl(fake, args)).toEqual({ delivered: true })
    expect(byLabel(element, `Collapse commit ${commitA.slice(0, 7)}`)?.getAttribute('aria-expanded')).toBe('true')
    expect(fake.called('quirky.git/commitFiles')).toHaveLength(1)

    await click(buttonText(content, 'Load more'))
    expect(fake.called('quirky.git/history').map(({ params }) => params)).toEqual([
      { worktree: 'feat' },
      { worktree: 'feat', limit: 200 }
    ])
    expect(historyAddress(fake).actions).toEqual(['toggle-commit'])

    await click(byLabel(element, 'Collapse Commits'))
    expect((fake.reports.at(-1)?.uiControls ?? []).filter((address: ControlAddress) => address.target === 'history:feat')).toEqual([])
  })

  test('refuses missing and malformed commit toggles and an unoffered Load more without effects', async () => {
    const { fake, element } = await openPanel((f) => f.on('quirky.git/history', () => historyOf([commit()], false)))
    const content = await openHistory(element)
    const address = historyAddress(fake)
    expect(address.actions).toEqual(['toggle-commit'])
    const handler = panelCommand(fake)
    const beforeCalls = fake.calls.length
    const invalid = [
      controlArgs(address, 'toggle-commit', { commit: 'not-in-history', open: true }),
      controlArgs(address, 'toggle-commit', { commit: 17, open: true }),
      controlArgs(address, 'toggle-commit', { commit: commitA, open: 'true' }),
      controlArgs(address, 'load-more')
    ]
    const results: ControlResult[] = []
    await act(async () => {
      for (const args of invalid) results.push(handler(args))
    })
    await settle()

    expect(results).toEqual([
      { delivered: false },
      { delivered: false },
      { delivered: false },
      { delivered: false }
    ])
    expect(fake.calls).toHaveLength(beforeCalls)
    expect(fake.called('quirky.git/commitFiles')).toEqual([])
    expect(byLabel(element, `Expand commit ${commitA.slice(0, 7)}`)?.getAttribute('aria-expanded')).toBe('false')
    expect(q(content, '.ui-inline-error')).toBeNull()
    expect(fake.toasts).toEqual([])
  })

  test('rejects old generations after close/reopen and after remount', async () => {
    const { fake, element, unmount } = await openPanel((f) => f.on('quirky.git/history', () => historyOf([commit()])))
    await openHistory(element)
    const oldAddress = historyAddress(fake)
    const oldArgs = controlArgs(oldAddress, 'toggle-commit', { commit: commitA, open: true })

    await click(byLabel(element, 'Collapse Commits'))
    expect((fake.reports.at(-1)?.uiControls ?? []).filter((address: ControlAddress) => address.target === 'history:feat')).toEqual([])
    await click(byLabel(element, 'Expand Commits'))
    const reopenedAddress = historyAddress(fake)
    expect(reopenedAddress.generation).not.toBe(oldAddress.generation)
    const readsAfterReopen = fake.called('quirky.git/history').length
    expect(await dispatchControl(fake, oldArgs)).toEqual({ delivered: false })
    expect(fake.called('quirky.git/history')).toHaveLength(readsAfterReopen)
    expect(fake.called('quirky.git/commitFiles')).toEqual([])
    expect(byLabel(element, `Expand commit ${commitA.slice(0, 7)}`)?.getAttribute('aria-expanded')).toBe('false')

    unmount()
    const remounted = mountExistingPanel(fake)
    await settle()
    await openHistory(remounted.element)
    const remountedAddress = historyAddress(fake)
    expect(remountedAddress.generation).not.toBe(oldAddress.generation)
    const readsAfterRemount = fake.called('quirky.git/history').length
    expect(await dispatchControl(fake, oldArgs)).toEqual({ delivered: false })
    expect(fake.called('quirky.git/history')).toHaveLength(readsAfterRemount)
    expect(fake.called('quirky.git/commitFiles')).toEqual([])
    expect(byLabel(remounted.element, `Expand commit ${commitA.slice(0, 7)}`)?.getAttribute('aria-expanded')).toBe('false')
  })

  test('reserves Load more in the same turn and removes it after the maximum limit is requested', async () => {
    const { fake, element } = await openPanel((f) => f.on('quirky.git/history', () => historyOf([commit()], true)))
    await openHistory(element)
    const address = historyAddress(fake)
    const args = controlArgs(address, 'load-more')
    const handler = panelCommand(fake)
    let first: ControlResult | undefined
    let second: ControlResult | undefined
    await act(async () => {
      first = handler(args)
      second = handler(args)
    })
    await settle()

    expect(first).toEqual({ delivered: true })
    expect(second).toEqual({ delivered: false })
    expect(fake.called('quirky.git/history').map(({ params }) => params)).toEqual([
      { worktree: 'feat' },
      { worktree: 'feat', limit: 200 }
    ])
    expect(historyAddress(fake).actions).toEqual(['toggle-commit'])
  })

  for (const mode of ['refused', 'rejected', 'malformed'] as const) {
    test(`history delivery ${mode} uses the parent refresh toast and leaves the dock unchanged`, async () => {
      const { fake, element } = await openPanel((f) => {
        f.on('quirky.git/history', () => historyOf([commit()]))
        f.on('quirky.git/commitFiles', () => ({ entries: [] }))
      })
      fake.on('ui.window.self', () => ({ connId: 22 }))
      const content = await openHistory(element)
      await click(byLabel(element, 'More source control actions'))
      fake.on('ui.window.command.run', () => {
        if (mode === 'rejected') throw new Error('bridge down')
        return mode === 'refused' ? { result: { delivered: false } } : { result: {} }
      })
      const historyReads = fake.called('quirky.git/history').length

      await click(buttonText(document.body, 'Refresh'))
      const refreshToast = {
        toast: fake.toasts.at(-1),
        options: fake.toastOptions.at(-1)
      }
      expect(refreshToast.toast).toBeDefined()

      await click(byLabel(element, `Expand commit ${commitA.slice(0, 7)}`))
      expect({
        toast: fake.toasts.at(-1),
        options: fake.toastOptions.at(-1)
      }).toEqual(refreshToast)
      expect(byLabel(element, `Expand commit ${commitA.slice(0, 7)}`)?.getAttribute('aria-expanded')).toBe('false')
      expect(q(content, '[data-commit-row]')).not.toBeNull()
      expect(fake.called('quirky.git/history')).toHaveLength(historyReads)
      expect(fake.called('quirky.git/commitFiles')).toEqual([])
    })
  }

  test('does not toast a failed history delivery after the panel unmounts', async () => {
    const delivery = Promise.withResolvers<unknown>()
    const { fake, element, unmount } = await openPanel((f) => f.on('quirky.git/history', () => historyOf([commit()])))
    await openHistory(element)
    const beforeCommandCalls = fake.called('ui.window.command.run').length
    fake.on('ui.window.command.run', () => delivery.promise)

    await click(byLabel(element, `Expand commit ${commitA.slice(0, 7)}`))
    expect(fake.called('ui.window.command.run')).toHaveLength(beforeCommandCalls + 1)
    unmount()
    await act(async () => delivery.resolve({ result: { delivered: false } }))
    await settle()
    expect(fake.toasts).toEqual([])
  })
})
