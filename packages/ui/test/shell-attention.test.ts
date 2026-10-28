import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, symlinkSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import type { Ask, AskSpec, Repo, Worktree } from '@quirky/protocol'
import { makeTempDir } from '../../daemon/test/plugins/fixtures'
import { attentionStoreFor } from '../src/shell/attention'
import { bootWindow, closeWindows, installUiPlugin, provide, type WindowEnv } from './fixtures/window-env'

const CURRENT_VIEW = 'view:acme.attention/current'
const INBOX = 'host:inbox'

function writeAttentionPlugin(installed: string): void {
  mkdirSync(installed, { recursive: true })
  for (const id of ['quirky.repo', 'quirky.worktree', 'quirky.ask']) {
    symlinkSync(resolve(import.meta.dir, '../../../plugins', id), join(installed, id))
  }
  installUiPlugin(
    installed,
    'acme.attention',
    { view: [{ id: 'current', title: 'Current worktree' }] },
    provide(CURRENT_VIEW, `element.textContent = 'Current worktree ' + JSON.stringify(props.input ?? null)`)
  )
}

afterEach(closeWindows)

async function bootAttention() {
  const env = await bootWindow(writeAttentionPlugin)
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
  await env.win.waitFor(() => attention.getSnapshot().worktrees?.some((worktree) => worktree.id === current.id))
  return { env, attention, current, other, currentRepo, otherRepo }
}

async function createAsk(env: WindowEnv, spec: AskSpec, worktree: Worktree): Promise<string> {
  const result = await env.agent.callAny('quirky.ask/create', { spec, worktree: worktree.id }) as { askId?: unknown }
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

test('the chrome projection reads real project/worktree snapshots and derives selection from the current view input', async () => {
  const { env, attention, current, other, currentRepo, otherRepo } = await bootAttention()
  expect(attention.getSnapshot().selectedWorktreeId).toBe(current.id)
  expect(attention.getSnapshot().repos?.map((repo) => repo.id)).toEqual(expect.arrayContaining([currentRepo.id, otherRepo.id]))
  expect(attention.getSnapshot().worktrees?.map((worktree) => worktree.id)).toEqual(expect.arrayContaining([current.id, other.id]))

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
