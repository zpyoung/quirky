import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, symlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Ask, AskAnswer, Repo, Worktree } from '@quirky/protocol'
import { makeTempDir } from '../../../packages/daemon/test/plugins/fixtures'
import { bootWindow, closeWindows, installUiPlugin, provide, type WindowEnv } from '../../../packages/ui/test/fixtures/window-env'

const WORKTREES = 'sidebar-section:quirky.worktree/worktrees'
const CURRENT_VIEW = 'view:acme.attention/current'

function createBuiltinPlugins(): string {
  const directory = makeTempDir('worktree-attention-builtins-')
  mkdirSync(directory, { recursive: true })
  for (const id of ['quirky.repo', 'quirky.cli', 'quirky.worktree', 'quirky.ask']) {
    symlinkSync(resolve(import.meta.dir, '../../../', 'plugins', id), join(directory, id))
  }
  return directory
}

function installAttentionUiPlugin(installed: string): void {
  installUiPlugin(
    installed,
    'acme.attention',
    { view: [{ id: 'current', title: 'Current worktree' }] },
    provide(CURRENT_VIEW, `element.textContent = 'Current ' + JSON.stringify(props.input ?? null)`)
  )
}

afterEach(closeWindows)

async function bootTree() {
  const env = await bootWindow(installAttentionUiPlugin, { builtinPluginsDir: createBuiltinPlugins() })
  const currentPath = makeTempDir('worktree-attention-current-')
  const otherPath = makeTempDir('worktree-attention-other-')
  const [currentRepo, otherRepo] = await Promise.all([
    env.agent.callAny('quirky.repo/add', { path: currentPath, folder: true }) as Promise<Repo>,
    env.agent.callAny('quirky.repo/add', { path: otherPath, folder: true }) as Promise<Repo>
  ])
  const worktrees = await env.agent.callAny('quirky.worktree/list', {}) as Worktree[]
  const current = worktrees.find((worktree) => worktree.repoId === currentRepo.id)
  const other = worktrees.find((worktree) => worktree.repoId === otherRepo.id)
  if (!current || !other) throw new Error('The canonical worktree list omitted a newly added folder project.')

  await env.win.connection.callAny('ui.view.open', { id: CURRENT_VIEW, input: { worktree: current.id } })
  await env.win.connection.callAny('ui.tool.open', { id: WORKTREES })
  await env.win.waitFor(() => row(env, current.id) && row(env, other.id))
  return { env, current, other }
}

function row(env: WindowEnv, worktreeId: string): HTMLElement | null {
  return env.win.document.querySelector<HTMLElement>(`[data-worktree-id="${worktreeId}"]`)
}

function waitingMark(env: WindowEnv, worktreeId: string, count: number): HTMLElement | null {
  const label = `Waiting on you: ${count} pending ${count === 1 ? 'question' : 'questions'}`
  return [...(row(env, worktreeId)?.querySelectorAll<HTMLElement>('.ui-activity-mark--waiting') ?? [])]
    .find((element) => element.getAttribute('aria-label') === label) ?? null
}

function idleMark(env: WindowEnv, worktreeId: string): HTMLElement | null {
  return row(env, worktreeId)?.querySelector<HTMLElement>('.ui-activity-mark--idle[aria-label="Idle"]') ?? null
}

async function createAsk(env: WindowEnv, worktree: Worktree): Promise<string> {
  const result = await env.agent.callAny('quirky.ask/create', {
    worktree: worktree.id,
    spec: { title: 'Needs attention', questions: [{ id: 'approve', type: 'confirm', question: 'Approve?' }] }
  }) as { askId?: unknown }
  if (typeof result.askId !== 'string') throw new Error('The canonical Ask API did not return an ask ID.')
  return result.askId
}

async function pendingAsks(env: WindowEnv): Promise<Ask[]> {
  return await env.agent.callAny('quirky.ask/list', { pendingOnly: true }) as Ask[]
}

async function answerAsk(env: WindowEnv, askId: string): Promise<void> {
  await env.agent.callAny('quirky.ask/answer', {
    askId,
    answers: { approve: { value: true, source: 'input' } satisfies AskAnswer },
    skipped: []
  })
}

test('pending asks mark only their exact worktree as waiting and update as the real Ask authority resolves them', async () => {
  const { env, current, other } = await bootTree()
  const selectedView = env.win.host.getState().layout.view
  const currentAsk = await createAsk(env, current)
  const otherAsk1 = await createAsk(env, other)
  const otherAsk2 = await createAsk(env, other)

  await env.win.waitFor(() => waitingMark(env, current.id, 1))
  await env.win.waitFor(() => waitingMark(env, other.id, 2))
  expect(waitingMark(env, current.id, 1)?.getAttribute('role')).toBe('img')
  expect(row(env, other.id)?.querySelectorAll('.ui-activity-mark--waiting')).toHaveLength(1)
  expect(env.win.host.getState().layout.view).toEqual(selectedView)

  await answerAsk(env, otherAsk1)
  await env.win.waitFor(() => waitingMark(env, other.id, 1))
  const remaining = await pendingAsks(env)
  expect(remaining).toHaveLength(2)
  expect(remaining.map((ask) => ask.id)).toEqual(expect.arrayContaining([currentAsk, otherAsk2]))
  expect(waitingMark(env, current.id, 1)).not.toBeNull()
  expect(env.win.host.getState().layout.view).toEqual(selectedView)

  await answerAsk(env, otherAsk2)
  await env.win.waitFor(() => waitingMark(env, other.id, 1) === null && idleMark(env, other.id) !== null)
  expect((await pendingAsks(env)).map((ask) => ask.id)).toEqual([currentAsk])
  expect(waitingMark(env, current.id, 1)).not.toBeNull()
  expect(env.win.host.getState().layout.view).toEqual(selectedView)
})
