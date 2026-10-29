import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RpcErrorCode, type WorktreeCreateResult } from '@quirky/protocol'
import { call, failure, git, isolateGitConfig } from '../../quirky.repo/test/git-fixtures'
import { githubUser, makeOrigin, makeProject, startWorld, useGlobalGitConfig, type World } from './fixtures/repos'

const { scratch } = isolateGitConfig()
let world: World | undefined
beforeEach(() => useGlobalGitConfig(scratch, githubUser('zoe')))
afterEach(async () => {
  await world?.t.cleanup()
  world = undefined
})

async function startRepo(files: Record<string, string> = { 'a.txt': 'one\n' }) {
  world = await startWorld('fake')
  const origin = makeOrigin(join(scratch(), 'create-parity-origin.git'), { files })
  const dir = makeProject(join(scratch(), 'create-parity-project'), { origin })
  const repo = await world.add(dir)
  return { ...world, origin, dir, repo }
}

const create = (params: Record<string, unknown>) => call(world!.client, 'quirky.worktree/create', params) as Promise<WorktreeCreateResult & { creationReceipt?: Record<string, unknown> }>
const worktreeCount = (dir: string) => git(dir, 'worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree ')).length

describe('worktree create parity boundaries', () => {
  test('sparse paths are validated before worktree creation and selected files are materialized', async () => {
    const { dir, repo } = await startRepo({ 'README.md': 'root\n', 'src/app.ts': 'export {}\n', 'docs/guide.md': 'guide\n' })

    for (const sparsePaths of [['../outside'], ['missing']]) {
      const refused = await failure(create({ repo: repo.id, name: 'refused', sparsePaths }))
      expect(refused.code).toBe(RpcErrorCode.InvalidParams)
      expect(worktreeCount(dir)).toBe(1)
      expect(existsSync(join(dir, '..', 'outside'))).toBe(false)
    }

    const result = await create({ repo: repo.id, name: 'source-only', sparsePaths: ['src'] })
    expect(result.worktree.path).toBe(join(world!.root, 'create-parity-project', 'source-only'))
    expect(existsSync(join(result.worktree.path, 'src', 'app.ts'))).toBe(true)
    expect(existsSync(join(result.worktree.path, 'docs', 'guide.md'))).toBe(false)
    expect(result.creationReceipt).toMatchObject({ sparsePaths: ['src'] })
  })

  test('keep-main fast-forwards only the exact clean primary branch to its fetched remote base', async () => {
    const { dir, origin, repo } = await startRepo()
    const advance = join(scratch(), 'create-parity-advance')
    git(scratch(), 'clone', '-q', origin, advance)
    git(advance, 'config', 'user.name', 'Test')
    git(advance, 'config', 'user.email', 'test@example.com')
    writeFileSync(join(advance, 'a.txt'), 'two\n')
    git(advance, 'add', 'a.txt')
    git(advance, 'commit', '-q', '-m', 'advance main')
    git(advance, 'push', '-q', 'origin', 'main')

    const result = await create({ repo: repo.id, name: 'from-updated-main', keepMain: true })
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(git(dir, 'rev-parse', 'refs/remotes/origin/main'))
    expect(result.creationReceipt).toMatchObject({ main: { status: 'fast-forwarded' } })
  })

  test('keep-main leaves a dirty primary checkout untouched and reports no behind claim', async () => {
    const { dir, origin, repo } = await startRepo()
    const advance = join(scratch(), 'create-parity-dirty-advance')
    git(scratch(), 'clone', '-q', origin, advance)
    git(advance, 'config', 'user.name', 'Test')
    git(advance, 'config', 'user.email', 'test@example.com')
    writeFileSync(join(advance, 'a.txt'), 'two\n')
    git(advance, 'add', 'a.txt')
    git(advance, 'commit', '-q', '-m', 'advance main')
    git(advance, 'push', '-q', 'origin', 'main')
    writeFileSync(join(dir, 'local.txt'), 'uncommitted\n')
    const before = git(dir, 'rev-parse', 'HEAD')

    const result = await create({ repo: repo.id, name: 'dirty-primary', keepMain: true })
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(before)
    expect(result.creationReceipt).toMatchObject({ main: { status: 'not-updated', reason: 'primary-checkout-dirty' } })
  })
  test('keep-main does not claim or update a clean primary branch that does not match the remote base', async () => {
    const { dir, repo } = await startRepo()
    git(dir, 'checkout', '-q', '-b', 'other-primary')
    const before = git(dir, 'rev-parse', 'HEAD')

    const result = await create({ repo: repo.id, name: 'mismatched-primary', base: 'origin/main', keepMain: true })
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(before)
    expect(result.creationReceipt).toMatchObject({
      main: { status: 'not-updated', reason: 'primary-branch-does-not-match-selected-base' }
    })
  })

  test('invalid recipe, tab and launch selections fail before canonical worktree mutation', async () => {
    const { dir, repo } = await startRepo({
      'a.txt': 'one\n',
      'orca.yaml': [
        'defaultTabs:',
        '  - title: Build',
        '    command: pnpm build',
        'environmentRecipes:',
        '  - id: devbox',
        '    name: Development VM',
        '    create: vm create',
        '    checkoutMode: provisioned-root'
      ].join('\n') + '\n'
    })
    for (const unsupported of [
      { environmentRecipe: 'missing' },
      { defaultTabs: ['2'] },
      { agent: 'claude', model: '' },
      { agent: 'claude', model: 'model-name', options: { effort: 42 } }
    ]) {
      const refused = await failure(create({ repo: repo.id, name: 'refused', ...unsupported }))
      expect(refused.code).toBe(RpcErrorCode.InvalidParams)
      expect(worktreeCount(dir)).toBe(1)
    }


    const launchUnavailable = await failure(create({
      repo: repo.id,
      name: 'launch-unavailable',
      agent: 'claude',
      model: 'model-name',
      options: { effort: 'high' }
    }))
    expect(launchUnavailable.code).toBe(RpcErrorCode.Conflict)
    expect(worktreeCount(dir)).toBe(1)
  })

})
