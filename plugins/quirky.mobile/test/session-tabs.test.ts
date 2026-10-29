import { afterEach, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MobileMarkdownDocument, MobileWorkspaceTab, QuirkyClient, Worktree } from '@quirky/protocol'
import { makeTempHome, startHarness, type Harness } from '../../../packages/daemon/test/helpers'
import { makeBuiltinDir } from '../../quirky.session/test/support'

type Fixture = { harness: Harness; client: QuirkyClient; worktree: Worktree; root: string }
let fixture: Fixture | undefined
let pendingHarness: Harness | undefined
const roots = new Set<string>()
const previousPort = process.env.QUIRKY_MOBILE_PORT

afterEach(async () => {
  if (fixture) {
    await fixture.harness.cleanup()
    fixture = undefined
  }
  if (pendingHarness) {
    await pendingHarness.cleanup()
    pendingHarness = undefined
  }
  for (const root of roots) {
    roots.delete(root)
    rmSync(root, { recursive: true, force: true })
  }
  if (previousPort === undefined) delete process.env.QUIRKY_MOBILE_PORT
  else process.env.QUIRKY_MOBILE_PORT = previousPort
})

async function createFixture(): Promise<Fixture> {
  process.env.QUIRKY_MOBILE_PORT = '0'
  const root = mkdtempSync(join(tmpdir(), 'quirky-mobile-tabs-'))
  roots.add(root)
  writeFileSync(join(root, 'README.md'), '# Existing note\n')
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
  execFileSync('git', ['-c', 'user.email=mobile@test', '-c', 'user.name=Mobile Test', 'add', '.'], { cwd: root })
  execFileSync('git', ['-c', 'user.email=mobile@test', '-c', 'user.name=Mobile Test', 'commit', '-q', '-m', 'initial'], { cwd: root })
  const home = makeTempHome()
  const harness = await startHarness({
    home,
    builtinPluginsDir: makeBuiltinDir(home, {
      real: ['quirky.mobile', 'quirky.editor', 'quirky.session', 'quirky.terminal', 'quirky.agents', 'quirky.agent-status', 'quirky.worktree', 'quirky.repo', 'quirky.cli', 'quirky.ask', 'quirky.structured'],
      fakes: []
    })
  })
  pendingHarness = harness
  const client = await harness.connect('cli')
  const repo = await client.callAny('quirky.repo/add', { path: root }) as { id: string }
  const worktrees = await client.callAny('quirky.worktree/list', { repo: repo.id }) as Worktree[]
  const worktree = worktrees.find((item) => item.path === root) ?? worktrees[0]
  if (!worktree) throw new Error('repo add returned no worktree')
  const ready: Fixture = { harness, client, worktree, root }
  fixture = ready
  pendingHarness = undefined
  return ready
}

const call = <T>(client: QuirkyClient, method: string, params: Record<string, unknown> = {}) => client.callAny(method, params) as Promise<T>


test('public mobile Markdown APIs preserve actual tab identity, bounded drafts and dirty-close decisions', async () => {
  const { client, worktree, root } = await createFixture()
  const created = await call<MobileMarkdownDocument>(client, 'quirky.mobile/markdownCreate', { worktree: worktree.id })
  expect(created.worktreeId).toBe(worktree.id)
  expect(created.text).toBe('')
  expect(Number.isSafeInteger(created.revision)).toBe(true)
  expect(created.revision).toBeGreaterThanOrEqual(0)
  expect(created.dirty).toBe(false)
  expect(created.readOnly).toBe(false)

  const state = await call<{ tabs: { tabId: string; bufferId: string }[]; buffers: { id: string; relativePath: string }[] }>(client, 'quirky.editor/state', { worktree: worktree.id })
  const editorTab = state.tabs.find((tab) => tab.tabId === created.tabId)
  expect(editorTab).toBeDefined()
  expect(state.buffers.find((buffer) => buffer.id === editorTab?.bufferId)?.relativePath).toBe(created.relativePath)
  const listed = await call<MobileWorkspaceTab[]>(client, 'quirky.mobile/sessionTabs', { worktree: worktree.id })
  expect(listed).toContainEqual(expect.objectContaining({ tabId: created.tabId, worktreeId: worktree.id, kind: 'markdown' }))

  const written = await call<MobileMarkdownDocument>(client, 'quirky.mobile/markdownWrite', {
    worktree: worktree.id, tabId: created.tabId, text: '# Phone note\n', expectedRevision: created.revision
  })
  expect(written.text).toBe('# Phone note\n')
  expect(written.dirty).toBe(true)
  expect(Number.isSafeInteger(written.revision)).toBe(true)
  await expect(call(client, 'quirky.mobile/markdownWrite', {
    worktree: worktree.id, tabId: created.tabId, text: '# Stale overwrite\n', expectedRevision: created.revision
  })).rejects.toThrow()
  const afterDraft = await call<MobileMarkdownDocument>(client, 'quirky.mobile/markdownRead', { worktree: worktree.id, tabId: created.tabId })
  expect(afterDraft.text).toBe('# Phone note\n')
  expect(afterDraft.dirty).toBe(true)
  expect(afterDraft.revision).toBe(written.revision)

  const saved = await call<MobileMarkdownDocument>(client, 'quirky.mobile/markdownSave', {
    worktree: worktree.id, tabId: created.tabId, expectedRevision: written.revision
  })
  expect(saved.text).toBe('# Phone note\n')
  expect(saved.dirty).toBe(false)
  expect(readFileSync(join(root, created.relativePath), 'utf8')).toBe('# Phone note\n')
  await expect(call(client, 'quirky.mobile/markdownSave', {
    worktree: worktree.id, tabId: created.tabId, expectedRevision: written.revision
  })).rejects.toThrow()

  writeFileSync(join(root, created.relativePath), '# Changed on disk\n')
  expect(await call<{ tabId: string; closed: boolean }>(client, 'quirky.mobile/sessionTabAction', { worktree: worktree.id, tabId: created.tabId, action: 'refresh' }))
    .toEqual({ tabId: created.tabId, closed: false })
  const refreshed = await call<MobileMarkdownDocument>(client, 'quirky.mobile/markdownRead', { worktree: worktree.id, tabId: created.tabId })
  expect(refreshed.text).toBe('# Changed on disk\n')
  expect(refreshed.dirty).toBe(false)
  expect(Number.isSafeInteger(refreshed.revision)).toBe(true)

  await call(client, 'quirky.mobile/sessionTabAction', { worktree: worktree.id, tabId: created.tabId, action: 'rename', name: 'Phone title' })
  expect(await call<MobileWorkspaceTab[]>(client, 'quirky.mobile/sessionTabs', { worktree: worktree.id }))
    .toContainEqual(expect.objectContaining({ tabId: created.tabId, title: 'Phone title' }))

  const dirty = await call<MobileMarkdownDocument>(client, 'quirky.mobile/markdownWrite', {
    worktree: worktree.id, tabId: created.tabId, text: '# Keep this draft\n', expectedRevision: refreshed.revision
  })
  expect(dirty.dirty).toBe(true)
  expect(await call<{ tabId: string; closed: boolean }>(client, 'quirky.mobile/sessionTabAction', { worktree: worktree.id, tabId: created.tabId, action: 'close' }))
    .toEqual({ tabId: created.tabId, closed: false })
  const readDirty = await call<MobileMarkdownDocument>(client, 'quirky.mobile/markdownRead', { worktree: worktree.id, tabId: created.tabId })
  expect(readDirty.text).toBe('# Keep this draft\n')
  expect(readDirty.dirty).toBe(true)
  expect(await call<{ tabId: string; closed: boolean }>(client, 'quirky.mobile/sessionTabAction', { worktree: worktree.id, tabId: created.tabId, action: 'close', discard: true }))
    .toEqual({ tabId: created.tabId, closed: true })
  expect(await call<MobileWorkspaceTab[]>(client, 'quirky.mobile/sessionTabs', { worktree: worktree.id })).not.toContainEqual(expect.objectContaining({ tabId: created.tabId }))
})


test('public mobile Markdown APIs deny cross-worktree identities before reading or writing', async () => {
  const { client, worktree } = await createFixture()
  const created = await call<MobileMarkdownDocument>(client, 'quirky.mobile/markdownCreate', { worktree: worktree.id })
  const otherRoot = mkdtempSync(join(tmpdir(), 'quirky-mobile-tabs-other-'))
  roots.add(otherRoot)
  writeFileSync(join(otherRoot, 'README.md'), '# Other\n')
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: otherRoot })
  execFileSync('git', ['-c', 'user.email=mobile@test', '-c', 'user.name=Mobile Test', 'add', '.'], { cwd: otherRoot })
  execFileSync('git', ['-c', 'user.email=mobile@test', '-c', 'user.name=Mobile Test', 'commit', '-q', '-m', 'initial'], { cwd: otherRoot })
  const otherRepo = await call<{ id: string }>(client, 'quirky.repo/add', { path: otherRoot })
  const otherWorktrees = await call<Worktree[]>(client, 'quirky.worktree/list', { repo: otherRepo.id })
  const other = otherWorktrees.find((item) => item.path === otherRoot) ?? otherWorktrees[0]
  if (!other) throw new Error('second repo add returned no worktree')

  await expect(call(client, 'quirky.mobile/markdownRead', { worktree: other.id, tabId: created.tabId })).rejects.toThrow()
  await expect(call(client, 'quirky.mobile/markdownWrite', {
    worktree: other.id, tabId: created.tabId, text: 'forbidden', expectedRevision: created.revision
  })).rejects.toThrow()
  expect(await call<MobileMarkdownDocument>(client, 'quirky.mobile/markdownRead', { worktree: worktree.id, tabId: created.tabId }))
    .toMatchObject({ text: '', revision: created.revision })
})


test('public mobile Markdown APIs enforce UTF-8 byte limits before returning document text', async () => {
  const { client, worktree, root } = await createFixture()
  const created = await call<MobileMarkdownDocument>(client, 'quirky.mobile/markdownCreate', { worktree: worktree.id })
  const exactLimit = 'é'.repeat(32 * 1024)
  expect(new TextEncoder().encode(exactLimit).byteLength).toBe(64 * 1024)
  const accepted = await call<MobileMarkdownDocument>(client, 'quirky.mobile/markdownWrite', {
    worktree: worktree.id, tabId: created.tabId, text: exactLimit, expectedRevision: created.revision
  })
  expect(accepted.text).toBe(exactLimit)
  await expect(call(client, 'quirky.mobile/markdownWrite', {
    worktree: worktree.id, tabId: created.tabId, text: `${exactLimit}é`, expectedRevision: accepted.revision
  })).rejects.toThrow(/64 KiB|65536/)
  const asciiLimit = 'a'.repeat(64 * 1024)
  const ascii = await call<MobileMarkdownDocument>(client, 'quirky.mobile/markdownWrite', {
    worktree: worktree.id, tabId: created.tabId, text: asciiLimit, expectedRevision: accepted.revision
  })
  expect(ascii.text).toBe(asciiLimit)

  writeFileSync(join(root, 'large.md'), 'x'.repeat(64 * 1024 + 1))
  const large = await call<{ openedTabId: string }>(client, 'quirky.editor/open', { worktree: worktree.id, path: 'large.md', mode: 'source' })
  await expect(call(client, 'quirky.mobile/markdownRead', { worktree: worktree.id, tabId: large.openedTabId })).rejects.toThrow(/64 KiB|65536/)
})
