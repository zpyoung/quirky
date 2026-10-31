import { afterEach, describe, expect, test } from 'bun:test'
import { symlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PLUGIN_API_VERSION, QuirkyClient, type Ask, type Repo, type Session, type Worktree } from '@quirky/protocol'
import { rpcUrl } from '@quirky/protocol/node'
import { makeTempDir, writePlugin } from '../../daemon/test/plugins/fixtures'
import { languageName, relativeToWorktree } from '../src/shell/StatusBar'
import { attentionStoreFor } from '../src/shell/attention'
import { bootWindow, closeWindows, installUiPlugin, provide, type WindowEnv } from './fixtures/window-env'

afterEach(closeWindows)

const FOOTER = 'footer[data-region="status-bar"]'

const SESSION_MAIN = `
let sessions = []
let failing = false
export function activate(context) {
  context.provide('method:quirky.session/list', () => {
    if (failing) throw new Error('sessions are offline')
    return sessions
  })
  context.provide('method:quirky.session/seed', (params) => {
    sessions = params.sessions
    failing = params.failing === true
    context.emit('changed', { session: sessions[0] ?? null })
    return { ok: true }
  })
}
export function deactivate() {}
`

const TERMINAL_MAIN = `
const icons = {}
export function activate(context) {
  context.provide('method:quirky.terminal/activeTabIcon', (params) => ({ icon: icons[String(params.workspace).replace(/^id:/, '')] ?? null }))
  context.provide('method:quirky.terminal/setIcon', (params) => {
    icons[params.workspace] = params.icon
    context.emit('layout', { workspace: params.workspace, revision: Date.now() })
    return { ok: true }
  })
}
export function deactivate() {}
`

const anyParams = { type: 'object', additionalProperties: true }

function builtinPlugins(): string {
  const builtins = makeTempDir('ui-status-bar-builtins-')
  for (const id of ['quirky.repo', 'quirky.worktree', 'quirky.cli', 'quirky.sidebar-extras', 'quirky.ask']) {
    symlinkSync(resolve(import.meta.dir, '../../../plugins', id), join(builtins, id))
  }
  writePlugin(
    builtins,
    {
      id: 'quirky.session',
      name: 'quirky.session',
      version: '1.0.0',
      apiVersion: PLUGIN_API_VERSION,
      main: 'main.ts',
      ui: 'ui.js',
      contributes: {
        view: [{ id: 'worktree', title: 'Session worktree' }],
        method: [{ id: 'list', readOnly: true, params: anyParams }, { id: 'seed', params: anyParams }],
        event: [{ id: 'changed', data: anyParams }]
      }
    },
    {
      'main.ts': SESSION_MAIN,
      'ui.js': `export function activate(context) { context.provide('view:quirky.session/worktree', (element) => { element.textContent = 'session' }) }\nexport function deactivate() {}\n`
    }
  )
  writePlugin(
    builtins,
    {
      id: 'quirky.terminal',
      name: 'quirky.terminal',
      version: '1.0.0',
      apiVersion: PLUGIN_API_VERSION,
      main: 'main.ts',
      contributes: {
        method: [{ id: 'activeTabIcon', readOnly: true, params: anyParams }, { id: 'setIcon', params: anyParams }],
        event: [{ id: 'layout', data: anyParams }]
      }
    },
    { 'main.ts': TERMINAL_MAIN }
  )
  return builtins
}

function writeItems(installed: string): void {
  installUiPlugin(
    installed,
    'acme.items',
    { 'status-bar': [{ id: 'twenty', title: 'Twenty', order: 20 }, { id: 'ten', title: 'Ten', order: 10 }] },
    [
      provide('status-bar:acme.items/ten', `element.textContent = 'ten'`),
      provide('status-bar:acme.items/twenty', `element.textContent = 'twenty'`)
    ].join('\n')
  )
}

async function boot() {
  const env = await bootWindow(writeItems, { builtinPluginsDir: builtinPlugins() })
  const repos = await Promise.all(['alpha', 'beta'].map((name) =>
    env.agent.callAny('quirky.repo/add', { path: makeTempDir(`ui-status-bar-${name}-`), folder: true }) as Promise<Repo>
  ))
  const attention = attentionStoreFor(env.win.connection, env.win.host)
  await env.win.waitFor(() => (attention.getSnapshot().worktrees?.length ?? 0) >= 2)
  const worktrees = attention.getSnapshot().worktrees!
  const [first, second] = repos.map((repo) => worktrees.find((worktree) => worktree.repoId === repo.id)!) as [Worktree, Worktree]
  await env.agent.callAny('quirky.worktree/navigate', { worktree: first.id })
  await env.win.waitFor(() => attention.getSnapshot().selectedWorktreeId === first.id)
  return { env, attention, repos: repos as [Repo, Repo], first, second }
}

const footer = (env: WindowEnv) => env.win.document.querySelector<HTMLElement>(FOOTER)!
const values = (env: WindowEnv) => [...footer(env).querySelectorAll<HTMLElement>('.shell-statusbar__values > *')]
const texts = (env: WindowEnv) => values(env).map((element) => (element.textContent ?? '').replace(/\s+/g, ' ').trim())
const crumbs = (env: WindowEnv) => [...footer(env).querySelectorAll('.shell-statusbar__crumb-text')].map((crumb) => crumb.textContent?.trim())
const popups = (env: WindowEnv) => [...env.win.document.querySelectorAll<HTMLElement>('.ui-popup')]
const popupRows = (env: WindowEnv) => [...env.win.document.querySelectorAll<HTMLElement>('.ui-popup [role="menuitem"]')]
const itemLabelled = (env: WindowEnv, label: string) =>
  [...footer(env).querySelectorAll<HTMLButtonElement>('button.ui-status-bar-item')].find((button) => button.getAttribute('aria-label') === label)

async function click(element: HTMLElement | undefined): Promise<void> {
  expect(element).toBeDefined()
  element!.click()
  await Bun.sleep(0)
}

async function seedSessions(env: WindowEnv, worktrees: Worktree[], failing = false): Promise<void> {
  const sessions = worktrees.map((worktree, index) => ({
    id: `s_${index}`,
    kind: 'terminal',
    agent: 'claude',
    worktreeId: worktree.id,
    cwd: worktree.path,
    title: 'Claude',
    status: 'working',
    createdAt: index + 1,
    lastActivityAt: index + 1,
    exitCode: null,
    exitSignal: null,
    exitCause: null,
    restorable: false,
    agentStatus: { display: 'working', label: 'Running tests', state: 'working', progress: null, evidenceAt: Date.now(), restoredUnconfirmed: false }
  }))
  await env.agent.callAny('quirky.session/seed', { sessions, failing })
}
function waitingSession(worktree: Worktree, options: {
  id?: string
  title?: string
  evidenceAt?: number
  restoredUnconfirmed?: boolean
} = {}): Session {
  const now = Date.now()
  return {
    id: options.id ?? `waiting_${worktree.id}`,
    kind: 'terminal',
    agent: 'claude',
    worktreeId: worktree.id,
    cwd: worktree.path,
    title: options.title ?? 'Claude',
    status: 'waiting',
    createdAt: now,
    lastActivityAt: now,
    exitCode: null,
    exitSignal: null,
    exitCause: null,
    restorable: false,
    agentStatus: {
      state: 'waiting',
      display: 'permission',
      label: 'Permission needed',
      detail: 'Waiting for permission',
      progress: null,
      stateStartedAt: now,
      evidenceAt: options.evidenceAt ?? now,
      restoredUnconfirmed: options.restoredUnconfirmed ?? false
    }
  }
}

async function seedWaitingSessions(env: WindowEnv, worktrees: Worktree[]): Promise<Session[]> {
  const sessions = worktrees.map((worktree) => waitingSession(worktree))
  await env.agent.callAny('quirky.session/seed', { sessions })
  return sessions
}

function pendingAsk(id: string, title: string, sessionId: string | null, worktreeId: string): Ask {
  return {
    id,
    spec: { title, questions: [{ id: 'q', type: 'confirm', question: 'Proceed?' }] },
    sessionId,
    worktreeId,
    createdAt: Date.now(),
    envelope: { status: 'pending', askId: id, answers: {}, skipped: [], summary: '' },
    seq: 1,
    queued: false,
    partial: {},
    expiresAt: null
  }
}


async function askIn(env: WindowEnv, worktree: Worktree, title: string): Promise<void> {
  const caller = await QuirkyClient.connect(rpcUrl(env.harness.runtime), { role: 'cli', name: 'status-bar-test', worktreeId: worktree.id })
  env.harness.clients.push(caller)
  await caller.callAny('quirky.ask/register', {
    spec: { title, questions: [{ id: 'q', type: 'confirm', question: 'Proceed?' }] },
    requestId: crypto.randomUUID()
  })
}
async function seedPendingAsks(env: WindowEnv, asks: Ask[]): Promise<void> {
  const connection = env.win.connection
  const callAny = connection.callAny.bind(connection)
  connection.callAny = (method, params) =>
    method === 'quirky.ask/list' ? Promise.resolve(asks) : callAny(method, params)
  const expectedIds = new Set(asks.map((ask) => ask.id))
  const attention = attentionStoreFor(connection, env.win.host)
  attention.refresh()
  await env.win.waitFor(() => {
    const current = attention.getSnapshot().asks
    return current !== null && current.length === asks.length && current.every((ask) => expectedIds.has(ask.id))
  })
}


const setIcon = (env: WindowEnv, worktree: Worktree, icon: unknown) =>
  env.agent.callAny('quirky.terminal/setIcon', { workspace: worktree.id, icon })

describe('status bar helpers', () => {
  test('a language name comes from the extension, then the uppercase extension, then plain text', () => {
    expect(languageName('/w/src/App.tsx')).toBe('TypeScript')
    expect(languageName('notes.MD')).toBe('Markdown')
    expect(languageName('/w/data.parquet')).toBe('PARQUET')
    expect(languageName('/w/Makefile')).toBe('Plain text')
    expect(languageName('/w/.gitignore')).toBe('Plain text')
  })

  test('a file inside the worktree is shown relative to it and any other file keeps its path', () => {
    expect(relativeToWorktree('/w/repo', '/w/repo/src/App.tsx')).toBe('src/App.tsx')
    expect(relativeToWorktree('/w/repo/', '/w/repo/a.ts')).toBe('a.ts')
    expect(relativeToWorktree('/w/repo', '/w/repository/a.ts')).toBe('/w/repository/a.ts')
    expect(relativeToWorktree('/w/repo', 'a/b.ts')).toBe('a/b.ts')
  })
})

describe('status bar', () => {
  test('the footer keeps its region and lists the right side in order, plugin items between needs-you and file type', async () => {
    const { env, first, second } = await boot()
    await seedSessions(env, [first, second])
    await askIn(env, second, 'Approve the merge?')
    await setIcon(env, first, { kind: 'file', path: join(first.path, 'src/App.tsx') })

    await env.win.waitFor(() => texts(env).length === 5 && texts(env).every(Boolean))
    expect(footer(env).getAttribute('data-region')).toBe('status-bar')
    expect(footer(env).tagName).toBe('FOOTER')
    expect(texts(env)).toEqual(['2 working', '1 needs you', 'ten', 'twenty', 'TypeScript'])
  })

  test('accessible counts use singular nouns for one working agent and one pending question', async () => {
    const { env, first } = await boot()
    await seedSessions(env, [first])
    await askIn(env, first, 'Approve the change?')
    await env.win.waitFor(() => texts(env).includes('1 working') && texts(env).includes('1 needs you'))

    const labels = values(env).map((element) => element.getAttribute('aria-label'))
    expect(labels).toContainEqual(expect.stringMatching(/\b1 agent\b/))
    expect(labels).toContainEqual(expect.stringMatching(/\b1 pending question\b/))
  })

  test('the breadcrumb leads with the project tile, then project, worktree and file, and names the project under All projects', async () => {
    const { env, attention, repos, first } = await boot()
    expect(attention.getSnapshot().filterRepoIds).toEqual([])
    const project = repos[0].displayName ?? repos[0].name
    await env.win.waitFor(() => crumbs(env).length === 2)
    expect(crumbs(env)).toEqual([project, first.name])
    expect(footer(env).querySelector('.shell-statusbar__crumb:first-child .ui-project-tile')).not.toBeNull()

    await setIcon(env, first, { kind: 'file', path: join(first.path, 'src/App.tsx') })
    await env.win.waitFor(() => crumbs(env).length === 3)
    expect(crumbs(env)).toEqual([project, first.name, 'src/App.tsx'])
    expect(footer(env).querySelector('.shell-statusbar__crumb[aria-current="location"]')?.textContent).toBe('src/App.tsx')
  })

  test('a tab that is not a file stops the breadcrumb at the worktree and hides the file type', async () => {
    const { env, first } = await boot()
    await setIcon(env, first, { kind: 'file', path: join(first.path, 'a.ts') })
    await env.win.waitFor(() => texts(env).includes('TypeScript'))

    await setIcon(env, first, { kind: 'tool', name: 'git-branch', hue: 'blue' })
    await env.win.waitFor(() => !texts(env).includes('TypeScript'))
    expect(crumbs(env)).toHaveLength(2)
    expect(footer(env).querySelector('[title="File type"]')).toBeNull()

    await setIcon(env, first, null)
    await Bun.sleep(50)
    expect(crumbs(env)).toHaveLength(2)
  })

  test('the file type opens no popup', async () => {
    const { env, first } = await boot()
    await setIcon(env, first, { kind: 'file', path: join(first.path, 'App.tsx') })
    const fileType = await env.win.waitFor(() => footer(env).querySelector<HTMLElement>('[title="File type"]'))
    expect(fileType.tagName).not.toBe('BUTTON')
    expect(fileType.getAttribute('aria-haspopup')).toBeNull()
    await click(fileType)
    expect(popups(env)).toHaveLength(0)
  })

  test('the working count opens a titled list of working sessions that ends with a link to the Worktrees panel', async () => {
    const { env, first, second } = await boot()
    await seedSessions(env, [first, second])
    const item = await env.win.waitFor(() => itemLabelled(env, '2 agents working'))
    expect(item.getAttribute('aria-haspopup')).toBe('menu')
    const opened: string[] = []
    const openTool = env.win.host.openTool.bind(env.win.host)
    env.win.host.openTool = (id: string) => { opened.push(id); openTool(id) }

    await click(item)
    await env.win.waitFor(() => popups(env).length === 1)
    expect(popups(env)[0]!.querySelector('.ui-popup__title')?.textContent).toBe('Working')
    const rows = popupRows(env).map((row) => row.textContent ?? '')
    expect(rows).toHaveLength(3)
    expect(rows[0]).toContain(first.name)
    expect(rows[0]).toContain('Claude · Running tests')
    expect(rows.at(-1)).toBe('Open the Worktrees panel')

    await click(popupRows(env).at(-1))
    expect(opened).toEqual(['sidebar-section:quirky.worktree/worktrees'])
    expect(popups(env)).toHaveLength(0)
  })

  test('the needs-you count ignores the project narrowing, and its popup ends with a link to the Inbox', async () => {
    const { env, attention, repos, first, second } = await boot()
    await askIn(env, first, 'First question')
    await askIn(env, second, 'Second question')
    await env.win.waitFor(() => itemLabelled(env, '2 pending questions'))

    await attention.selectProject(repos[0].id)
    await env.win.waitFor(() => attention.getSnapshot().filterRepoIds.length === 1)
    expect(texts(env)).toContain('2 needs you')

    const opened: string[] = []
    const openTool = env.win.host.openTool.bind(env.win.host)
    env.win.host.openTool = (id: string) => { opened.push(id); openTool(id) }
    await click(itemLabelled(env, '2 pending questions'))
    await env.win.waitFor(() => popups(env).length === 1)
    expect(popups(env)[0]!.querySelector('.ui-popup__title')?.textContent).toBe('Needs you')
    const rows = popupRows(env).map((row) => row.textContent ?? '')
    expect(rows.some((row) => row.includes('First question'))).toBe(true)
    expect(rows.some((row) => row.includes('Second question'))).toBe(true)
    expect(rows.at(-1)).toBe('Open the Inbox')

    await click(popupRows(env).at(-1))
    expect(opened).toEqual(['host:inbox'])
  })
  test('a waiting Claude session contributes to needs-you and opens its worktree', async () => {
    const { env, attention, second } = await boot()
    const [session] = await seedWaitingSessions(env, [second])
    await env.win.waitFor(() => {
      const snapshot = attention.getSnapshot()
      return snapshot.sessions?.some((candidate) => candidate.id === session!.id) &&
        snapshot.asks !== null && !snapshot.errors.sessions && !snapshot.errors.asks
    })
    const item = await env.win.waitFor(() =>
      values(env).find((value) => value.matches('button.ui-status-bar-item') && value.textContent?.includes('needs you'))
    )
    expect((item?.textContent ?? '').replace(/\s+/g, ' ').trim()).toBe('1 needs you')
    await click(item)
    await env.win.waitFor(() => popups(env).length === 1)
    expect(popups(env)[0]!.querySelector('.ui-popup__title')?.textContent).toBe('Needs you')
    const sessionRow = popupRows(env).find((row) => row.textContent?.includes('Claude'))
    expect(sessionRow?.textContent).toContain('Permission needed')
    expect(sessionRow?.textContent).toContain(second.name)

    await click(sessionRow)
    await env.win.waitFor(() => attention.getSnapshot().selectedWorktreeId === second.id)
  })
  test('needs-you ignores expired summaries but honors fresh and restored waiting summaries', async () => {
    const { env, attention, first, second } = await boot()
    const now = Date.now()
    const expiredAt = now - 31 * 60_000
    const sessions = [
      waitingSession(first, { id: 'expired_waiting', title: 'Expired Claude', evidenceAt: expiredAt }),
      waitingSession(second, { id: 'fresh_waiting', title: 'Fresh Claude', evidenceAt: now }),
      waitingSession(first, { id: 'restored_waiting', title: 'Restored Claude', evidenceAt: expiredAt, restoredUnconfirmed: true })
    ]
    await env.agent.callAny('quirky.session/seed', { sessions })
    await env.win.waitFor(() => {
      const snapshot = attention.getSnapshot()
      return snapshot.sessions?.some((session) => session.id === 'restored_waiting') &&
        snapshot.asks !== null && !snapshot.errors.sessions && !snapshot.errors.asks
    })

    const item = await env.win.waitFor(() =>
      values(env).find((value) => value.matches('button.ui-status-bar-item') && value.textContent?.includes('needs you'))
    )
    expect((item?.textContent ?? '').replace(/\s+/g, ' ').trim()).toBe('2 needs you')
    await click(item)
    await env.win.waitFor(() => popups(env).length === 1)
    const rows = popupRows(env).map((row) => row.textContent ?? '')
    expect(rows.some((row) => row.includes('Fresh Claude'))).toBe(true)
    expect(rows.some((row) => row.includes('Restored Claude'))).toBe(true)
    expect(rows.some((row) => row.includes('Expired Claude'))).toBe(false)
  })


  test('a same-session ask and a same-worktree unrelated ask do not duplicate session attention', async () => {
    const { env, first, second } = await boot()
    const [session] = await seedWaitingSessions(env, [first, second])
    await seedPendingAsks(env, [
      pendingAsk('ask_matching', 'Matching question', session!.id, first.id),
      pendingAsk('ask_unrelated', 'Unrelated question', null, first.id)
    ])
    const attention = attentionStoreFor(env.win.connection, env.win.host)
    await env.win.waitFor(() => attention.getSnapshot().sessions?.some((candidate) => candidate.id === session!.id))

    const item = await env.win.waitFor(() =>
      values(env).find((value) => value.matches('button.ui-status-bar-item') && value.textContent?.includes('needs you'))
    )
    expect((item?.textContent ?? '').replace(/\s+/g, ' ').trim()).toBe('3 needs you')
    await click(item)
    await env.win.waitFor(() => popups(env).length === 1)
    const rows = popupRows(env)
    expect(rows).toHaveLength(4)
    expect(rows.some((row) => row.textContent?.includes('Matching question'))).toBe(true)
    expect(rows.some((row) => row.textContent?.includes('Unrelated question'))).toBe(true)
    const sessionRows = rows.filter((row) => row.textContent?.includes('Permission needed'))
    expect(sessionRows).toHaveLength(1)
    expect(sessionRows[0]?.textContent).toContain(second.name)

    const opened: string[] = []
    const openTool = env.win.host.openTool.bind(env.win.host)
    env.win.host.openTool = (id: string) => { opened.push(id); openTool(id) }
    await click(rows.find((row) => row.textContent?.includes('Matching question')))
    expect(opened).toEqual(['host:inbox'])
  })


  test('only one popup is open at a time and Escape closes it and returns focus to its item', async () => {
    const { env, first, second } = await boot()
    await seedSessions(env, [first, second])
    await askIn(env, first, 'Question')
    const working = await env.win.waitFor(() => itemLabelled(env, '2 agents working'))
    const needsYou = await env.win.waitFor(() => itemLabelled(env, '1 pending question'))

    await click(working)
    await env.win.waitFor(() => popups(env).length === 1)
    await click(needsYou)
    await env.win.waitFor(() => popups(env).length === 1 && popups(env)[0]!.querySelector('.ui-popup__title')?.textContent === 'Needs you')
    expect(working.getAttribute('aria-expanded')).toBe('false')
    expect(needsYou.getAttribute('aria-expanded')).toBe('true')

    env.win.document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await env.win.waitFor(() => popups(env).length === 0)
    expect(env.win.document.activeElement).toBe(needsYou)
  })

  test('the needs-you count stays unavailable when inbox data is unavailable', async () => {
    const { env, second } = await boot()
    await seedWaitingSessions(env, [second])
    const attention = attentionStoreFor(env.win.connection, env.win.host)
    await env.win.waitFor(() => attention.getSnapshot().asks !== null && !attention.getSnapshot().errors.asks)
    const callAny = env.win.connection.callAny.bind(env.win.connection)
    env.win.connection.callAny = (method, params) =>
      method === 'quirky.ask/list' ? Promise.reject(new Error('asks are offline')) : callAny(method, params)
    attention.refresh()

    await env.win.waitFor(() => texts(env).includes('Inbox status unavailable'))
    expect(values(env).filter((value) => value.textContent?.includes('needs you'))).toHaveLength(0)
  })

  test('a count is hidden while its data is unavailable and the error text stays', async () => {
    const { env, first, second } = await boot()
    await seedSessions(env, [first, second], true)
    await env.win.waitFor(() => texts(env).includes('Agent status unavailable'))
    expect(itemLabelled(env, '2 agents working')).toBeUndefined()
    expect(values(env).filter((value) => value.textContent?.includes('needs you'))).toHaveLength(0)
  })
})
