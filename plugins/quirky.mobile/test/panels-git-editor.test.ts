import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { builtinsDir, startHarness, type Harness } from '../../../packages/daemon/test/helpers'
import { MobileTestClient } from './support/client'
import { Store } from '../../../packages/daemon/src/store'


const ENV_KEYS = [
  'HOME', 'QUIRKY_HOME', 'QUIRKY_MOBILE_PORT', 'QUIRKY_MOBILE_HOST',
  'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS', 'GIT_TERMINAL_PROMPT', 'XDG_CONFIG_HOME',
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR'
] as const

type Worktree = { id: string; path: string }
type Fixture = {
  root: string
  environment: Map<string, string | undefined>
  harness: Harness
  phone: MobileTestClient
  primary: Worktree
  secondary: Worktree
}

let fixture: Fixture | undefined

function saveEnvironment(): Map<string, string | undefined> {
  return new Map(ENV_KEYS.map((key) => [key, process.env[key]]))
}

function restoreEnvironment(environment: Map<string, string | undefined>): void {
  for (const [key, value] of environment) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

function runGit(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, env: process.env })
  const stdout = Buffer.from(result.stdout).toString('utf8')
  const stderr = Buffer.from(result.stderr).toString('utf8')
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed (${result.exitCode}): ${stderr || stdout}`)
  return stdout
}

async function cleanupOwned(
  root: string,
  environment: Map<string, string | undefined>,
  harness?: Harness,
  phone?: MobileTestClient
): Promise<void> {
  const errors: unknown[] = []
  if (phone) {
    try { await phone.close() } catch (error) { errors.push(error) }
  }
  if (harness) {
    try { await harness.cleanup() } catch (error) { errors.push(error) }
  }
  try { rmSync(root, { recursive: true, force: true }) } catch (error) { errors.push(error) }
  restoreEnvironment(environment)
  if (errors.length > 0) throw new AggregateError(errors, 'Mobile panel fixture cleanup failed')
}

async function boot(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'quirky-mobile-panels-git-editor-'))
  const environment = saveEnvironment()
  const userHome = join(root, 'user-home')
  const quirkyHome = join(root, 'quirky-home')
  const repoPath = join(root, 'project')
  const worktreesRoot = join(root, 'worktrees')
  for (const dir of [userHome, quirkyHome, repoPath, worktreesRoot, join(root, 'xdg-config')]) {
    mkdirSync(dir, { recursive: true })
  }
  Object.assign(process.env, {
    HOME: userHome,
    QUIRKY_HOME: quirkyHome,
    QUIRKY_MOBILE_PORT: '0',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_COUNT: '0',
    GIT_TERMINAL_PROMPT: '0',
    XDG_CONFIG_HOME: join(root, 'xdg-config')
  })
  delete process.env.QUIRKY_MOBILE_HOST
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG_PARAMETERS']) delete process.env[key]
  process.env.CODEX_HOME = join(userHome, '.codex')
  process.env.CLAUDE_CONFIG_DIR = join(userHome, '.claude')
  const store = new Store(join(quirkyHome, 'quirky.db'))
  try { store.setSettingValue('setting:quirky.agent-status/hooks', false) } finally { store.close() }

  let harness: Harness | undefined
  let phone: MobileTestClient | undefined
  try {
    runGit(repoPath, 'init', '-q', '-b', 'main')
    runGit(repoPath, 'config', 'user.name', 'Mobile Panel Test')
    runGit(repoPath, 'config', 'user.email', 'mobile-panel@example.invalid')
    runGit(repoPath, 'config', 'commit.gpgsign', 'false')
    writeFileSync(join(repoPath, 'README.md'), 'Initial project text\n')
    writeFileSync(join(repoPath, 'large.txt'), 'Initial large-file text\n')
    runGit(repoPath, 'add', '--all')
    runGit(repoPath, 'commit', '-q', '-m', 'Initial project')

    harness = await startHarness({ home: quirkyHome, builtinPluginsDir: builtinsDir() })
    const local = await harness.connect('cli', 'mobile-panels-git-editor-test')
    const repo = await local.callAny('quirky.repo/add', { path: realpathSync(repoPath) }) as { id: string }
    if (!repo.id) throw new Error('quirky.repo/add did not return a repository id')
    await local.callAny('setting.set', {
      id: 'setting:quirky.worktree/worktreesRoot',
      value: realpathSync(worktreesRoot)
    })
    const createWorktree = async (name: string, branchName: string): Promise<Worktree> => {
      const created = await local.callAny('quirky.worktree/create', {
        repo: repo.id, name, branchName, base: 'main', setup: 'skip'
      }) as { worktree: Worktree }
      if (!created.worktree?.id || !created.worktree.path) throw new Error('quirky.worktree/create did not return a worktree')
      return created.worktree
    }
    const primary = await createWorktree('mobile-main', 'mobile/main')
    const secondary = await createWorktree('mobile-other', 'mobile/other')
    runGit(primary.path, 'branch', 'release/mobile')
    runGit(primary.path, 'branch', 'release/dirty-check')

    const offer = await local.callAny('quirky.mobile/pair', { address: '127.0.0.1' }) as {
      endpoint: string
      pairingUrl: string
    }
    const code = new URL(offer.pairingUrl).searchParams.get('code')
    if (!code) throw new Error('mobile pairing offer did not include a code')
    const pairing = JSON.parse(Buffer.from(code, 'base64url').toString('utf8')) as {
      publicKeyB64: string
      deviceToken: string
    }
    phone = MobileTestClient.connect(offer.endpoint, pairing.publicKeyB64, pairing.deviceToken)
    await phone.authenticated

    const opened: Fixture = { root, environment, harness, phone, primary, secondary }
    fixture = opened
    return opened
  } catch (error) {
    try {
      await cleanupOwned(root, environment, harness, phone)
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Mobile panel fixture setup and cleanup failed')
    }
    throw error
  }
}

afterEach(async () => {
  if (!fixture) return
  const current = fixture
  fixture = undefined
  await cleanupOwned(current.root, current.environment, current.harness, current.phone)
})

async function readText(phone: MobileTestClient, bufferId: string, contentRevision: number): Promise<string> {
  const parts: string[] = []
  let offset = 0
  for (;;) {
    const chunk = await phone.call('quirky.editor/read', {
      bufferId, action: 'text', kind: 'content', offset, length: 65_536, contentRevision
    }) as { text: string; eof: boolean; nextOffset: number }
    parts.push(chunk.text)
    if (chunk.eof) return parts.join('')
    if (!Number.isSafeInteger(chunk.nextOffset) || chunk.nextOffset <= offset) throw new Error('editor text read did not advance')
    offset = chunk.nextOffset
  }
}

test('the encrypted phone source-control panel changes only its selected real worktree', async () => {
  const current = await boot()
  const { phone, primary, secondary } = current
  const file = join(primary.path, 'README.md')
  const changedText = 'Changed by the encrypted phone\n'
  writeFileSync(file, changedText)

  const [status, compare] = await Promise.all([
    phone.call('quirky.git/status', { worktree: primary.id }) as Promise<{ branch: string; head: string | null; entries: { path: string }[] }>,
    phone.call('quirky.git/compare', { worktree: primary.id }) as Promise<{ headOid: string | null }>
  ])
  expect(status.branch).toBe('mobile/main')
  expect(status.entries.map((entry) => entry.path)).toContain('README.md')
  expect(compare.headOid).toBe(status.head)

  const diff = await phone.call('quirky.git/diff', {
    worktree: primary.id, path: 'README.md', source: 'unstaged'
  }) as { source: string; original: string; modified: string }
  expect(diff).toMatchObject({ source: 'unstaged', original: 'Initial project text\n', modified: changedText })

  await phone.call('quirky.git/stage', { worktree: primary.id, paths: ['README.md'] })
  expect(runGit(primary.path, 'diff', '--cached', '--name-only').trim()).toBe('README.md')
  await phone.call('quirky.git/unstage', { worktree: primary.id, paths: ['README.md'] })
  expect(runGit(primary.path, 'diff', '--cached', '--name-only').trim()).toBe('')
  expect(runGit(primary.path, 'diff', '--name-only').trim()).toBe('README.md')
  await phone.call('quirky.git/stage', { worktree: primary.id, scope: 'all' })

  const previousHead = runGit(primary.path, 'rev-parse', 'HEAD').trim()
  await phone.call('quirky.git/commit', { worktree: primary.id, message: 'Phone source-control commit' })
  const committedHead = runGit(primary.path, 'rev-parse', 'HEAD').trim()
  expect(committedHead).not.toBe(previousHead)
  expect(runGit(primary.path, 'log', '-1', '--format=%s').trim()).toBe('Phone source-control commit')
  expect(readFileSync(file, 'utf8')).toBe(changedText)
  const committedStatus = await phone.call('quirky.git/status', { worktree: primary.id }) as { entries: { path: string }[] }
  expect(committedStatus.entries).toEqual([])

  const added = await phone.call('quirky.git/addNote', {
    worktree: primary.id, path: 'README.md', line: 1, body: 'Review this committed text'
  }) as { note: { id: string; worktreeId: string; path: string; startLine: number; line: number; body: string } }
  expect(added.note).toMatchObject({
    worktreeId: primary.id, path: 'README.md', startLine: 1, line: 1, body: 'Review this committed text'
  })
  expect((await phone.call('quirky.git/notes', { worktree: secondary.id }) as { notes: unknown[] }).notes).toEqual([])
  await expect(phone.call('quirky.git/editNote', {
    worktree: secondary.id, id: added.note.id, body: 'Cross-worktree edit must not land'
  })).rejects.toThrow()
  expect((await phone.call('quirky.git/notes', { worktree: primary.id }) as { notes: { id: string; body: string }[] }).notes)
    .toContainEqual(expect.objectContaining({ id: added.note.id, body: 'Review this committed text' }))

  const formatted = await phone.call('quirky.git/formatNotes', { worktree: primary.id }) as { text: string; count: number }
  expect(formatted.count).toBe(1)
  expect(formatted.text).toContain(added.note.path)
  expect(formatted.text).toContain(added.note.body)
  await phone.call('quirky.git/editNote', {
    worktree: primary.id, id: added.note.id, body: 'Reviewed and updated from mobile'
  })
  expect((await phone.call('quirky.git/notes', { worktree: primary.id }) as { notes: { id: string; body: string }[] }).notes)
    .toContainEqual(expect.objectContaining({ id: added.note.id, body: 'Reviewed and updated from mobile' }))
  await phone.call('quirky.git/deleteNote', { worktree: primary.id, id: added.note.id })
  expect((await phone.call('quirky.git/notes', { worktree: primary.id }) as { notes: unknown[] }).notes).toEqual([])

  const branches = await phone.call('quirky.git/branches', { worktree: primary.id }) as {
    refs: { name: string; kind: string }[]
  }
  expect(branches.refs).toContainEqual({ name: 'release/mobile', kind: 'local' })
  const switchStatus = await phone.call('quirky.git/status', { worktree: primary.id }) as {
    branch: string | null; head: string | null
  }
  const description = await phone.call('quirky.git/describeSwitchBranch', {
    worktree: primary.id, branch: 'release/mobile'
  })
  expect(description).toContain('release/mobile')
  await phone.call('quirky.git/switchBranch', {
    worktree: primary.id,
    branch: 'release/mobile',
    yes: true,
    ...(switchStatus.branch === null ? {} : { expectedBranch: switchStatus.branch }),
    ...(switchStatus.head === null ? {} : { expectedHead: switchStatus.head })
  })
  expect(runGit(primary.path, 'branch', '--show-current').trim()).toBe('release/mobile')

  writeFileSync(file, 'Dirty work must stay on the current branch\n')
  const dirtyStatus = await phone.call('quirky.git/status', { worktree: primary.id }) as {
    branch: string | null; head: string | null
  }
  await expect(phone.call('quirky.git/describeSwitchBranch', {
    worktree: primary.id, branch: 'release/dirty-check'
  })).rejects.toThrow()
  await expect(phone.call('quirky.git/switchBranch', {
    worktree: primary.id,
    branch: 'release/dirty-check',
    yes: true,
    ...(dirtyStatus.branch === null ? {} : { expectedBranch: dirtyStatus.branch }),
    ...(dirtyStatus.head === null ? {} : { expectedHead: dirtyStatus.head })
  })).rejects.toThrow()
  expect(runGit(primary.path, 'branch', '--show-current').trim()).toBe('release/mobile')
  expect(readFileSync(file, 'utf8')).toBe('Dirty work must stay on the current branch\n')

  for (const injection of [
    { identity: { role: 'cli' } },
    { deviceId: 'unknown-device' },
    { scope: 'all' }
  ]) {
    await expect(phone.call('quirky.git/status', { worktree: primary.id, ...injection })).rejects.toThrow()
  }
  await expect(phone.call('quirky.git/status', { worktree: 'wt_unknown_mobile_scope' })).rejects.toThrow()
  await expect(phone.call('quirky.git/status', { worktree: primary.id }, { deviceToken: 'unknown-device-token' })).rejects.toThrow()
}, 60_000)

test('the encrypted phone editor reads and CAS-saves contained files without gaining create or import powers', async () => {
  const current = await boot()
  const { phone, primary, root } = current
  const listing = await phone.call('quirky.editor/explorer', {
    worktree: primary.id, action: 'list'
  }) as { root: string; entries: { name: string }[] }
  expect(listing.root).toBe(primary.path)
  expect(listing.entries.map((entry) => entry.name)).toContain('README.md')

  const opened = await phone.call('quirky.editor/open', {
    worktree: primary.id, path: 'README.md', preview: true, pinned: false, focus: false, mode: 'source'
  }) as { id: string; relativePath: string; contentRevision: number }
  expect(opened.relativePath).toBe('README.md')
  expect(await readText(phone, opened.id, opened.contentRevision)).toBe('Initial project text\n')

  const savedText = 'Saved through the contained mobile buffer\n'
  const draft = await phone.call('quirky.editor/draft', {
    bufferId: opened.id, content: savedText, expectedRevision: opened.contentRevision
  }) as { id: string; contentRevision: number; dirty: boolean }
  expect(draft).toMatchObject({ id: opened.id, dirty: true })
  expect(draft.contentRevision).toBeGreaterThan(opened.contentRevision)
  const saved = await phone.call('quirky.editor/save', { bufferId: opened.id, trigger: 'user' }) as {
    id: string; dirty: boolean
  }
  expect(saved).toMatchObject({ id: opened.id, dirty: false })
  expect(readFileSync(join(primary.path, 'README.md'), 'utf8')).toBe(savedText)

  const outsideFile = join(root, 'outside-secret.txt')
  const outsideText = 'must remain outside the worktree\n'
  writeFileSync(outsideFile, outsideText)
  const escapePath = relative(primary.path, outsideFile).split(sep).join('/')
  await expect(phone.call('quirky.editor/explorer', {
    worktree: primary.id, action: 'list', path: escapePath
  })).rejects.toThrow()
  await expect(phone.call('quirky.editor/open', {
    worktree: primary.id, path: escapePath, preview: true, pinned: false, focus: false, mode: 'source'
  })).rejects.toThrow()
  expect(readFileSync(outsideFile, 'utf8')).toBe(outsideText)
  await expect(phone.call('quirky.editor/read', {
    bufferId: 'buffer_from_another_identity',
    action: 'text', kind: 'content', offset: 0, length: 65_536, contentRevision: 0
  })).rejects.toThrow()

  const createdPath = join(primary.path, 'phone-created.txt')
  await expect(phone.call('quirky.editor/mutate', {
    worktree: primary.id, action: 'createFile', path: 'phone-created.txt', content: 'must not be created\n'
  })).rejects.toThrow()
  await expect(phone.call('quirky.editor/mutate', {
    worktree: primary.id,
    action: 'import',
    path: '.',
    files: [{ name: 'phone-imported.txt', data: Buffer.from('must not be imported').toString('base64') }]
  })).rejects.toThrow()
  await expect(phone.call('quirky.editor/transfer', {
    action: 'begin', kind: 'createFile', worktree: primary.id, path: 'phone-transfer-created.txt', totalBytes: 0
  })).rejects.toThrow()
  await expect(phone.call('quirky.editor/transfer', {
    action: 'begin', kind: 'import', worktree: primary.id, path: '.', name: 'phone-transfer-imported.txt', totalBytes: 0
  })).rejects.toThrow()
  expect(existsSync(createdPath)).toBe(false)
  expect(existsSync(join(primary.path, 'phone-imported.txt'))).toBe(false)
  expect(existsSync(join(primary.path, 'phone-transfer-created.txt'))).toBe(false)
  expect(existsSync(join(primary.path, 'phone-transfer-imported.txt'))).toBe(false)
}, 60_000)

test('the encrypted phone saves large Unicode drafts in bounded decoded chunks', async () => {
  const current = await boot()
  const { phone, primary } = current
  const opened = await phone.call('quirky.editor/open', {
    worktree: primary.id, path: 'large.txt', preview: true, pinned: false, focus: false, mode: 'source'
  }) as { id: string; relativePath: string; contentRevision: number }
  expect(opened.relativePath).toBe('large.txt')
  expect(await readText(phone, opened.id, opened.contentRevision)).toBe('Initial large-file text\n')

  const content = ('mobile 🧭 café — 日本語\n').repeat(5000)
  const bytes = new TextEncoder().encode(content)
  expect(bytes.byteLength).toBeGreaterThan(64 * 1024)
  const begin = await phone.call('quirky.editor/transfer', {
    action: 'begin', kind: 'draft', bufferId: opened.id,
    expectedRevision: opened.contentRevision, totalBytes: bytes.byteLength
  }) as { transferId: string; offset: number; maxChunkBytes: number }
  expect(begin.offset).toBe(0)
  const chunkLimit = Math.min(48 * 1024, begin.maxChunkBytes)
  expect(chunkLimit).toBeGreaterThan(0)

  let offset = 0
  while (offset < bytes.byteLength) {
    const part = bytes.subarray(offset, Math.min(offset + chunkLimit, bytes.byteLength))
    const data = Buffer.from(part).toString('base64')
    const decoded = Buffer.from(data, 'base64')
    expect(decoded.byteLength).toBeLessThanOrEqual(48 * 1024)
    expect(decoded).toEqual(Buffer.from(part))
    const nextOffset = offset + decoded.byteLength
    const acknowledgement = await phone.call('quirky.editor/transfer', {
      action: 'chunk', transferId: begin.transferId, offset, data
    }) as { transferId: string; offset: number; nextOffset: number }
    expect(acknowledgement).toMatchObject({ transferId: begin.transferId, offset: nextOffset, nextOffset })
    offset = nextOffset
  }
  expect(offset).toBe(bytes.byteLength)

  const committed = await phone.call('quirky.editor/transfer', {
    action: 'commit', transferId: begin.transferId
  }) as { id: string; contentRevision: number; dirty: boolean }
  expect(committed).toMatchObject({ id: opened.id, dirty: true })
  expect(committed.contentRevision).toBeGreaterThan(opened.contentRevision)
  const saved = await phone.call('quirky.editor/save', { bufferId: opened.id, trigger: 'user' }) as {
    id: string; dirty: boolean
  }
  expect(saved).toMatchObject({ id: opened.id, dirty: false })
  const diskBytes = readFileSync(join(primary.path, 'large.txt'))
  expect(diskBytes).toEqual(Buffer.from(bytes))
  expect(diskBytes.toString('utf8')).toBe(content)
}, 60_000)
