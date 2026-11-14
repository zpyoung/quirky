import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, readlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RpcErrorCode, type Repo, type Worktree, type WorktreeCreateResult } from '@quirky/protocol'
import type { ProjectMetadata } from '../src/daemon/project'
import { waitFor } from '../../../packages/daemon/test/helpers'
import { call, failure, git, isolateGitConfig } from '../../quirky.repo/test/git-fixtures'
import { testCliContext } from '../../quirky.repo/test/harness'
import { commands } from '../cli'
import { addExternalWorktree, listWorktrees, startRealProject, storedRows, type RealProject } from './fixtures/real-project'

setDefaultTimeout(60_000)

const { scratch } = isolateGitConfig()
let p: RealProject | undefined
afterEach(async () => {
  await p?.t.cleanup()
  p = undefined
})

async function start() {
  p = await startRealProject(scratch)
  return p
}

/** Primary plus one worktree per name, each on a branch of its own, made by plain git. */
function addWorktrees(repoDir: string, ...names: string[]): string[] {
  return names.map((name) => addExternalWorktree(repoDir, join(scratch(), name), `zoe/${name}`))
}

/** Creates a worktree and returns its record (the create result's `worktree`). */
const createWt = async (client: RealProject['client'], params: Record<string, unknown>) =>
  ((await call(client, 'quirky.worktree/create', params)) as WorktreeCreateResult).worktree

const cliJson = async (client: RealProject['client'], run: 'list' | 'show' | 'set', positionals: string[], flags: Record<string, string | boolean> = {}) => {
  const { ctx, lines } = testCliContext(client, { json: true })
  await commands[run]!({ positionals, flags }, ctx)
  return JSON.parse(lines[0]!)
}

describe('SC-1: adding a git repo lists its primary workspace first', () => {
  test('the only workspace is the primary checkout, in progress, named for its branch (CLI)', async () => {
    const { client, repoDir, repo } = await start()
    const again = (await call(client, 'quirky.repo/add', { path: repoDir })) as Repo
    expect(again.id).toBe(repo.id)

    const listed = (await cliJson(client, 'list', [], { repo: 'api' })) as Worktree[]
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ isMain: true, kind: 'git', name: 'main', branch: 'main', status: 'in-progress', path: repoDir, repoId: repo.id })
  })

  test('the text table has the ID, NAME, BRANCH, STATUS and PATH columns', async () => {
    const { client, repoDir } = await start()
    const { ctx, lines } = testCliContext(client)
    await commands.list!({ positionals: [], flags: { repo: 'api' } }, ctx)
    const rows = lines[0]!.split('\n')
    expect(rows[0]).toMatch(/^ID\s+NAME\s+BRANCH\s+STATUS\s+PATH$/)
    expect(rows[1]).toMatch(new RegExp(`^wt_[0-9a-f]{12}\\s+main\\s+main\\s+in-progress\\s+${repoDir}$`))
  })
})

describe('SC-9: removing a project drops its metadata', () => {
  test('adding the project again shows the worktree with no display name (API)', async () => {
    const { client, repoDir, repo, t } = await start()
    const [path] = addWorktrees(repoDir, 'fix-login')
    const [, fixLogin] = await listWorktrees(client, { repo: repo.id })
    await call(client, 'quirky.worktree/set', { worktree: fixLogin!.id, displayName: 'Login fix', comment: 'note' })
    expect(storedRows(t.h.home, 'repo_id = ?', repo.id)).toHaveLength(2)

    await call(client, 'quirky.repo/remove', { repo: repo.id })
    await waitFor(() => (storedRows(t.h.home, 'repo_id = ?', repo.id).length === 0 ? true : undefined))

    const readded = (await call(client, 'quirky.repo/add', { path: repoDir })) as Repo
    const listed = await listWorktrees(client, { repo: readded.id })
    expect(listed.find((w) => w.path === path)).toMatchObject({ id: fixLogin!.id, name: 'fix-login', displayName: null, comment: '' })
  })
  test('a group removal releases worktree membership after the pending repo refresh', async () => {
    const { client, repoDir, repo, t } = await start()
    addWorktrees(repoDir, 'grouped')
    const worktree = (await listWorktrees(client, { repo: repo.id })).find((item) => item.name === 'grouped')!
    const group = await call(client, 'quirky.repo/groupCreate', { name: 'release-target' }) as { id: string }
    await call(client, 'quirky.worktree/set', { worktree: worktree.id, projectGroupId: group.id })
    expect(storedRows(t.h.home, 'id = ?', worktree.id)).toMatchObject([{ project_group_id: group.id }])

    // Drain setup events through the production 250 ms COALESCE_INTERVAL_MS window.
    await Bun.sleep(300)
    const watcher = await t.h.connectWithEvents('cli')
    const repoChanges = () => watcher.events.filter((event) => event.type === 'quirky.repo/changed')
    const beforeRename = repoChanges().length
    // This leading event primes the repo key so groupDelete is held as its latest refresh.
    await call(client, 'quirky.repo/groupRename', { group: group.id, name: 'renamed-target' })
    const renameEvents = await waitFor(() => {
      const current = repoChanges()
      return current.length > beforeRename ? current.slice(beforeRename) : undefined
    })
    expect(renameEvents).toHaveLength(1)
    // PluginEvents dispatches subscribers with setImmediate; drain both queue turns before deletion.
    for (let turn = 0; turn < 2; turn++) {
      const { promise, resolve } = Promise.withResolvers<void>()
      setImmediate(resolve)
      await promise
    }

    const beforeDelete = repoChanges().length
    await call(client, 'quirky.repo/groupDelete', { group: group.id })
    const deleteEvents = await waitFor(() => {
      const current = repoChanges()
      return current.length > beforeDelete ? current.slice(beforeDelete) : undefined
    })
    expect(deleteEvents).toHaveLength(1)

    await waitFor(() => {
      const row = storedRows(t.h.home, 'id = ?', worktree.id)[0]
      return row?.project_group_id === null ? true : undefined
    })
    const listed = (await listWorktrees(client, { repo: repo.id })).find((item) => item.id === worktree.id)
    expect(listed).toMatchObject({ projectGroupId: null })
  })
})

describe('SC-40: display name, note, status, pin and unread are set and listed', () => {
  test('set through the CLI shows in list, an empty display name clears it, an unknown status is refused', async () => {
    const { client, repoDir, repo } = await start()
    addWorktrees(repoDir, 'fix-login')

    const set = (await cliJson(client, 'set', ['fix-login'], {
      'display-name': 'Login fix',
      comment: 'see the auth bug',
      'workspace-status': 'in-review',
      pin: true,
      unread: true
    })) as Worktree
    expect(set).toMatchObject({ name: 'Login fix', displayName: 'Login fix', comment: 'see the auth bug', status: 'in-review', pinned: true, unread: true })

    const [, listed] = (await cliJson(client, 'list', [], { repo: repo.id })) as Worktree[]
    expect(listed).toMatchObject({ name: 'Login fix', comment: 'see the auth bug', status: 'in-review', pinned: true, unread: true, branch: 'zoe/fix-login' })
    expect(listed!.path.endsWith('/fix-login')).toBe(true)

    const cleared = (await cliJson(client, 'set', ['Login fix'], { 'display-name': '' })) as Worktree
    expect(cleared).toMatchObject({ name: 'fix-login', displayName: null, comment: 'see the auth bug', status: 'in-review' })

    const refused = await failure(cliJson(client, 'set', ['fix-login'], { 'workspace-status': 'shipped' }))
    expect(refused.code).toBe(RpcErrorCode.InvalidParams)
    for (const status of ['todo', 'in-progress', 'in-review', 'done']) expect(refused.message).toContain(status)
  })

  test('--unpin and --read undo --pin and --unread, and each pair together is a usage error', async () => {
    const { client, repoDir } = await start()
    addWorktrees(repoDir, 'fix-login')
    await cliJson(client, 'set', ['fix-login'], { pin: true, unread: true })
    expect(await cliJson(client, 'set', ['fix-login'], { unpin: true, read: true })).toMatchObject({ pinned: false, unread: false })

    const conflicting: Record<string, string | boolean>[] = [{ pin: true, unpin: true }, { unread: true, read: true }, { 'parent-worktree': 'main', 'no-parent': true }, {}]
    for (const flags of conflicting) {
      await expect(cliJson(client, 'set', ['fix-login'], flags)).rejects.toThrow(/^usage:/)
    }
  })

  test('a display name of only spaces clears it, and set emits changed with the worktree', async () => {
    const { client, repoDir, repo, t } = await start()
    addWorktrees(repoDir, 'fix-login')
    const watcher = await t.h.connectWithEvents('cli')
    const set = (await call(client, 'quirky.worktree/set', { worktree: 'fix-login', displayName: '   ' })) as Worktree
    expect(set.displayName).toBeNull()
    const changed = await waitFor(() => watcher.events.find((e) => e.type === 'quirky.worktree/changed'))
    expect(changed).toMatchObject({ data: { repoId: repo.id, worktreeId: set.id } })
  })
})

describe('worktree unread event attribution', () => {
  test('source is event-only, requires a boolean unread operation, and is validated before metadata changes', async () => {
    const { client, repoDir, repo, t } = await start()
    addWorktrees(repoDir, 'fix-login')
    const worktree = (await listWorktrees(client, { repo: repo.id })).find((item) => item.name === 'fix-login')!
    // Drain the production 250 ms COALESCE_INTERVAL_MS window before event-count baselines.
    await Bun.sleep(300)
    const watcher = await t.h.connectWithEvents('cli')
    type ChangedData = { repoId: string; worktreeId: string; unread?: boolean; unreadSource?: string }
    const changes = () => watcher.events
      .filter((event) => event.type === 'quirky.worktree/changed')
      .map((event) => {
        if (!('data' in event)) throw new Error('expected a worktree plugin event')
        return event.data as ChangedData
      })
    const next = async <T>(action: () => Promise<T>) => {
      const before = changes().length
      const result = await action()
      const events = await waitFor(() => {
        const current = changes()
        return current.length > before ? current.slice(before) : undefined
      })
      return { event: events[0]!, result }
    }
    const set = (params: Record<string, unknown>) =>
      call(client, 'quirky.worktree/set', { worktree: worktree.id, ...params }) as Promise<Worktree>

    const { event: createdEvent, result: created } = await next(() =>
      createWt(client, { repo: repo.id, name: 'event-shape' })
    )
    expect(createdEvent).toEqual({ repoId: repo.id, worktreeId: created.id })

    const { event: firstEvent, result: first } = await next(() =>
      set({ unread: false, unreadSource: 'notifications' })
    )
    expect(first.unread).toBe(false)
    expect(first).not.toHaveProperty('unreadSource')
    expect(firstEvent).toEqual({
      repoId: repo.id,
      worktreeId: worktree.id,
      unread: false,
      unreadSource: 'notifications'
    })

    const { event: repeatedEvent, result: repeated } = await next(() =>
      set({ unread: false, unreadSource: 'notifications' })
    )
    expect(repeated).not.toHaveProperty('unreadSource')
    expect(repeatedEvent).toEqual({
      repoId: repo.id,
      worktreeId: worktree.id,
      unread: false,
      unreadSource: 'notifications'
    })

    const { event: markReadEvent, result: markRead } = await next(() => set({ unread: false }))
    expect(markRead.unread).toBe(false)
    expect(markRead).not.toHaveProperty('unreadSource')
    expect(markReadEvent).toEqual({ repoId: repo.id, worktreeId: worktree.id, unread: false })

    const { event: normalEvent, result: normal } = await next(() => set({ unread: true }))
    expect(normal).not.toHaveProperty('unreadSource')
    expect(normalEvent).toEqual({
      repoId: repo.id,
      worktreeId: worktree.id,
      unread: true
    })

    // This shares the unread=true key, so assert the newly delivered payload rather than the first event.
    const { event: repeatedNormalEvent, result: repeatedNormal } = await next(() => set({ unread: true }))
    expect(repeatedNormal.unread).toBe(true)
    expect(repeatedNormal).not.toHaveProperty('unreadSource')
    expect(repeatedNormalEvent).toEqual({
      repoId: repo.id,
      worktreeId: worktree.id,
      unread: true
    })

    const { event: metadataEvent, result: metadataOnly } = await next(() => set({ comment: 'kept' }))
    expect(metadataOnly.unread).toBe(true)
    expect(metadataOnly).not.toHaveProperty('unreadSource')
    expect(metadataEvent).toEqual({
      repoId: repo.id,
      worktreeId: worktree.id
    })

    for (const unreadSource of ['user', '', null, 7]) {
      expect(await failure(set({
        displayName: 'must not persist',
        unread: false,
        unreadSource
      }))).toMatchObject({ code: RpcErrorCode.InvalidParams })
    }
    expect(await failure(set({
      displayName: 'must not persist',
      unreadSource: 'notifications'
    }))).toMatchObject({ code: RpcErrorCode.InvalidParams })
    const listed = (await listWorktrees(client, { repo: repo.id })).find((item) => item.id === worktree.id)
    expect(listed).toMatchObject({ displayName: null, comment: 'kept', unread: true })
  })
})

describe('set stores the worktree base ref', () => {
  test('a string is trimmed and stored, an empty or blank string or null clears it, and other types are refused', async () => {
    const { client, repoDir } = await start()
    addWorktrees(repoDir, 'fix-login')
    const set = (baseRef: unknown) => call(client, 'quirky.worktree/set', { worktree: 'fix-login', baseRef }) as Promise<Worktree>

    expect((await set('  origin/develop ')).baseRef).toBe('origin/develop')
    expect((await listWorktrees(client)).find((w) => w.name === 'fix-login')?.baseRef).toBe('origin/develop')
    expect((await set('')).baseRef).toBeNull()
    expect((await set('main')).baseRef).toBe('main')
    expect((await set('   ')).baseRef).toBeNull()
    expect((await set('main')).baseRef).toBe('main')
    expect((await set(null)).baseRef).toBeNull()

    for (const bad of [7, true, ['main'], {}]) {
      expect(await failure(set(bad))).toMatchObject({ code: RpcErrorCode.InvalidParams, message: 'baseRef must be a string or null' })
    }
  })

  test('a set without baseRef leaves it alone', async () => {
    const { client, repoDir } = await start()
    addWorktrees(repoDir, 'fix-login')
    await call(client, 'quirky.worktree/set', { worktree: 'fix-login', baseRef: 'main' })
    expect(((await call(client, 'quirky.worktree/set', { worktree: 'fix-login', pinned: true })) as Worktree).baseRef).toBe('main')
  })
})

describe('set persists references and metadata atomically', () => {
  test('omission preserves references, replacement deduplicates and keeps identities, and invalid input changes nothing', async () => {
    const { client, repo, t } = await start()
    let activeClient = client
    const worktree = await createWt(activeClient, { repo: repo.id, name: 'reference-save' })
    type Reference = { id: string; url: string; label: string; createdAt: number }
    const references = () => call(activeClient, 'quirky.worktree/references', { worktree: worktree.id }) as Promise<Reference[]>
    const set = (params: Record<string, unknown>) => call(activeClient, 'quirky.worktree/set', { worktree: worktree.id, ...params })
    const retained = await call(activeClient, 'quirky.worktree/linkReference', {
      worktree: worktree.id,
      url: 'https://tracker.example/issues/42',
      label: 'Initial label'
    }) as Reference
    const removed = await call(activeClient, 'quirky.worktree/linkReference', {
      worktree: worktree.id,
      url: 'https://tracker.example/issues/43',
      label: 'Remove this'
    }) as Reference

    const initial = await references()
    expect(initial).toEqual([retained, removed])
    expect(await set({ displayName: 'Login fix', comment: 'Initial notes' })).toMatchObject({
      displayName: 'Login fix',
      comment: 'Initial notes'
    })
    expect(await references()).toEqual(initial)

    const saved = await set({
      displayName: 'Saved login fix',
      comment: 'Saved notes',
      references: [
        { url: retained.url, label: 'First label' },
        { url: 'https://example.com/new-reference', label: '   ' },
        { url: retained.url, label: ' Last label ' }
      ]
    }) as Worktree
    expect(saved).toMatchObject({ displayName: 'Saved login fix', comment: 'Saved notes' })
    const savedReferences = await references()
    expect(savedReferences).toHaveLength(2)
    const byUrl = new Map(savedReferences.map((reference) => [reference.url, reference]))
    expect(byUrl.get(retained.url)).toEqual({ ...retained, label: 'Last label' })
    expect(byUrl.get('https://example.com/new-reference')).toMatchObject({
      url: 'https://example.com/new-reference',
      label: 'https://example.com/new-reference'
    })
    expect(byUrl.get('https://example.com/new-reference')?.id).toMatch(/^ref_/)
    expect(typeof byUrl.get('https://example.com/new-reference')?.createdAt).toBe('number')

    activeClient = (await t.restart()).client
    expect(await references()).toEqual(savedReferences)

    const rejected = await failure(set({
      displayName: 'Must not save',
      comment: 'Must not save',
      references: [{ url: 'javascript:alert(1)', label: 'Unsafe' }]
    }))
    expect(rejected.code).toBe(RpcErrorCode.InvalidParams)
    expect(await call(activeClient, 'quirky.worktree/resolve', { selector: worktree.id })).toMatchObject({
      displayName: 'Saved login fix',
      comment: 'Saved notes'
    })
    expect(await references()).toEqual(savedReferences)

    await set({ references: [] })
    expect(await references()).toEqual([])
  })
})

describe('SC-41: parents are set and cleared, and cycles are refused', () => {
  test('a, b under a, c under b: cycles are refused, no-parent clears, show lists the children (CLI)', async () => {
    const { client, repoDir } = await start()
    addWorktrees(repoDir, 'a', 'b', 'c')
    const [a, b, c] = ['a', 'b', 'c'].map((name) => `name:${name}`)
    await cliJson(client, 'set', [b!], { 'parent-worktree': a! })
    await cliJson(client, 'set', [c!], { 'parent-worktree': b! })

    const underDescendant = await failure(cliJson(client, 'set', [a!], { 'parent-worktree': c! }))
    expect(underDescendant).toMatchObject({ code: RpcErrorCode.InvalidParams, data: { reason: 'parent-cycle' } })
    expect(underDescendant.message).toContain('descendant')
    const underItself = await failure(cliJson(client, 'set', [a!], { 'parent-worktree': a! }))
    expect(underItself).toMatchObject({ code: RpcErrorCode.InvalidParams, data: { reason: 'parent-cycle' } })

    const cleared = (await cliJson(client, 'set', [c!], { 'no-parent': true })) as Worktree
    expect(cleared.parentId).toBeNull()

    const shown = (await cliJson(client, 'show', [a!])) as Worktree & { children: string[] }
    const bId = ((await call(client, 'quirky.worktree/resolve', { selector: b })) as Worktree).id
    expect(shown.children).toEqual([bId])
  })

  test('parent with noParent is InvalidParams, and show prints key: value lines with children', async () => {
    const { client, repoDir } = await start()
    addWorktrees(repoDir, 'a', 'b')
    const refused = await failure(call(client, 'quirky.worktree/set', { worktree: 'b', parent: 'a', noParent: true }))
    expect(refused.code).toBe(RpcErrorCode.InvalidParams)

    await call(client, 'quirky.worktree/set', { worktree: 'b', parent: 'a' })
    const a = (await call(client, 'quirky.worktree/resolve', { selector: 'a' })) as Worktree
    const b = (await call(client, 'quirky.worktree/resolve', { selector: 'b' })) as Worktree
    expect(b.parentId).toBe(a.id)

    const { ctx, lines } = testCliContext(client)
    await commands.show!({ positionals: ['a'], flags: {} }, ctx)
    const text = lines[0]!.split('\n')
    expect(text).toContain(`id: ${a.id}`)
    expect(text).toContain('name: a')
    expect(text).toContain(`children: ${b.id}`)
    expect(text).toContain('status: in-progress')
  })
})

describe('SC-45: metadata survives a restart and never follows a reused path', () => {
  test('the display name survives; a worktree removed and re-added at the same path lists with defaults (API)', async () => {
    const { client, repoDir, repo, t } = await start()
    const [path] = addWorktrees(repoDir, 'fix-login')
    await call(client, 'quirky.worktree/set', { worktree: 'fix-login', displayName: 'Login fix' })

    const restarted = await t.restart()
    const [, kept] = await listWorktrees(restarted.client, { repo: repo.id })
    expect(kept).toMatchObject({ displayName: 'Login fix', name: 'Login fix' })

    git(repoDir, 'worktree', 'remove', '--force', path!)
    expect((await listWorktrees(restarted.client, { repo: repo.id })).map((w) => w.path)).toEqual([repoDir])

    await Bun.sleep(15)
    git(repoDir, 'worktree', 'add', '-q', path!, 'zoe/fix-login')
    const [, reused] = await listWorktrees(restarted.client, { repo: repo.id })
    expect(reused).toMatchObject({ path, name: 'fix-login', displayName: null, status: 'in-progress', createdBy: 'external' })
  })
})

describe('create records its metadata', () => {
  test('the created worktree is the joined record, with its row written (created_root, createdBy, baseRef)', async () => {
    const { client, repo, root, t } = await start()
    const created = await createWt(client, { repo: repo.id, name: 'feature-x', base: 'main', createdBy: 'cli' })
    // D11: the git user.name of the test repo is the branch prefix
    expect(created).toMatchObject({ name: 'feature-x', branch: 'Test/feature-x', createdBy: 'cli', baseRef: 'main', status: 'in-progress', isMain: false })
    expect(created.head).toMatch(/^[0-9a-f]{40}$/)
    expect(created.createdAt).toBeGreaterThan(0)
    expect(storedRows(t.h.home, 'id = ?', created.id)).toMatchObject([{ created_root: root, created_by: 'cli', base_ref: 'main', path: created.path }])

    const plain = await createWt(client, { repo: repo.id, name: 'feature-y' })
    // D14: a create with no base records the detected default
    expect(plain).toMatchObject({ createdBy: 'api', baseRef: 'main' })
  })

  test('a re-created worktree does not inherit the metadata of one removed earlier at its path', async () => {
    const { client, repo, repoDir } = await start()
    const first = await createWt(client, { repo: repo.id, name: 'again' })
    await call(client, 'quirky.worktree/set', { worktree: first.id, displayName: 'Old', status: 'done' })
    await call(client, 'quirky.worktree/remove', { worktree: first.id, yes: true })
    const second = await createWt(client, { repo: repo.id, name: 'again' })
    expect(second).toMatchObject({ id: first.id, displayName: null, status: 'in-progress' })
  })
})
describe('per-project shared directories', () => {
  test('project metadata saves validated paths and the CLI can update them', async () => {
    const { client, repo } = await start()
    const saved = await call(client, 'quirky.worktree/setProjectMetadata', {
      repo: repo.id,
      sharedDirectories: ['.env.local', 'config/private']
    }) as { sharedDirectories: string[] }
    expect(saved.sharedDirectories).toEqual(['.env.local', 'config/private'])
    const refused = await failure(call(client, 'quirky.worktree/setProjectMetadata', {
      repo: repo.id,
      sharedDirectories: ['../outside']
    }))
    expect(refused.code).toBe(RpcErrorCode.InvalidParams)
    expect(((await call(client, 'quirky.worktree/projectMetadata', { repo: repo.id })) as ProjectMetadata).sharedDirectories)
      .toEqual(['.env.local', 'config/private'])

    const { ctx } = testCliContext(client)
    await commands['project-set']!({
      positionals: [repo.id],
      flags: { 'shared-directories': '["vendor","private/data"]' }
    }, ctx)
    expect(((await call(client, 'quirky.worktree/projectMetadata', { repo: repo.id })) as ProjectMetadata).sharedDirectories)
      .toEqual(['vendor', 'private/data'])
  })
  test('saved project shared directories are linked by the existing carry owner', async () => {
    const { client, repo, repoDir } = await start()
    writeFileSync(join(repoDir, '.gitignore'), 'private-cache/\n')
    mkdirSync(join(repoDir, 'private-cache'), { recursive: true })
    writeFileSync(join(repoDir, 'private-cache', 'settings.json'), '{}\n')
    git(repoDir, 'add', '.gitignore')
    git(repoDir, 'commit', '-q', '-m', 'ignore shared project cache')
    await call(client, 'quirky.worktree/setProjectMetadata', {
      repo: repo.id,
      sharedDirectories: ['private-cache']
    })

    const result = await call(client, 'quirky.worktree/create', { repo: repo.id, name: 'shared-cache' }) as WorktreeCreateResult & {
      creationReceipt: { sharedDirectories: string[] }
    }
    expect(readlinkSync(join(result.worktree.path, 'private-cache'))).toBe(join(repoDir, 'private-cache'))
    expect(result.creationReceipt.sharedDirectories).toEqual(['private-cache'])
  })
})

describe('settings', () => {
  test('nestWorkspaces, branchPrefix, branchPrefixCustom and confirmDelete are declared with their defaults', async () => {
    const { client } = await start()
    const get = async (name: string) => (await call(client, 'setting.get', { id: `setting:quirky.worktree/${name}` })) as Record<string, unknown>
    expect(await get('nestWorkspaces')).toMatchObject({ type: 'boolean', default: true, value: true })
    expect(await get('branchPrefix')).toMatchObject({ type: 'enum', values: ['git-username', 'custom', 'none'], default: 'git-username', value: 'git-username' })
    expect(await get('branchPrefixCustom')).toMatchObject({ type: 'string', default: '', value: '' })
    expect(await get('confirmDelete')).toMatchObject({ type: 'boolean', default: true, value: true })
    expect(await get('worktreesRoot')).toMatchObject({ type: 'string', default: '~/quirky/workspaces' })

    await call(client, 'setting.set', { id: 'setting:quirky.worktree/branchPrefix', value: 'custom' })
    expect((await get('branchPrefix')).value).toBe('custom')
    expect((await failure(call(client, 'setting.set', { id: 'setting:quirky.worktree/branchPrefix', value: 'nope' }))).code).toBe(RpcErrorCode.InvalidParams)
  })

  test('set and show are declared, show read-only; list takes a group', async () => {
    const { client } = await start()
    const catalog = (await call(client, 'api.describe')) as { methods: { name: string; readOnly?: boolean; params?: { properties?: Record<string, unknown> } }[] }
    const byName = new Map(catalog.methods.map((m) => [m.name, m]))
    expect(byName.get('quirky.worktree/show')?.readOnly).toBe(true)
    expect(byName.get('quirky.worktree/set')?.readOnly).toBeUndefined()
    expect(Object.keys(byName.get('quirky.worktree/list')!.params!.properties!)).toEqual(expect.arrayContaining(['repo', 'group']))
    expect(Object.keys(byName.get('quirky.worktree/create')!.params!.properties!)).toEqual(expect.arrayContaining(['group', 'name']))
  })
})
