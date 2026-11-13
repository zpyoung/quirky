import { afterEach, expect, test } from 'bun:test'
import { existsSync, symlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { QuirkyClient, type Ask, type AskSpec, type QuirkyEvent, type Repo, type Session, type Worktree } from '@quirky/protocol'
import { rpcUrl } from '@quirky/protocol/node'
import { chromium } from 'playwright'
import { makeTempDir } from '../../daemon/test/plugins/fixtures'
import { attentionStoreFor, createAttentionStore } from '../src/shell/attention'
import { bootWindow, closeWindows, installUiPlugin, provide, type WindowEnv } from './fixtures/window-env'

const browserExecutable = chromium.executablePath()

const CURRENT_VIEW = 'view:acme.attention/current'
const INBOX = 'host:inbox'

function writeAttentionPlugin(installed: string): void {
  installUiPlugin(
    installed,
    'acme.attention',
    { view: [{ id: 'current', title: 'Current worktree' }] },
    provide(CURRENT_VIEW, `element.textContent = 'Current worktree ' + JSON.stringify(props.input ?? null)`)
  )
}

function attentionBuiltinPlugins(): string {
  const builtins = makeTempDir('ui-shell-attention-builtins-')
  // Real quirky.* plugins must be discovered as built-ins; installed quirky.* IDs are reserved.
  for (const id of ['quirky.repo', 'quirky.worktree', 'quirky.cli', 'quirky.sidebar-extras', 'quirky.ask']) {
    symlinkSync(resolve(import.meta.dir, '../../../plugins', id), join(builtins, id))
  }
  installUiPlugin(
    builtins,
    'quirky.session',
    { view: [{ id: 'worktree', title: 'Session worktree' }] },
    provide('view:quirky.session/worktree', `element.textContent = 'session ' + JSON.stringify(props.input ?? null)`)
  )
  return builtins
}

afterEach(closeWindows)

async function bootAttention() {
  const env = await bootWindow(writeAttentionPlugin, { builtinPluginsDir: attentionBuiltinPlugins() })
  const currentPath = makeTempDir('ui-shell-attention-current-')
  const otherPath = makeTempDir('ui-shell-attention-other-')
  const [currentRepo, otherRepo] = await Promise.all([
    env.agent.callAny('quirky.repo/add', { path: currentPath, folder: true }) as Promise<Repo>,
    env.agent.callAny('quirky.repo/add', { path: otherPath, folder: true }) as Promise<Repo>
  ])
  const listed = await env.agent.callAny('quirky.worktree/list', {}) as Worktree[]
  const current = listed.find((worktree) => worktree.repoId === currentRepo.id)
  const other = listed.find((worktree) => worktree.repoId === otherRepo.id)
  if (!current || !other) throw new Error('The real worktree API did not return both folder projects.')

  await env.agent.callAny('ui.view.open', { id: CURRENT_VIEW, input: { worktree: current.id } })
  await env.win.waitFor(() => {
    const view = env.win.host.getState().layout.view
    return view?.id === CURRENT_VIEW && (view.input as { worktree?: string } | undefined)?.worktree === current.id
  })
  const attention = attentionStoreFor(env.win.connection, env.win.host)
  await env.win.waitFor(() => {
    const { repos, worktrees } = attention.getSnapshot()
    return repos?.some((repo) => repo.id === currentRepo.id) &&
      repos.some((repo) => repo.id === otherRepo.id) &&
      worktrees?.some((worktree) => worktree.id === current.id) &&
      worktrees.some((worktree) => worktree.id === other.id)
  })
  return { env, attention, current, other, currentRepo, otherRepo }
}

// This CLI hello carries the asker worktree context without inventing session authority.
async function createAsk(env: WindowEnv, spec: AskSpec, worktree: Worktree): Promise<string> {
  const caller = await QuirkyClient.connect(rpcUrl(env.harness.runtime), {
    role: 'cli',
    name: 'shell-attention-test',
    worktreeId: worktree.id
  })
  env.harness.clients.push(caller)
  const result = await caller.callAny('quirky.ask/register', { spec, requestId: crypto.randomUUID() }) as { askId?: unknown }
  if (typeof result.askId !== 'string') throw new Error('The real Ask API did not return an ask ID.')
  return result.askId
}

async function pendingAsks(env: WindowEnv): Promise<Ask[]> {
  return await env.agent.callAny('quirky.ask/list', { pendingOnly: true }) as Ask[]
}

function buttonNamed(env: WindowEnv, label: string): HTMLButtonElement | undefined {
  return [...env.win.document.querySelectorAll('button')]
    .find((button) => button.textContent?.trim() === label || button.getAttribute('aria-label') === label)
}

async function clickButton(env: WindowEnv, label: string): Promise<void> {
  await env.win.waitFor(() => buttonNamed(env, label))
  buttonNamed(env, label)!.click()
}

test('the chrome projection keeps the selected window worktree when a global view omits its input', async () => {
  const { env, attention, current, other, currentRepo, otherRepo } = await bootAttention()
  expect(attention.getSnapshot().selectedWorktreeId).toBe(current.id)
  expect(attention.getSnapshot().repos?.map((repo) => repo.id)).toEqual(expect.arrayContaining([currentRepo.id, otherRepo.id]))
  expect(attention.getSnapshot().worktrees?.map((worktree) => worktree.id)).toEqual(expect.arrayContaining([current.id, other.id]))

  await env.agent.callAny('ui.view.open', { id: CURRENT_VIEW })
  await env.win.waitFor(() => env.win.host.getState().layout.view?.input === undefined)
  expect(attention.getSnapshot().selectedWorktreeId).toBe(current.id)

  const extraPath = makeTempDir('ui-shell-attention-added-')
  const extraRepo = await env.agent.callAny('quirky.repo/add', { path: extraPath, folder: true }) as Repo
  await env.win.waitFor(() => attention.getSnapshot().repos?.some((repo) => repo.id === extraRepo.id))
  await env.win.waitFor(() => attention.getSnapshot().worktrees?.some((worktree) => worktree.repoId === extraRepo.id))
  expect(attention.getSnapshot().selectedWorktreeId).toBe(current.id)
})

test('a new ask in another worktree expires from the toast only and remains pending in the real Ask API', async () => {
  const { env, attention, current, other } = await bootAttention()
  const originalView = env.win.host.getState().layout.view
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  const fakeTimers = new Map<number, () => void>()
  let nextTimer = 1_000_000
  globalThis.setTimeout = ((run: () => void, delay?: number) => {
    if (delay === 8000) {
      const id = nextTimer++
      fakeTimers.set(id, run)
      return id
    }
    return originalSetTimeout(run, delay)
  }) as unknown as typeof setTimeout
  globalThis.clearTimeout = ((handle: number) => {
    if (fakeTimers.delete(handle)) return
    originalClearTimeout(handle as unknown as ReturnType<typeof setTimeout>)
  }) as unknown as typeof clearTimeout

  try {
    const askId = await createAsk(env, {
      title: 'Review the feature worktree',
      questions: [{ id: 'note', type: 'text', question: 'What should change?' }]
    }, other)
    await env.win.waitFor(() => attention.getSnapshot().toasts.some((toast) => toast.ask.id === askId))
    expect(env.win.host.getState().layout.view).toEqual(originalView)
    expect(attention.getSnapshot().selectedWorktreeId).toBe(current.id)
    expect((await pendingAsks(env)).some((ask) => ask.id === askId)).toBe(true)
    expect((await pendingAsks(env)).find((ask) => ask.id === askId)?.worktreeId).toBe(other.id)

    const [timerId, fire] = [...fakeTimers.entries()][0] ?? []
    expect(timerId).toBeDefined()
    fakeTimers.delete(timerId!)
    fire!()
    await env.win.waitFor(() => !attention.getSnapshot().toasts.some((toast) => toast.ask.id === askId))
    expect((await pendingAsks(env)).find((ask) => ask.id === askId)?.envelope.status).toBe('pending')
    expect(env.win.host.getState().layout.view).toEqual(originalView)
  } finally {
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
  }
})

test('a toast answer resolves through the daemon without changing the selected worktree view', async () => {
  const { env, attention, current, other } = await bootAttention()
  const originalView = env.win.host.getState().layout.view
  const askId = await createAsk(env, {
    title: 'Approve this change',
    questions: [{ id: 'approve', type: 'confirm', question: 'Approve?' }]
  }, other)
  await env.win.waitFor(() => attention.getSnapshot().toasts.some((toast) => toast.ask.id === askId))
  expect(attention.getSnapshot().selectedWorktreeId).toBe(current.id)

  await clickButton(env, 'Yes')
  await env.win.waitFor(async () => {
    const ask = (await env.agent.callAny('quirky.ask/list', { pendingOnly: false }) as Ask[]).find((candidate) => candidate.id === askId)
    return ask?.envelope.status === 'answered'
  })
  const answered = (await env.agent.callAny('quirky.ask/list', { pendingOnly: false }) as Ask[]).find((ask) => ask.id === askId)
  expect(answered?.envelope.answers.approve).toMatchObject({ value: true, source: 'input' })
  expect(attention.getSnapshot().toasts.some((toast) => toast.ask.id === askId)).toBe(false)
  expect(env.win.host.getState().layout.view).toEqual(originalView)
})

test('a failed Inbox answer remains pending and actionable until a valid answer reaches the daemon', async () => {
  const { env, attention, current } = await bootAttention()
  await env.agent.callAny('ui.tool.open', { id: INBOX })
  const askId = await createAsk(env, {
    title: 'Choose an action',
    questions: [{
      id: 'action', type: 'select', question: 'Which action?', required: true,
      options: [{ value: 'approve', label: 'Approve' }]
    }]
  }, current)
  const card = `[data-ask-id="${askId}"]`
  await env.win.waitFor(() => env.win.document.querySelector(card))

  await clickButton(env, 'Answer')
  await env.win.waitFor(() => env.win.document.querySelector(`${card} [role="alert"]`))
  expect((await pendingAsks(env)).some((ask) => ask.id === askId)).toBe(true)
  expect(buttonNamed(env, 'Answer')).toBeDefined()

  await clickButton(env, 'Approve')
  await clickButton(env, 'Answer')
  await env.win.waitFor(async () => !(await pendingAsks(env)).some((ask) => ask.id === askId))
  const answered = (await env.agent.callAny('quirky.ask/list', { pendingOnly: false }) as Ask[]).find((ask) => ask.id === askId)
  expect(answered?.envelope.answers.action).toMatchObject({ value: 'approve', label: 'Approve', source: 'option' })
  expect(attention.getSnapshot().asks?.some((ask) => ask.id === askId)).toBe(false)
})
test.skipIf(!existsSync(browserExecutable))('the Inbox count stays beside the title and the title truncates only at minimum width', async () => {
  const { env } = await bootAttention()
  await env.agent.callAny('ui.tool.open', { id: INBOX })
  await env.win.waitFor(() => {
    const badge = env.win.document.querySelector<HTMLElement>('.shell-inbox .ui-section-header__actions .ui-badge')
    return badge?.textContent?.trim() === '0'
  }, 10_000)
  const inboxMarkup = env.win.document.querySelector<HTMLElement>('.shell-inbox')!.outerHTML

  const [compatibilityTokens, tokens, components, globalStyles, chromeStyles, toolShellStyles] = await Promise.all([
    Bun.file(new URL('../src/design-system/compatibility-tokens.css', import.meta.url)).text(),
    Bun.file(new URL('../src/design-system/tokens.css', import.meta.url)).text(),
    Bun.file(new URL('../src/design-system/components.css', import.meta.url)).text(),
    Bun.file(new URL('../src/styles.css', import.meta.url)).text(),
    Bun.file(new URL('../src/shell/chrome.css', import.meta.url)).text(),
    Bun.file(new URL('../src/shell/tool-shell.css', import.meta.url)).text()
  ])
  const globalRules = globalStyles.replace(/^@import ['"][^'"]+['"];\s*/gm, '')
  const styles = `${chromeStyles}\n${toolShellStyles}\n${compatibilityTokens}\n${tokens}\n${components}\n${globalRules}`
  const browser = await chromium.launch({ headless: true, args: process.platform === 'linux' ? ['--no-sandbox'] : [] })
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
    for (const width of [160, 320]) {
      await page.setContent(`
        <style>${styles}</style>
        <main data-theme="dark" style="position:relative;overflow:hidden;width:${width}px;height:180px">
          <div class="tool-shell__panel tool-shell__panel--left-bottom" style="left:0;top:0;width:${width}px;height:180px">${inboxMarkup}</div>
        </main>
      `)
      const bounds = await page.locator('.shell-inbox').evaluate((inbox) => {
        const header = inbox.querySelector<HTMLElement>('.ui-section-header')!
        const title = header.querySelector<HTMLElement>('.ui-section-header__title')!
        const count = header.querySelector<HTMLElement>('.ui-section-header__actions .ui-badge')!
        const rect = (element: Element) => {
          const { left, right, top, bottom, width, height } = element.getBoundingClientRect()
          return { left, right, top, bottom, width, height }
        }
        return {
          panel: rect(inbox.closest('.tool-shell__panel')!),
          inbox: rect(inbox),
          header: rect(header),
          title: { ...rect(title), scrollWidth: title.scrollWidth, clientWidth: title.clientWidth },
          count: rect(count)
        }
      })

      expect(bounds.panel.width).toBe(width)
      expect(Math.abs((bounds.title.top + bounds.title.height / 2) - (bounds.count.top + bounds.count.height / 2))).toBeLessThanOrEqual(1)
      expect(bounds.count.left).toBeGreaterThanOrEqual(bounds.header.left - 1)
      expect(bounds.count.right).toBeLessThanOrEqual(bounds.header.right + 1)
      expect(bounds.count.top).toBeGreaterThanOrEqual(bounds.header.top - 1)
      expect(bounds.count.bottom).toBeLessThanOrEqual(bounds.header.bottom + 1)
      expect(bounds.count.left).toBeGreaterThanOrEqual(bounds.inbox.left - 1)
      expect(bounds.count.right).toBeLessThanOrEqual(bounds.inbox.right + 1)
      expect(bounds.count.top).toBeGreaterThanOrEqual(bounds.inbox.top - 1)
      expect(bounds.count.bottom).toBeLessThanOrEqual(bounds.inbox.bottom + 1)
      if (width === 160) {
        expect(bounds.title.scrollWidth).toBeGreaterThan(bounds.title.clientWidth)
      } else {
        expect(bounds.title.scrollWidth).toBeLessThanOrEqual(bounds.title.clientWidth)
      }
    }
  } finally {
    await browser.close()
  }
}, 60_000)

test('the Inbox More below cue tracks overflow, scrolling, resize, and content changes', async () => {
  const { env, current } = await bootAttention()
  const originalResizeObserver = globalThis.ResizeObserver
  const observers: Array<{
    targets: Set<Element>
    notify(target: Element): void
  }> = []
  class ControlledResizeObserver {
    private readonly targets = new Set<Element>()

    constructor(private readonly callback: ResizeObserverCallback) {
      observers.push({
        targets: this.targets,
        notify: (target) => {
          if (this.targets.has(target)) {
            this.callback([{ target } as ResizeObserverEntry], this as unknown as ResizeObserver)
          }
        }
      })
    }
    observe(target: Element): void { this.targets.add(target) }
    unobserve(target: Element): void { this.targets.delete(target) }
    disconnect(): void { this.targets.clear() }
  }
  globalThis.ResizeObserver = ControlledResizeObserver as unknown as typeof ResizeObserver

  try {
    await env.agent.callAny('ui.tool.open', { id: INBOX })
    const askId = await createAsk(env, {
      title: 'Choose a response',
      questions: [{ id: 'reply', type: 'text', question: 'What should happen next?' }]
    }, current)
    const card = `[data-ask-id="${askId}"]`
    await env.win.waitFor(() => env.win.document.querySelector(card))

    const scrollport = env.win.document.querySelector<HTMLElement>('[aria-label="Pending question content"]')!
    const content = scrollport.firstElementChild as HTMLElement
    let clientHeight = 120
    let scrollHeight = 120
    let scrollTop = 0
    Object.defineProperties(scrollport, {
      clientHeight: { configurable: true, get: () => clientHeight },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => { scrollTop = Math.max(0, Math.min(value, scrollHeight - clientHeight)) }
      }
    })
    await env.win.waitFor(() => observers.some(({ targets }) => targets.has(scrollport)))
    const notifyResize = (target: Element) => {
      for (const observer of observers) observer.notify(target)
    }
    const updateLayout = (...targets: Element[]) => {
      for (const target of targets) notifyResize(target)
    }
    const waitForCue = (visible: boolean) =>
      env.win.waitFor(() => (buttonNamed(env, 'More below') !== undefined) === visible, 1000)

    updateLayout(scrollport, content)
    await waitForCue(false)

    scrollHeight = 320
    updateLayout(content)
    await waitForCue(true)
    const answerButton = buttonNamed(env, 'Answer')!
    answerButton.focus()
    const moreBelow = buttonNamed(env, 'More below')!
    moreBelow.click()
    scrollport.dispatchEvent(new Event('scroll'))
    await waitForCue(false)
    expect(scrollport.scrollTop).toBe(scrollHeight - clientHeight)
    expect(env.win.document.activeElement).toBe(answerButton)

    scrollTop = 0
    clientHeight = 360
    updateLayout(scrollport)
    await waitForCue(false)
    clientHeight = 80
    updateLayout(scrollport)
    await waitForCue(true)

    scrollHeight = 80
    updateLayout(content)
    await waitForCue(false)
    scrollHeight = 240
    updateLayout(content)
    await waitForCue(true)
    scrollTop = 159.75
    scrollport.dispatchEvent(new Event('scroll'))
    await waitForCue(false)
  } finally {
    globalThis.ResizeObserver = originalResizeObserver
  }
}, 15_000)

test('a slow options read cannot overwrite a newer project selection', async () => {
  let release: (value: unknown) => void = () => {}
  const slow = new Promise((resolve) => { release = resolve })
  const connection = {
    callAny: async (method: string) => method === 'quirky.worktree/options' ? slow : method === 'quirky.worktree/setOptions' ? {} : [],
    onEvent: () => () => {},
    onConnected: () => () => {}
  }
  const host = { getState: () => ({ layout: { worktree: null } }), subscribe: () => () => {}, openTool() {}, openView() {} }
  const store = createAttentionStore(connection as never, host as never)
  const unsubscribe = store.subscribe(() => {})
  await store.selectProject('r_new')
  release({ filterRepoIds: [] })
  await Bun.sleep(0)
  expect(store.getSnapshot().filterRepoIds).toEqual(['r_new'])
  unsubscribe()
})

test('narrowing writes filterRepoIds and opens the project worktree when the selection falls outside', async () => {
  const { env, attention, current, other, currentRepo, otherRepo } = await bootAttention()
  expect(attention.getSnapshot().filterRepoIds).toEqual([])

  expect(await attention.selectProject(otherRepo.id)).toBeNull()
  expect(await env.agent.callAny('quirky.worktree/options', {})).toMatchObject({ filterRepoIds: [otherRepo.id] })
  await env.win.waitFor(() => attention.getSnapshot().selectedWorktreeId === other.id)
  expect(attention.getSnapshot().filterRepoIds).toEqual([otherRepo.id])

  expect(await attention.selectProject(currentRepo.id)).toBeNull()
  await env.win.waitFor(() => attention.getSnapshot().selectedWorktreeId === current.id)

  expect(await attention.selectProject(null)).toBeNull()
  expect(await env.agent.callAny('quirky.worktree/options', {})).toMatchObject({ filterRepoIds: [] })
  await env.win.waitFor(() => attention.getSnapshot().filterRepoIds.length === 0)
  expect(attention.getSnapshot().selectedWorktreeId).toBe(current.id)
})

test('the needs-you count and toast ignore the narrowed project, and Open worktree returns to All projects', async () => {
  const { env, attention, current, other, otherRepo } = await bootAttention()
  await attention.selectProject(otherRepo.id)
  await env.win.waitFor(() => attention.getSnapshot().selectedWorktreeId === other.id)

  const askId = await createAsk(env, {
    title: 'Approve in the hidden project',
    questions: [{ id: 'approve', type: 'confirm', question: 'Approve?' }]
  }, current)
  await env.win.waitFor(() => attention.getSnapshot().toasts.some((toast) => toast.ask.id === askId))
  expect(attention.getSnapshot().asks?.map((ask) => ask.id)).toContain(askId)
  expect(attention.getSnapshot().filterRepoIds).toEqual([otherRepo.id])
  expect(attention.getSnapshot().selectedWorktreeId).toBe(other.id)

  await clickButton(env, 'Open worktree')
  await env.win.waitFor(() => attention.getSnapshot().selectedWorktreeId === current.id)
  await env.win.waitFor(() => attention.getSnapshot().filterRepoIds.length === 0)
  expect(await env.agent.callAny('quirky.worktree/options', {})).toMatchObject({ filterRepoIds: [] })
  await env.win.waitFor(() => !attention.getSnapshot().toasts.some((toast) => toast.ask.id === askId))
  expect((await pendingAsks(env)).some((ask) => ask.id === askId)).toBe(true)
})

type Call = { method: string; params: Record<string, unknown>; options?: { timeoutMs?: number } }
type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(reason?: unknown): void }

function deferred<T>(): Deferred<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>()
  return { promise, resolve, reject }
}

async function flushMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve()
}

function fakeScopeStore(options: {
  filterRepoIds: string[]
  selected: string | null
  worktrees: Partial<Worktree>[]
  sessions?: Session[]
  asks?: Ask[]
  sessionList?: () => Promise<Session[]>
  worktreeList?: () => Promise<Partial<Worktree>[]>
  failMethod?: string
}) {
  const calls: Call[] = []
  const listeners = new Set<(event: QuirkyEvent) => void>()
  const connection = {
    async callAny(method: string, params: Record<string, unknown> = {}, callOptions?: { timeoutMs?: number }) {
      calls.push({ method, params, ...(callOptions === undefined ? {} : { options: callOptions }) })
      if (options.failMethod === method) throw new Error('RPC call timed out after 20 ms')
      switch (method) {
        case 'quirky.repo/list':
          return [{ id: 'r1' }, { id: 'r2' }, { id: 'empty' }]
        case 'quirky.worktree/list':
          return options.worktreeList ? await options.worktreeList() : options.worktrees
        case 'quirky.session/list':
          return options.sessionList ? await options.sessionList() : options.sessions ?? []
        case 'quirky.ask/list':
          return options.asks ?? []
        case 'quirky.worktree/projectMetadataList':
          return []
        case 'quirky.worktree/options':
          return { filterRepoIds: options.filterRepoIds }
        case 'ui.window.self':
          return { connId: 7 }
        case 'quirky.session/get':
          return { worktreeId: 'wt1' }
        case 'quirky.ask/answer':
          return { askId: params.askId, status: 'answered' }
        default:
          return {}
      }
    },
    onEvent(listener: (event: QuirkyEvent) => void) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    onConnected: () => () => {}
  }
  const host = {
    getState: () => ({ layout: { worktree: options.selected } }),
    subscribe: () => () => {},
    openView() {},
    openTool() {}
  }
  const store = createAttentionStore(connection as never, host as never)
  const stop = store.subscribe(() => {})
  return {
    store,
    calls,
    stop,
    emit: (event: QuirkyEvent) => listeners.forEach((listener) => listener(event)),
    navigated: () => calls.filter((call) => call.method === 'quirky.worktree/navigate').map((call) => call.params)
  }
}

test('attention refresh reads have deadlines, while answer and navigation calls do not', async () => {
  const asks = [
    { id: 'delegated', createdAt: 2, envelope: { status: 'pending' }, handoff: true, sessionId: 's1', worktreeId: null },
    { id: 'answer', createdAt: 1, envelope: { status: 'pending' }, handoff: false, sessionId: null, worktreeId: null }
  ] as unknown as Ask[]
  const fake = fakeScopeStore({ filterRepoIds: [], selected: 'a', worktrees: [row('a', 'r1', 1)], asks })
  await flushMicrotasks()
  expect(await fake.store.openDelegatedQuestion('delegated')).toBe(true)
  expect(await fake.store.openWorktree('a')).toBeNull()
  expect(await fake.store.navigateHistory('back')).toBeNull()
  expect(await fake.store.navigateHistory('forward')).toBeNull()
  expect(await fake.store.selectProject('r1')).toBeNull()
  expect(await fake.store.answer('answer', {}, [])).toBeNull()

  for (const method of [
    'quirky.repo/list',
    'quirky.worktree/list',
    'quirky.session/list',
    'quirky.ask/list',
    'quirky.worktree/options',
    'quirky.worktree/projectMetadataList',
    'ui.window.self',
    'quirky.session/get'
  ]) {
    expect(fake.calls.filter((call) => call.method === method).length).toBeGreaterThan(0)
    const reads = fake.calls.filter((call) => call.method === method).map((call) => call.options)
    expect(reads.length).toBeGreaterThan(0)
    expect(reads).toEqual(Array.from({ length: reads.length }, () => ({ timeoutMs: 30000 })))
  }
  for (const method of [
    'quirky.ask/answer',
    'quirky.worktree/navigate',
    'quirky.worktree/setOptions',
    'quirky.worktree/navigationBack',
    'quirky.worktree/navigationForward'
  ]) {
    expect(fake.calls.filter((call) => call.method === method).length).toBeGreaterThan(0)
    expect(fake.calls.filter((call) => call.method === method).every((call) => call.options === undefined)).toBe(true)
  }
  fake.stop()
})

test('a timed-out attention list read records its error', async () => {
  const fake = fakeScopeStore({
    filterRepoIds: [],
    selected: null,
    worktrees: [],
    failMethod: 'quirky.repo/list'
  })
  await flushMicrotasks()
  expect(fake.store.getSnapshot().errors.repos).toBe('RPC call timed out after 20 ms')
  fake.stop()
})

const session = (id: string): Session => ({ id } as Session)

test('changed session events replace an existing session and append a new one without refetching', async () => {
  const a = session('a')
  const b = session('b')
  const a2 = { ...a, label: 'updated' } as Session
  const c = session('c')
  const fake = fakeScopeStore({ filterRepoIds: [], selected: null, worktrees: [], sessions: [a, b] })
  await flushMicrotasks()
  expect(fake.store.getSnapshot().sessions).toEqual([a, b])
  const initialListCalls = fake.calls.filter((call) => call.method === 'quirky.session/list').length

  fake.emit({ type: 'quirky.session/changed', data: { session: a2 } } as unknown as QuirkyEvent)
  expect(fake.store.getSnapshot().sessions).toEqual([a2, b])
  fake.emit({ type: 'quirky.session/changed', data: { session: c } } as unknown as QuirkyEvent)
  expect(fake.store.getSnapshot().sessions).toEqual([a2, b, c])
  expect(fake.calls.filter((call) => call.method === 'quirky.session/list')).toHaveLength(initialListCalls)
  fake.stop()
})

test('removed session events drop a known session and do not publish for unknown IDs', async () => {
  const fake = fakeScopeStore({
    filterRepoIds: [],
    selected: null,
    worktrees: [],
    sessions: [session('a'), session('b')]
  })
  await flushMicrotasks()
  const initialListCalls = fake.calls.filter((call) => call.method === 'quirky.session/list').length
  let publications = 0
  const unsubscribe = fake.store.subscribe(() => { publications += 1 })

  fake.emit({ type: 'quirky.session/removed', data: { sessionId: 'missing' } } as unknown as QuirkyEvent)
  expect(publications).toBe(0)
  expect(fake.store.getSnapshot().sessions).toEqual([session('a'), session('b')])
  fake.emit({ type: 'quirky.session/removed', data: { sessionId: 'b' } } as unknown as QuirkyEvent)
  expect(publications).toBe(1)
  expect(fake.store.getSnapshot().sessions).toEqual([session('a')])
  expect(fake.calls.filter((call) => call.method === 'quirky.session/list')).toHaveLength(initialListCalls)
  unsubscribe()
  fake.stop()
})

test('malformed session events refresh the session list', async () => {
  const fake = fakeScopeStore({ filterRepoIds: [], selected: null, worktrees: [], sessions: [session('a')] })
  await flushMicrotasks()
  const malformed: QuirkyEvent[] = [
    { type: 'quirky.session/changed', data: {} } as unknown as QuirkyEvent,
    { type: 'quirky.session/changed', data: { session: { id: 1 } } } as unknown as QuirkyEvent,
    { type: 'quirky.session/removed', data: { sessionId: 1 } } as unknown as QuirkyEvent
  ]
  for (const event of malformed) {
    const before = fake.calls.filter((call) => call.method === 'quirky.session/list').length
    fake.emit(event)
    expect(fake.calls.filter((call) => call.method === 'quirky.session/list')).toHaveLength(before + 1)
    await flushMicrotasks()
  }
  fake.stop()
})

test('an event after a failed session load refreshes the list again', async () => {
  let failFirst = true
  const fake = fakeScopeStore({
    filterRepoIds: [],
    selected: null,
    worktrees: [],
    sessionList: async () => {
      if (failFirst) {
        failFirst = false
        throw new Error('session list timed out')
      }
      return [session('a')]
    }
  })
  await flushMicrotasks()
  expect(fake.store.getSnapshot().errors.sessions).toBe('session list timed out')
  const before = fake.calls.filter((call) => call.method === 'quirky.session/list').length
  fake.emit({ type: 'quirky.session/changed', data: { session: session('b') } } as unknown as QuirkyEvent)
  expect(fake.calls.filter((call) => call.method === 'quirky.session/list')).toHaveLength(before + 1)
  await flushMicrotasks()
  expect(fake.store.getSnapshot().sessions).toEqual([session('a')])
  fake.stop()
})

test('an event during a session read publishes its result and reads again afterwards', async () => {
  const pending: Deferred<Session[]>[] = []
  const fake = fakeScopeStore({
    filterRepoIds: [],
    selected: null,
    worktrees: [],
    sessionList: () => {
      const result = deferred<Session[]>()
      pending.push(result)
      return result.promise
    }
  })
  expect(pending).toHaveLength(1)
  fake.emit({ type: 'quirky.session/changed', data: { session: session('from-event') } } as unknown as QuirkyEvent)
  expect(pending).toHaveLength(1)
  expect(fake.calls.filter((call) => call.method === 'quirky.session/list')).toHaveLength(1)

  pending[0]!.resolve([session('stale')])
  await flushMicrotasks()
  expect(fake.store.getSnapshot().sessions).toEqual([session('stale')])
  expect(pending).toHaveLength(2)

  pending[1]!.resolve([session('newer')])
  await flushMicrotasks()
  expect(fake.store.getSnapshot().sessions).toEqual([session('newer')])
  expect(fake.calls.filter((call) => call.method === 'quirky.session/list')).toHaveLength(2)
  fake.stop()
})

const row = (id: string, repoId: string, lastActivityAt: number): Partial<Worktree> => ({ id, repoId, lastActivityAt, createdAt: 0, name: id, removing: false })

test('a worktree burst shares one in-flight inventory refresh and one trailing refresh', async () => {
  const pending: Deferred<Partial<Worktree>[]>[] = []
  let deferWorktreeList = false
  const initialWorktrees = [row('initial', 'r1', 1)]
  const fake = fakeScopeStore({
    filterRepoIds: [],
    selected: null,
    worktrees: initialWorktrees,
    worktreeList: () => {
      if (!deferWorktreeList) return Promise.resolve(initialWorktrees)
      const result = deferred<Partial<Worktree>[]>()
      pending.push(result)
      return result.promise
    }
  })
  await flushMicrotasks()
  deferWorktreeList = true
  const repoCalls = fake.calls.filter((call) => call.method === 'quirky.repo/list').length
  const worktreeCalls = fake.calls.filter((call) => call.method === 'quirky.worktree/list').length

  for (let index = 0; index < 30; index += 1) {
    fake.emit({ type: 'quirky.worktree/changed', data: { worktreeId: `w${index}` } } as unknown as QuirkyEvent)
  }
  expect(fake.calls.filter((call) => call.method === 'quirky.repo/list')).toHaveLength(repoCalls + 1)
  expect(fake.calls.filter((call) => call.method === 'quirky.worktree/list')).toHaveLength(worktreeCalls + 1)
  expect(pending).toHaveLength(1)

  pending[0]!.resolve([row('a', 'r1', 1)])
  await flushMicrotasks()
  expect(fake.calls.filter((call) => call.method === 'quirky.repo/list')).toHaveLength(repoCalls + 2)
  expect(fake.calls.filter((call) => call.method === 'quirky.worktree/list')).toHaveLength(worktreeCalls + 2)
  expect(fake.store.getSnapshot().worktrees?.map((worktree) => worktree.id)).toEqual(['a'])
  expect(pending).toHaveLength(2)

  pending[1]!.resolve([row('a', 'r1', 1), row('b', 'r1', 2)])
  await flushMicrotasks()
  expect(fake.store.getSnapshot().worktrees?.map((worktree) => worktree.id)).toEqual(['a', 'b'])
  expect(fake.calls.filter((call) => call.method === 'quirky.repo/list')).toHaveLength(repoCalls + 2)
  expect(fake.calls.filter((call) => call.method === 'quirky.worktree/list')).toHaveLength(worktreeCalls + 2)
  fake.stop()
})

test('a mixed inventory burst requests one trailing worktree refresh', async () => {
  const pending: Deferred<Partial<Worktree>[]>[] = []
  let deferWorktreeList = false
  const initialWorktrees = [row('initial', 'r1', 1)]
  const fake = fakeScopeStore({
    filterRepoIds: [],
    selected: null,
    worktrees: initialWorktrees,
    worktreeList: () => {
      if (!deferWorktreeList) return Promise.resolve(initialWorktrees)
      const result = deferred<Partial<Worktree>[]>()
      pending.push(result)
      return result.promise
    }
  })
  await flushMicrotasks()
  deferWorktreeList = true
  const worktreeCalls = fake.calls.filter((call) => call.method === 'quirky.worktree/list').length

  for (let index = 0; index < 10; index += 1) {
    fake.emit({ type: 'quirky.repo/changed' } as unknown as QuirkyEvent)
    fake.emit({ type: 'quirky.worktree/changed', data: { worktreeId: `w${index}` } } as unknown as QuirkyEvent)
    fake.emit({ type: 'quirky.worktree/projectMetadataChanged' } as unknown as QuirkyEvent)
  }
  expect(fake.calls.filter((call) => call.method === 'quirky.worktree/list')).toHaveLength(worktreeCalls + 1)
  expect(pending).toHaveLength(1)

  pending[0]!.resolve([row('a', 'r1', 1)])
  await flushMicrotasks()
  expect(fake.calls.filter((call) => call.method === 'quirky.worktree/list')).toHaveLength(worktreeCalls + 2)
  expect(pending).toHaveLength(2)

  pending[1]!.resolve([row('b', 'r2', 2), row('c', 'r2', 3)])
  await flushMicrotasks()
  expect(fake.store.getSnapshot().worktrees?.map((worktree) => worktree.id)).toEqual(['b', 'c'])
  expect(fake.calls.filter((call) => call.method === 'quirky.worktree/list')).toHaveLength(worktreeCalls + 2)
  fake.stop()
})

test('a session burst during the initial list shares one trailing session read', async () => {
  const pending: Deferred<Session[]>[] = []
  const fake = fakeScopeStore({
    filterRepoIds: [],
    selected: null,
    worktrees: [],
    sessionList: () => {
      const result = deferred<Session[]>()
      pending.push(result)
      return result.promise
    }
  })
  expect(pending).toHaveLength(1)
  for (let index = 0; index < 30; index += 1) {
    fake.emit({ type: 'quirky.session/changed', data: { session: session(`s${index}`) } } as unknown as QuirkyEvent)
  }
  expect(fake.calls.filter((call) => call.method === 'quirky.session/list')).toHaveLength(1)
  expect(pending).toHaveLength(1)

  pending[0]!.resolve([session('stale')])
  await flushMicrotasks()
  expect(fake.store.getSnapshot().sessions).toEqual([session('stale')])
  expect(fake.calls.filter((call) => call.method === 'quirky.session/list')).toHaveLength(2)
  expect(pending).toHaveLength(2)

  pending[1]!.resolve([session('s1'), session('s2')])
  await flushMicrotasks()
  expect(fake.store.getSnapshot().sessions).toEqual([session('s1'), session('s2')])
  expect(fake.calls.filter((call) => call.method === 'quirky.session/list')).toHaveLength(2)
  fake.stop()
})

test('a stopped store drops pending inventory and session refreshes', async () => {
  const worktreePending: Deferred<Partial<Worktree>[]>[] = []
  const sessionPending: Deferred<Session[]>[] = []
  const fake = fakeScopeStore({
    filterRepoIds: [],
    selected: null,
    worktrees: [],
    worktreeList: () => {
      const result = deferred<Partial<Worktree>[]>()
      worktreePending.push(result)
      return result.promise
    },
    sessionList: () => {
      const result = deferred<Session[]>()
      sessionPending.push(result)
      return result.promise
    }
  })
  await flushMicrotasks()
  expect(worktreePending).toHaveLength(1)
  expect(sessionPending).toHaveLength(1)
  fake.emit({ type: 'quirky.worktree/changed', data: { worktreeId: 'w1' } } as unknown as QuirkyEvent)
  fake.emit({ type: 'quirky.session/changed', data: { session: session('event') } } as unknown as QuirkyEvent)
  expect(worktreePending).toHaveLength(1)
  expect(sessionPending).toHaveLength(1)
  const snapshotBeforeStop = fake.store.getSnapshot()
  fake.stop()

  worktreePending[0]!.resolve([row('late-worktree', 'r1', 1)])
  sessionPending[0]!.resolve([session('late-session')])
  await flushMicrotasks()
  expect(fake.calls.filter((call) => call.method === 'quirky.worktree/list')).toHaveLength(1)
  expect(fake.calls.filter((call) => call.method === 'quirky.session/list')).toHaveLength(1)
  expect(fake.store.getSnapshot()).toEqual(snapshotBeforeStop)
})

test('the scope follows the options and writes through setOptions, opening the most recently active worktree of the project', async () => {
  const fake = fakeScopeStore({
    filterRepoIds: ['r1'],
    selected: 'a',
    worktrees: [row('a', 'r1', 5), row('b', 'r2', 10), row('c', 'r2', 30), row('d', 'r2', 20)]
  })
  await Bun.sleep(20)
  expect(fake.store.getSnapshot().filterRepoIds).toEqual(['r1'])

  expect(await fake.store.selectProject('r2')).toBeNull()
  expect(fake.calls.find((call) => call.method === 'quirky.worktree/setOptions')?.params).toEqual({ filterRepoIds: ['r2'] })
  expect(fake.navigated()).toEqual([{ worktree: 'c', window: 7 }])
  fake.stop()
})

test('narrowing keeps the selection when it is inside the project or the project has no worktrees', async () => {
  const fake = fakeScopeStore({ filterRepoIds: [], selected: 'a', worktrees: [row('a', 'r1', 5), row('b', 'r2', 10)] })
  await Bun.sleep(20)

  expect(await fake.store.selectProject('r1')).toBeNull()
  expect(fake.navigated()).toEqual([])

  expect(await fake.store.selectProject('empty')).toBeNull()
  expect(fake.calls.filter((call) => call.method === 'quirky.worktree/setOptions').map((call) => call.params))
    .toEqual([{ filterRepoIds: ['r1'] }, { filterRepoIds: ['empty'] }])
  expect(fake.navigated()).toEqual([])
  expect(fake.store.getSnapshot().selectedWorktreeId).toBe('a')

  expect(await fake.store.selectProject(null)).toBeNull()
  expect(fake.store.getSnapshot().filterRepoIds).toEqual([])
  expect(fake.navigated()).toEqual([])
  fake.stop()
})
