import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { RpcErrorCode, type QuirkyClient, type QuirkyEvent } from '@quirky/protocol'
import { builtinsDir, makeHomeWithoutAutoHooks, startHarness, waitFor, type Harness } from '../../../packages/daemon/test/helpers'
import { registerIsolatedEditorFixtures } from './isolated-environment'

type Worktree = { id: string; path: string }
type Interaction = { selectedPaths: string[]; focusedPath: string | null; selectionAnchor: string | null }
type ExplorerEntry = { path: string; name: string; isDirectory: boolean }
type ExplorerResult = {
  root: string
  entries: ExplorerEntry[]
  expanded?: string[]
  interaction?: Interaction
}
type EditorState = {
  explorer: { worktreeId: string; expanded: string[]; selectedPaths?: string[]; focusedPath?: string | null; selectionAnchor?: string | null }
}
type Fixture = { harness: Harness; client: QuirkyClient; home: string; root: string; repoId: string; worktree: Worktree; roots: Set<string>; events: QuirkyEvent[] }

const fixtures = new Set<Fixture>()
registerIsolatedEditorFixtures(async () => {
  for (const fixture of fixtures) {
    fixtures.delete(fixture)
    try {
      await fixture.harness.cleanup()
    } finally {
      for (const root of fixture.roots) rmSync(root, { recursive: true, force: true })
    }
  }
})

function git(root: string, home: string, args: string[]): void {
  execFileSync('git', args, {
    cwd: root,
    env: { ...process.env, HOME: home, QUIRKY_HOME: home }
  })
}

async function registerWorktree(client: QuirkyClient, root: string): Promise<{ repoId: string; worktree: Worktree }> {
  const repo = await call<{ id: string }>(client, 'quirky.repo/add', { path: root })
  const worktrees = await call<Worktree[]>(client, 'quirky.worktree/list', { repo: repo.id })
  const worktree = worktrees.find((entry) => entry.path === root) ?? worktrees[0]
  if (!worktree) throw new Error('repo add returned no worktree')
  return { repoId: repo.id, worktree }
}

async function fixture(files: Record<string, string>): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'quirky-editor-explorer-'))
  const home = makeHomeWithoutAutoHooks('q-editor-explorer-')
  let harness: Harness | undefined
  const roots = new Set([root])
  try {
    for (const [path, text] of Object.entries(files)) {
      const absolute = join(root, path)
      mkdirSync(dirname(absolute), { recursive: true })
      writeFileSync(absolute, text)
    }
    git(root, home, ['init', '-q', '-b', 'main'])
    if (Object.keys(files).length > 0) {
      git(root, home, ['-c', 'user.email=editor@test', '-c', 'user.name=Editor Test', 'add', '.'])
      git(root, home, ['-c', 'user.email=editor@test', '-c', 'user.name=Editor Test', 'commit', '-q', '-m', 'initial'])
    }
    harness = await startHarness({ home, builtinPluginsDir: builtinsDir() })
    const client = await harness.connect('cli')
    const { repoId, worktree } = await registerWorktree(client, root)
    const subscribed = await harness.connectWithEvents('ui')
    const value = { harness, client, home, root, repoId, worktree, roots, events: subscribed.events }
    fixtures.add(value)
    return value
  } catch (error) {
    try {
      await harness?.cleanup()
    } finally {
      for (const path of roots) rmSync(path, { recursive: true, force: true })
    }
    throw error
  }
}

const call = <T>(client: QuirkyClient, method: string, params: Record<string, unknown> = {}) => client.callAny(method, params) as Promise<T>
const explorer = (world: Fixture, worktree: string, params: Record<string, unknown>) =>
  call<ExplorerResult>(world.client, 'quirky.editor/explorer', { worktree, ...params })
const stateOf = (world: Fixture, worktree: string) => call<EditorState>(world.client, 'quirky.editor/state', { worktree })

function interaction(result: ExplorerResult): Interaction {
  if (result.interaction === undefined) throw new Error('Explorer interaction response was missing authoritative interaction state')
  return result.interaction
}

test('Explorer navigation clamps, pages, contracts anchored ranges and toggles membership independently of focus', async () => {
  const files: Record<string, string> = {
    'A/a1.txt': 'a1\n',
    'A/a2.txt': 'a2\n',
    'B/b1.txt': 'b1\n'
  }
  for (let index = 1; index <= 23; index++) files[`file${index}.txt`] = `${index}\n`
  const world = await fixture(files)
  const worktree = world.worktree.id
  const path = (name: string) => join(world.root, name)
  const rows = [path('A'), path('B'), ...Array.from({ length: 23 }, (_, index) => path(`file${index + 1}.txt`))]

  const selected = await explorer(world, worktree, { action: 'select', path: path('file10.txt') })
  expect(interaction(selected)).toEqual({ selectedPaths: [path('file10.txt')], focusedPath: path('file10.txt'), selectionAnchor: path('file10.txt') })

  const home = await explorer(world, worktree, { action: 'navigate', key: 'Home' })
  expect(interaction(home)).toEqual({ selectedPaths: [rows[0]!], focusedPath: rows[0], selectionAnchor: rows[0] })
  const clampedHome = await explorer(world, worktree, { action: 'navigate', key: 'Home' })
  expect(interaction(clampedHome)).toEqual({ selectedPaths: [rows[0]!], focusedPath: rows[0], selectionAnchor: rows[0] })
  const end = await explorer(world, worktree, { action: 'navigate', key: 'End' })
  expect(interaction(end)).toEqual({ selectedPaths: [rows[24]!], focusedPath: rows[24], selectionAnchor: rows[24] })
  const clampedEnd = await explorer(world, worktree, { action: 'navigate', key: 'End' })
  expect(interaction(clampedEnd)).toEqual({ selectedPaths: [rows[24]!], focusedPath: rows[24], selectionAnchor: rows[24] })
  const pageUp = await explorer(world, worktree, { action: 'navigate', key: 'PageUp' })
  expect(interaction(pageUp)).toEqual({ selectedPaths: [rows[22]!], focusedPath: rows[22], selectionAnchor: rows[22] })
  const pageDown = await explorer(world, worktree, { action: 'navigate', key: 'PageDown' })
  expect(interaction(pageDown)).toEqual({ selectedPaths: [rows[24]!], focusedPath: rows[24], selectionAnchor: rows[24] })
  const pageUpAgain = await explorer(world, worktree, { action: 'navigate', key: 'PageUp' })
  expect(interaction(pageUpAgain)).toEqual({ selectedPaths: [rows[22]!], focusedPath: rows[22], selectionAnchor: rows[22] })

  const extendedHome = await explorer(world, worktree, { action: 'navigate', key: 'Home', extend: true })
  expect(interaction(extendedHome)).toEqual({
    selectedPaths: rows.slice(0, 23),
    focusedPath: rows[0]!,
    selectionAnchor: rows[22]!
  })
  const contracted = await explorer(world, worktree, { action: 'navigate', key: 'ArrowDown', extend: true })
  expect(interaction(contracted)).toEqual({
    selectedPaths: rows.slice(1, 23),
    focusedPath: rows[1]!,
    selectionAnchor: rows[22]!
  })

  const toggledOff = await explorer(world, worktree, { action: 'select', path: path('file5.txt'), toggle: true })
  expect(interaction(toggledOff)).toEqual({
    selectedPaths: rows.slice(1, 23).filter((entry) => entry !== path('file5.txt')),
    focusedPath: path('file5.txt'),
    selectionAnchor: rows[22]!
  })
  const toggledOn = await explorer(world, worktree, { action: 'select', path: path('file23.txt'), toggle: true })
  expect(interaction(toggledOn)).toEqual({
    selectedPaths: [...rows.slice(1, 23).filter((entry) => entry !== path('file5.txt')), path('file23.txt')],
    focusedPath: path('file23.txt'),
    selectionAnchor: rows[22]!
  })
  const extendedClick = await explorer(world, worktree, { action: 'select', path: path('file5.txt'), extend: true })
  expect(interaction(extendedClick)).toEqual({
    selectedPaths: rows.slice(6, 23),
    focusedPath: path('file5.txt'),
    selectionAnchor: rows[22]!
  })


  world.events.length = 0
  const plain = await explorer(world, worktree, { action: 'select', path: path('file10.txt') })
  expect(interaction(plain)).toEqual({ selectedPaths: [path('file10.txt')], focusedPath: path('file10.txt'), selectionAnchor: path('file10.txt') })
  const extended = await explorer(world, worktree, { action: 'navigate', key: 'ArrowDown', extend: true })
  expect(interaction(extended)).toEqual({ selectedPaths: [path('file10.txt'), path('file11.txt')], focusedPath: path('file11.txt'), selectionAnchor: path('file10.txt') })
  expect((await stateOf(world, worktree)).explorer).toMatchObject({
    selectedPaths: [path('file10.txt'), path('file11.txt')],
    focusedPath: path('file11.txt'),
    selectionAnchor: path('file10.txt')
  })
  await waitFor(() => world.events.some((event) => event.type === 'quirky.editor/changed') || undefined)
})

test('Explorer hierarchy navigation expands and collapses canonical relative paths and preserves state snapshots', async () => {
  const world = await fixture({ 'A/first.txt': 'first\n', 'A/second.txt': 'second\n', 'B/other.txt': 'other\n' })
  const worktree = world.worktree.id
  const directory = join(world.root, 'A')
  const child = join(directory, 'first.txt')

  const first = await explorer(world, worktree, { action: 'select', path: directory })
  expect(interaction(first).focusedPath).toBe(directory)
  const expanded = await explorer(world, worktree, { action: 'navigate', key: 'ArrowRight' })
  expect(expanded.expanded).toEqual(['A'])
  expect(interaction(expanded)).toEqual({ selectedPaths: [directory], focusedPath: directory, selectionAnchor: directory })
  expect((await stateOf(world, worktree)).explorer).toMatchObject({ worktreeId: worktree, expanded: ['A'], selectedPaths: [directory], focusedPath: directory, selectionAnchor: directory })

  const entered = await explorer(world, worktree, { action: 'navigate', key: 'ArrowRight' })
  expect(interaction(entered)).toEqual({ selectedPaths: [child], focusedPath: child, selectionAnchor: child })
  const parent = await explorer(world, worktree, { action: 'navigate', key: 'ArrowLeft' })
  expect(interaction(parent)).toEqual({ selectedPaths: [directory], focusedPath: directory, selectionAnchor: directory })
  const collapsed = await explorer(world, worktree, { action: 'navigate', key: 'ArrowLeft' })
  expect(collapsed.expanded).toEqual([])
  expect(interaction(collapsed)).toEqual({ selectedPaths: [directory], focusedPath: directory, selectionAnchor: directory })
  expect((await stateOf(world, worktree)).explorer.expanded).toEqual([])
})

test('Explorer rejects unauthorized or hidden paths and uses only filtered visible targets', async () => {
  const world = await fixture({ '.secret.txt': 'hidden\n', 'needle.txt': 'match\n', 'nested/needle-child.txt': 'match\n', 'ordinary.txt': 'other\n' })
  const worktree = world.worktree.id
  const matching = await explorer(world, worktree, { action: 'filter', query: 'needle' })
  const matchingPaths = matching.entries.map((entry) => entry.path)
  expect(matchingPaths).toContain(join(world.root, 'needle.txt'))
  expect(matchingPaths).toContain(join(world.root, 'nested', 'needle-child.txt'))

  for (const target of matchingPaths) {
    const result = await explorer(world, worktree, { action: 'select', path: target, query: 'needle' })
    expect(interaction(result).selectedPaths).toEqual([target])
  }
  const filteredTarget = join(world.root, 'nested', 'needle-child.txt')
  const filteredSelection = await explorer(world, worktree, { action: 'select', path: filteredTarget, query: 'needle' })
  const filteredRight = await explorer(world, worktree, { action: 'navigate', key: 'ArrowRight', query: 'needle' })
  expect(interaction(filteredRight)).toEqual(interaction(filteredSelection))
  expect(filteredRight.expanded).toEqual([])
  await expect(explorer(world, worktree, { action: 'select', path: join(world.root, 'ordinary.txt'), query: 'needle' }))
    .rejects.toMatchObject({ code: RpcErrorCode.InvalidParams })
  await expect(explorer(world, worktree, { action: 'select', path: join(world.root, '..', 'outside.txt') }))
    .rejects.toMatchObject({ code: RpcErrorCode.InvalidParams })

  await explorer(world, worktree, { action: 'preferences', showDotfiles: false })
  await expect(explorer(world, worktree, { action: 'select', path: join(world.root, '.secret.txt') }))
    .rejects.toMatchObject({ code: RpcErrorCode.InvalidParams })
  const hiddenFilter = await explorer(world, worktree, { action: 'filter', query: 'secret' })
  expect(hiddenFilter.entries).toEqual([])
  await expect(explorer(world, worktree, { action: 'select', path: join(world.root, '.secret.txt'), query: 'secret' }))
    .rejects.toMatchObject({ code: RpcErrorCode.InvalidParams })
})

test('Explorer safely resets stale anchors after collapse, filter and refresh', async () => {
  const world = await fixture({ 'A/inside.txt': 'inside\n', 'needle.txt': 'match\n', 'ordinary.txt': 'other\n', 'z-gone.txt': 'stale\n' })
  const worktree = world.worktree.id
  const path = (name: string) => join(world.root, name)

  await explorer(world, worktree, { action: 'select', path: path('A') })
  await explorer(world, worktree, { action: 'navigate', key: 'ArrowRight' })
  const inside = await explorer(world, worktree, { action: 'select', path: path('A/inside.txt') })
  expect(interaction(inside).selectionAnchor).toBe(path('A/inside.txt'))
  await explorer(world, worktree, { action: 'navigate', key: 'ArrowLeft', extend: true })
  const collapseWithStaleAnchor = await explorer(world, worktree, { action: 'navigate', key: 'ArrowLeft', extend: true })
  expect(collapseWithStaleAnchor.expanded).toEqual([])
  const afterCollapse = await explorer(world, worktree, { action: 'navigate', key: 'ArrowDown', extend: true })
  expect(interaction(afterCollapse)).toEqual({ selectedPaths: [path('needle.txt')], focusedPath: path('needle.txt'), selectionAnchor: path('needle.txt') })

  await explorer(world, worktree, { action: 'select', path: path('ordinary.txt') })
  const afterFilter = await explorer(world, worktree, { action: 'navigate', key: 'ArrowDown', extend: true, query: 'needle' })
  expect(interaction(afterFilter)).toEqual({ selectedPaths: [path('needle.txt')], focusedPath: path('needle.txt'), selectionAnchor: path('needle.txt') })

  await explorer(world, worktree, { action: 'select', path: path('z-gone.txt') })
  unlinkSync(path('z-gone.txt'))
  await explorer(world, worktree, { action: 'refresh' })
  const afterRefresh = await explorer(world, worktree, { action: 'navigate', key: 'ArrowDown', extend: true })
  expect(interaction(afterRefresh).selectedPaths).not.toContain(path('z-gone.txt'))
  expect(interaction(afterRefresh).focusedPath).not.toBe(path('z-gone.txt'))
  expect(interaction(afterRefresh).selectionAnchor).not.toBe(path('z-gone.txt'))
})

test('Explorer keeps empty trees empty', async () => {
  const empty = await fixture({})
  const initial = await explorer(empty, empty.worktree.id, { action: 'list' })
  expect(initial.entries).toEqual([])
  const emptyNavigation = await explorer(empty, empty.worktree.id, { action: 'navigate', key: 'Home' })
  expect(interaction(emptyNavigation)).toEqual({ selectedPaths: [], focusedPath: null, selectionAnchor: null })
  await expect(explorer(empty, empty.worktree.id, { action: 'select', path: empty.root }))
    .rejects.toMatchObject({ code: RpcErrorCode.InvalidParams })
  expect((await stateOf(empty, empty.worktree.id)).explorer).toMatchObject({ selectedPaths: [], focusedPath: null, selectionAnchor: null })
})

test('Explorer interaction and expansion state are isolated by worktree', async () => {
  const world = await fixture({ 'A/first.txt': 'main\n', 'shared.txt': 'main\n' })
  const otherRoot = mkdtempSync(join(tmpdir(), 'quirky-editor-explorer-other-'))
  world.roots.add(otherRoot)
  git(world.root, world.home, ['worktree', 'add', '-b', 'other', otherRoot])
  const worktrees = await call<Worktree[]>(world.client, 'quirky.worktree/list', { repo: world.repoId })
  const second = worktrees.find((entry) => entry.path === otherRoot)
  if (!second) throw new Error('the linked test worktree was not registered')

  await explorer(world, world.worktree.id, { action: 'select', path: join(world.root, 'A') })
  await explorer(world, world.worktree.id, { action: 'navigate', key: 'ArrowRight' })
  await explorer(world, world.worktree.id, { action: 'select', path: join(world.root, 'shared.txt') })
  await explorer(world, second.id, { action: 'select', path: join(otherRoot, 'A') })
  const firstState = (await stateOf(world, world.worktree.id)).explorer
  const secondState = (await stateOf(world, second.id)).explorer
  expect(firstState).toMatchObject({ worktreeId: world.worktree.id, expanded: ['A'], selectedPaths: [join(world.root, 'shared.txt')], focusedPath: join(world.root, 'shared.txt') })
  expect(secondState).toMatchObject({ worktreeId: second.id, expanded: [], selectedPaths: [join(otherRoot, 'A')], focusedPath: join(otherRoot, 'A') })
})
