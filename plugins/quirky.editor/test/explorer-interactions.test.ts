import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { RpcErrorCode, type MethodHandler, type PluginCaller, type QuirkyClient, type QuirkyEvent } from '@quirky/protocol'
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
  buffers: unknown[]
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
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'quirky-editor-explorer-')))
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

test('successful directory rename clears affected descendants and preserves unrelated Explorer selection', async () => {
  const world = await fixture({
    'folder/selected.txt': 'selected\n',
    'folder-sibling/keep.txt': 'keep\n',
    'occupied.txt': 'occupied\n'
  })
  const worktree = world.worktree.id
  const path = (name: string) => join(world.root, name)
  const folder = path('folder')
  const descendant = path('folder/selected.txt')
  const sibling = path('folder-sibling')

  await explorer(world, worktree, { action: 'select', path: folder })
  await explorer(world, worktree, { action: 'navigate', key: 'ArrowRight' })
  await explorer(world, worktree, { action: 'select', path: descendant })
  const beforeMutation = await explorer(world, worktree, { action: 'select', path: sibling, toggle: true })
  expect(interaction(beforeMutation)).toEqual({
    selectedPaths: [descendant, sibling],
    focusedPath: sibling,
    selectionAnchor: descendant
  })

  await expect(call(world.client, 'quirky.editor/mutate', {
    worktree,
    action: 'rename',
    path: 'folder',
    newPath: 'occupied.txt'
  })).rejects.toMatchObject({ code: RpcErrorCode.Conflict })
  expect((await stateOf(world, worktree)).explorer).toMatchObject({
    selectedPaths: [descendant, sibling],
    focusedPath: sibling,
    selectionAnchor: descendant
  })

  await call(world.client, 'quirky.editor/mutate', {
    worktree,
    action: 'rename',
    path: 'folder',
    newPath: 'renamed-folder'
  })
  expect((await stateOf(world, worktree)).explorer).toMatchObject({
    selectedPaths: [sibling],
    focusedPath: sibling,
    selectionAnchor: null
  })
})

test('deleting a directory clears selected descendant focus and anchor', async () => {
  const world = await fixture({ 'folder/selected.txt': 'selected\n' })
  const worktree = world.worktree.id
  const descendant = join(world.root, 'folder/selected.txt')

  await explorer(world, worktree, { action: 'select', path: join(world.root, 'folder') })
  await explorer(world, worktree, { action: 'navigate', key: 'ArrowRight' })
  const selected = await explorer(world, worktree, { action: 'select', path: descendant })
  expect(interaction(selected)).toEqual({
    selectedPaths: [descendant],
    focusedPath: descendant,
    selectionAnchor: descendant
  })

  await call(world.client, 'quirky.editor/mutate', { worktree, action: 'delete', path: 'folder' })
  expect((await stateOf(world, worktree)).explorer).toMatchObject({
    selectedPaths: [],
    focusedPath: null,
    selectionAnchor: null
  })
})

test.each([
  { action: 'delete', path: 'real/delete.txt' },
  { action: 'rename', path: 'real/rename.txt', newPath: 'real/renamed.txt' }
])('Explorer $action clears every selected alias of the mutated file', async ({ action, path, newPath }) => {
  const world = await fixture({
    'real/delete.txt': 'delete\n',
    'real/rename.txt': 'rename\n'
  })
  const worktree = world.worktree.id
  const name = basename(path)
  const lexicalPath = join(world.root, 'link', name)
  const canonicalPath = join(world.root, path)
  symlinkSync('real', join(world.root, 'link'), 'dir')
  await call(world.client, 'setting.set', {
    id: 'setting:quirky.editor/followSymlinkedDirectories',
    value: true
  })

  const matching = await explorer(world, worktree, { action: 'filter', query: name })
  expect(matching.entries.map((entry) => entry.path)).toContain(lexicalPath)
  expect(matching.entries.map((entry) => entry.path)).toContain(canonicalPath)
  await explorer(world, worktree, { action: 'select', path: lexicalPath, query: name })
  const multiple = await explorer(world, worktree, { action: 'select', path: canonicalPath, query: name, toggle: true })
  expect(interaction(multiple).selectedPaths).toContain(lexicalPath)
  expect(interaction(multiple).selectedPaths).toContain(canonicalPath)
  expect(interaction(multiple).focusedPath).toBe(canonicalPath)
  expect(interaction(multiple).selectionAnchor).toBe(lexicalPath)

  await call(world.client, 'quirky.editor/mutate', {
    worktree,
    action,
    path,
    ...(newPath === undefined ? {} : { newPath })
  })
  expect((await stateOf(world, worktree)).explorer).toMatchObject({
    selectedPaths: [],
    focusedPath: null,
    selectionAnchor: null
  })
})

test('Explorer mutation clears selection made through an in-worktree symlink alias', async () => {
  const world = await fixture({ 'real/a.txt': 'selected\n' })
  const worktree = world.worktree.id
  const lexicalPath = join(world.root, 'link/a.txt')
  symlinkSync('real', join(world.root, 'link'), 'dir')
  await call(world.client, 'setting.set', {
    id: 'setting:quirky.editor/followSymlinkedDirectories',
    value: true
  })

  const matching = await explorer(world, worktree, { action: 'filter', query: 'link' })
  expect(matching.entries.map((entry) => entry.path)).toContain(lexicalPath)
  const selected = await explorer(world, worktree, { action: 'select', path: lexicalPath, query: 'link' })
  expect(interaction(selected)).toEqual({
    selectedPaths: [lexicalPath],
    focusedPath: lexicalPath,
    selectionAnchor: lexicalPath
  })

  await call(world.client, 'quirky.editor/mutate', { worktree, action: 'delete', path: 'link/a.txt' })
  expect((await stateOf(world, worktree)).explorer).toMatchObject({
    selectedPaths: [],
    focusedPath: null,
    selectionAnchor: null
  })
})

test('Explorer deleting a followed symlink directory clears selected descendants', async () => {
  const world = await fixture({ 'real/inside.txt': 'selected\n' })
  const worktree = world.worktree.id
  const lexicalDirectory = join(world.root, 'link')
  const lexicalDescendant = join(lexicalDirectory, 'inside.txt')
  symlinkSync('real', lexicalDirectory, 'dir')
  await call(world.client, 'setting.set', {
    id: 'setting:quirky.editor/followSymlinkedDirectories',
    value: true
  })

  await explorer(world, worktree, { action: 'select', path: lexicalDirectory })
  const expanded = await explorer(world, worktree, { action: 'navigate', key: 'ArrowRight' })
  expect(expanded.expanded).toEqual(['link'])
  const selected = await explorer(world, worktree, { action: 'select', path: lexicalDescendant })
  expect(interaction(selected)).toEqual({
    selectedPaths: [lexicalDescendant],
    focusedPath: lexicalDescendant,
    selectionAnchor: lexicalDescendant
  })

  await call(world.client, 'quirky.editor/mutate', { worktree, action: 'delete', path: 'link' })
  expect((await stateOf(world, worktree)).explorer).toMatchObject({
    selectedPaths: [],
    focusedPath: null,
    selectionAnchor: null
  })
  expect(realpathSync(join(world.root, 'real/inside.txt'))).toBe(join(world.root, 'real/inside.txt'))
})

test('Explorer delete invalidates filtered inventory before navigation can restore a stale selection', async () => {
  const world = await fixture({ 'dist/matching.txt': 'selected\n' })
  const worktree = world.worktree.id
  const path = join(world.root, 'dist/matching.txt')
  // dist files remain searchable but their watcher events are intentionally ignored.

  await explorer(world, worktree, { action: 'filter', query: 'matching' })
  await explorer(world, worktree, { action: 'select', path, query: 'matching' })
  await call(world.client, 'quirky.editor/open', { worktree, path: 'dist/matching.txt' })

  const pluginHost = world.harness.daemon.plugins
  const resolveImplementation = pluginHost.resolveImplementation.bind(pluginHost)
  const closeStarted = Promise.withResolvers<void>()
  const releaseClose = Promise.withResolvers<void>()
  pluginHost.resolveImplementation = async (id) => {
    const implementation = await resolveImplementation(id)
    if (id !== 'method:quirky.terminal/closeTab') return implementation
    const closeTab = implementation as MethodHandler
    const gatedCloseTab: MethodHandler = async (params: Record<string, unknown>, caller: PluginCaller) => {
      closeStarted.resolve()
      await releaseClose.promise
      return await closeTab(params, caller)
    }
    return gatedCloseTab
  }

  const deletion = call(world.client, 'quirky.editor/mutate', { worktree, action: 'delete', path: 'dist/matching.txt' }).then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error })
  )
  let navigation: ExplorerResult | undefined
  let barrierError: unknown
  try {
    const closeReached = await Promise.race([
      closeStarted.promise.then(() => true),
      deletion.then(() => false)
    ])
    if (!closeReached) throw new Error('Delete completed before its terminal close barrier was reached')
    navigation = await explorer(world, worktree, { action: 'navigate', key: 'Home', query: 'matching' })
  } catch (error) {
    barrierError = error
  } finally {
    releaseClose.resolve()
    pluginHost.resolveImplementation = resolveImplementation
  }

  const result = await deletion
  if (!result.ok) throw result.error
  if (barrierError !== undefined) throw barrierError
  if (navigation === undefined) throw new Error('Explorer navigation did not complete during delete')
  expect(interaction(navigation)).toEqual({ selectedPaths: [], focusedPath: null, selectionAnchor: null })
  expect((await stateOf(world, worktree)).explorer).toMatchObject({
    selectedPaths: [],
    focusedPath: null,
    selectionAnchor: null
  })
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
  const otherRoot = realpathSync(mkdtempSync(join(tmpdir(), 'quirky-editor-explorer-other-')))
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

test('Explorer watching survives the last clean buffer closing and refreshes external changes', async () => {
  const world = await fixture({ 'buffer.txt': 'buffer\n' })
  const worktree = world.worktree.id

  const initial = await explorer(world, worktree, { action: 'list', path: '.' })
  expect(initial.entries.map((entry) => entry.name)).toContain('buffer.txt')
  expect((await stateOf(world, worktree)).buffers).toEqual([])
  const opened = await call<{ id: string }>(world.client, 'quirky.editor/open', { worktree, path: 'buffer.txt' })
  expect((await stateOf(world, worktree)).buffers).toHaveLength(1)
  expect(await call<{ closed: boolean }>(world.client, 'quirky.editor/close', { bufferId: opened.id })).toMatchObject({ closed: true })
  expect((await stateOf(world, worktree)).buffers).toEqual([])

  const createdPaths = ['externally-created-one.ts', 'externally-created-two.ts'].map((name) => join(world.root, name))
  const changes = () => world.events.filter((event) => event.type === 'quirky.editor/explorerChanged')
  world.events.length = 0
  for (const path of createdPaths) writeFileSync(path, 'external\n')

  const createdChange = await waitFor(() => changes()[0])
  expect('data' in createdChange ? createdChange.data : undefined).toEqual({ worktreeId: worktree })

  const createdListing = await explorer(world, worktree, { action: 'list', path: '.' })
  expect(createdListing.entries.map((entry) => entry.path)).toEqual(expect.arrayContaining(createdPaths))
  const createdFilter = await explorer(world, worktree, { action: 'filter', query: 'externally-created' })
  expect(createdFilter.entries.map((entry) => entry.path).sort()).toEqual(createdPaths.sort())

  world.events.length = 0
  unlinkSync(createdPaths[0]!)
  const deletedChange = await waitFor(() => changes()[0])
  expect('data' in deletedChange ? deletedChange.data : undefined).toEqual({ worktreeId: worktree })

  const deletedListing = await explorer(world, worktree, { action: 'list', path: '.' })
  expect(deletedListing.entries.map((entry) => entry.path)).not.toContain(createdPaths[0])
  expect(deletedListing.entries.map((entry) => entry.path)).toContain(createdPaths[1])
  const deletedFilter = await explorer(world, worktree, { action: 'filter', query: 'externally-created' })
  expect(deletedFilter.entries.map((entry) => entry.path)).toEqual([createdPaths[1]])
})
