import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RpcErrorCode } from '@quirky/protocol'
import { git } from '../../../quirky.repo/test/git-fixtures'
import { isolateScenarioGit, jsonError, startScenario, type Scenario } from './fixture'

const { scratch } = isolateScenarioGit()
let s: Scenario | undefined
afterEach(async () => {
  globalThis.__QUIRKY_TEST_REVEAL__ = undefined
  await s?.cleanup()
  s = undefined
})

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
const read = (rel: string) => readFileSync(join(s!.feat.path, rel), 'utf8')

describe('save', () => {
  test('SC-61: a save with the hash it read writes the file, and a stale hash is refused (CLI)', async () => {
    s = await startScenario(scratch)
    const hash = sha256('a\nb\nc\nd\ne\n')
    const first = JSON.parse((await s.cli(['git', 'save', '--path', 'math.ts', '--content', 'mine\n', '--expected', hash, '--json'])).stdout)
    expect(first).toEqual({ hash: sha256('mine\n') })
    expect(read('math.ts')).toBe('mine\n')

    s.write('math.ts', 'rewritten by an agent\n')
    const stale = await s.cli(['git', 'save', '--path', 'math.ts', '--content', 'again\n', '--expected', first.hash, '--json'])
    expect(stale.code).toBe(1)
    expect(jsonError(stale)).toMatchObject({ code: 'conflict', reason: 'changed-on-disk' })
    expect(read('math.ts')).toBe('rewritten by an agent\n')
  })

  test('without expected the file is overwritten, a missing file is created, and each save announces one change', async () => {
    s = await startScenario(scratch)
    const before = s.changedEvents()
    expect(await s.api('save', { path: 'math.ts', content: 'x\n' })).toEqual({ hash: sha256('x\n') })
    expect(await s.api('save', { path: 'fresh.txt', content: 'y\n' })).toEqual({ hash: sha256('y\n') })
    expect(read('fresh.txt')).toBe('y\n')
    await Bun.sleep(80)
    expect(s.changedEvents()).toBe(before + 2)

    const refused = await s.fails(s.api('save', { path: 'missing.txt', content: 'z\n', expected: sha256('old') }))
    expect(refused).toMatchObject({ code: RpcErrorCode.Conflict, data: { reason: 'changed-on-disk' } })
    expect(existsSync(join(s.feat.path, 'missing.txt'))).toBe(false)
    await Bun.sleep(60)
    expect(s.changedEvents()).toBe(before + 2)
  })
})

describe('paths never escape the worktree', () => {
  test('SC-67: a symlinked file is never read or written through, and a symlinked folder leads nowhere', async () => {
    s = await startScenario(scratch)
    const outside = join(scratch(), 'outside')
    mkdirSync(outside, { recursive: true })
    const secret = join(outside, 'secret.txt')
    writeFileSync(secret, 'TOP SECRET\n')
    symlinkSync(secret, join(s.feat.path, 'link.txt'))
    git(s.feat.path, 'add', 'link.txt')
    git(s.feat.path, 'commit', '-q', '-m', 'link')
    symlinkSync(outside, join(s.feat.path, 'out'))

    const diff = await s.api('diff', { path: 'link.txt', source: 'unstaged' })
    expect(diff.modified).toBe(secret)
    expect(JSON.stringify(diff)).not.toContain('TOP SECRET')

    for (const [method, params] of [
      ['conflictFile', { path: 'link.txt' }],
      ['save', { path: 'link.txt', content: 'overwritten\n' }]
    ] as const) {
      expect(await s.fails(s.api(method, params))).toMatchObject({ code: RpcErrorCode.InvalidParams, data: { reason: 'not-allowed' } })
    }
    const through: [string, Record<string, unknown>][] = [
      ['diff', { path: 'out/x.txt' }],
      ['conflictFile', { path: 'out/x.txt' }],
      ['save', { path: 'out/x.txt', content: 'planted\n' }],
      ['discard', { paths: ['out/x.txt'], yes: true }],
      ['reveal', { path: 'out/x.txt' }],
      ['submoduleStatus', { path: 'out/x.txt' }]
    ]
    for (const [method, params] of through) {
      expect(await s.fails(s.api(method, params))).toMatchObject({ code: RpcErrorCode.InvalidParams, data: { reason: 'outside-worktree' } })
    }
    expect(readFileSync(secret, 'utf8')).toBe('TOP SECRET\n')
    expect(existsSync(join(outside, 'x.txt'))).toBe(false)
  })
})

describe('huge folders', () => {
  test('SC-58 and SC-59: only unignored dependency folders are offered, and ignoring one appends it once', async () => {
    s = await startScenario(scratch)
    s.write('node_modules/pkg/index.js', 'x\n')
    s.write('dist/out.js', 'x\n')
    s.write('.gitignore', 'dist/')

    const listed = JSON.parse((await s.cli(['git', 'hugeFolders', '--json'])).stdout)
    expect(listed).toEqual({ folders: ['node_modules'] })

    const before = s.changedEvents()
    const added = JSON.parse((await s.cli(['git', 'ignoreFolder', '--folder', 'node_modules', '--json'])).stdout)
    expect(added).toEqual({ ok: true, added: true })
    expect(read('.gitignore')).toBe('dist/\nnode_modules/\n')
    expect((await s.api('ignoreFolder', { folder: 'node_modules' })).added).toBe(false)
    expect(read('.gitignore')).toBe('dist/\nnode_modules/\n')
    expect(await s.api('hugeFolders')).toEqual({ folders: [] })
    await Bun.sleep(80)
    expect(s.changedEvents()).toBe(before + 2)
  })

  test('SC-59: a folder off the allowlist is refused (CLI)', async () => {
    s = await startScenario(scratch)
    const refused = await s.cli(['git', 'ignoreFolder', '--folder', '../etc', '--json'])
    expect(refused.code).toBe(1)
    expect(jsonError(refused)).toMatchObject({ code: 'invalid-params', reason: 'not-allowed' })
    expect(existsSync(join(s.feat.path, '.gitignore'))).toBe(false)
  })
})

describe('reveal', () => {
  test('shows the absolute path in Finder and refuses a path that climbs out', async () => {
    s = await startScenario(scratch)
    const revealed: string[] = []
    globalThis.__QUIRKY_TEST_REVEAL__ = (path) => {
      revealed.push(path)
    }
    expect(await s.api('reveal', { path: 'src/../math.ts' })).toEqual({ ok: true })
    expect(revealed).toEqual([join(s.feat.path, 'math.ts')])
    expect(await s.fails(s.api('reveal', { path: '../x' }))).toMatchObject({ data: { reason: 'outside-worktree' } })
    expect(await s.fails(s.api('reveal', { path: join(s.feat.path, 'math.ts') }))).toMatchObject({ data: { reason: 'outside-worktree' } })
    expect(revealed).toHaveLength(1)
  })
})
