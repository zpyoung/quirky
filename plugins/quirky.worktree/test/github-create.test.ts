import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { Worktree, WorktreeCreateResult } from '@quirky/protocol'
import { startGithubWorld, makePull, type GithubWorld } from './github-fixtures/world'

let world: GithubWorld | undefined
afterEach(async () => {
  await world?.cleanup()
  world = undefined
})

const create = (params: Record<string, unknown>) => world!.call('quirky.worktree/create', { repo: world!.repo.id, ...params }) as Promise<WorktreeCreateResult>
const git = (cwd: string, ...args: string[]) => {
  const result = Bun.spawnSync(['git', ...args], { cwd, env: process.env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`)
  return result.stdout.toString().trim()
}

function registered(worktrees: unknown, name: string): Worktree {
  if (!Array.isArray(worktrees)) throw new Error('expected a worktree list')
  const value = worktrees.find((entry) => typeof entry === 'object' && entry !== null && 'name' in entry && entry.name === name)
  if (!value) throw new Error(`worktree ${name} was not listed`)
  return value as Worktree
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function tabsIn(node: unknown): Record<string, unknown>[] {
  const current = record(node)
  if (!current) return []
  if (current.kind === 'group' && Array.isArray(current.tabs)) return current.tabs.map(record).filter((tab): tab is Record<string, unknown> => tab !== null)
  if (current.kind === 'split') return [...tabsIn(current.first), ...tabsIn(current.second)]
  return []
}

function sessionsIn(node: unknown): string[] {
  const current = record(node)
  if (!current) return []
  if (current.kind === 'pane' && typeof current.session === 'string') return [current.session]
  if (current.kind === 'split') return [...sessionsIn(current.first), ...sessionsIn(current.second)]
  return []
}

describe('GitHub worktree creation', () => {
  test('checks out a fork PR head exactly and pushes only to its fork remote', async () => {
    world = await startGithubWorld()
    world.setPull({ ...world.state.pulls['3']!, maintainer_can_modify: false })
    const before = await world.call('ui.state')
    const made = await create({ github: '#3' })
    const expectedRef = `refs/quirky/pull/${createHash('sha256').update(world.baseUrl).digest('hex')}/3`
    expect(made.worktree).toMatchObject({
      branch: 'feature/conflict',
      displayName: 'Reword the README',
      name: 'Reword the README',
      path: join(world.worktreesRoot, 'project', 'Reword-the-README'),
      comment: 'PR #3 — Reword the README',
      baseRef: 'origin/main',
      keepBranch: false,
      linkedPR: {
        provider: 'github', kind: 'pullRequest', number: 3,
        title: 'Reword the README', url: 'https://github.com/test-owner/test-repo/pull/3',
        repository: { host: 'github.com', owner: 'test-owner', repo: 'test-repo' }
      },
      pushTarget: { remoteName: 'pr-fork-owner-fork-repo', branchName: 'feature/conflict', maintainerCanModify: false }
    })
    expect(git(made.worktree.path, 'rev-parse', 'HEAD')).toBe(git(world.forkBare, 'rev-parse', 'refs/heads/feature/conflict'))
    expect(git(world.project, 'rev-parse', expectedRef)).toBe(git(made.worktree.path, 'rev-parse', 'HEAD'))
    expect(git(world.project, 'config', '--get', 'branch.feature/conflict.pushRemote')).toBe('pr-fork-owner-fork-repo')
    expect(git(world.project, 'config', '--get', 'branch.feature/conflict.remote')).toBe('pr-fork-owner-fork-repo')
    expect(git(world.project, 'config', '--get', 'branch.feature/conflict.merge')).toBe('refs/heads/feature/conflict')
    expect(git(world.project, 'config', '--get', 'remote.pr-fork-owner-fork-repo.url')).toBe(world.forkUrl)
    expect(await world.call('ui.state')).toEqual(before)

    writeFileSync(join(made.worktree.path, 'pushed.txt'), 'only fork\n')
    git(made.worktree.path, 'add', 'pushed.txt')
    git(made.worktree.path, 'commit', '--quiet', '-m', 'push to fork')
    const pushedHead = git(made.worktree.path, 'rev-parse', 'HEAD')
    git(made.worktree.path, 'push', '--quiet')
    expect(git(world.forkBare, 'rev-parse', 'refs/heads/feature/conflict')).toBe(pushedHead)
    expect(git(world.baseBare, 'rev-parse', 'refs/pull/3/head')).not.toBe(pushedHead)
    expect(git(world.baseBare, 'branch', '--list', 'feature/conflict')).toBe('')
  })

  test('creates from the HTTPS PR URL and preserves durable link metadata after daemon restart', async () => {
    world = await startGithubWorld({ originScheme: 'https' })
    const viewBefore = await world.call('ui.state')
    const outcome = await world.cli(['worktree', 'create', '--repo', world.repo.id, '--github', 'https://github.com/test-owner/test-repo/pull/3', '--json'])
    expect({ code: outcome.code, stderr: outcome.stderr }).toEqual({ code: 0, stderr: '' })
    const result = JSON.parse(outcome.stdout) as WorktreeCreateResult
    expect(result.worktree.branch).toBe('feature/conflict')
    expect(result.worktree.linkedPR?.number).toBe(3)
    expect(result.worktree.pushTarget?.branchName).toBe('feature/conflict')
    expect(git(world.project, 'config', '--get', 'remote.pr-fork-owner-fork-repo.url')).toBe(world.forkUrl)
    expect(await world.call('ui.state')).toEqual(viewBefore)
    await world.restart()
    const listed = await world.call('quirky.worktree/list', { repo: world.repo.id })
    const durable = registered(listed, result.worktree.name)
    expect(durable).toMatchObject({
      linkedPR: result.worktree.linkedPR,
      pushTarget: result.worktree.pushTarget
    })
    expect((await world.call('quirky.worktree/resolve', { selector: `id:${durable.id}` })).toMatchObject({ linkedPR: durable.linkedPR, pushTarget: durable.pushTarget }))
    const detail = await world.cli(['worktree', 'show', `id:${durable.id}`])
    expect(detail.code).toBe(0)
    expect(detail.stdout).toContain('#3 Reword the README')
    expect(detail.stdout).toContain('push target: pr-fork-owner-fork-repo/feature/conflict')
  })

  test('a PR remote URL change uses a distinct URL-scoped ref and the fresh head, never the prior repository ref', async () => {
    world = await startGithubWorld()
    const first = await create({ github: '#3' })
    const secondItem = makePull(world.state.pulls['3']!, {
      title: 'Reword the README',
      html_url: 'https://github.com/other-owner/other-repo/pull/3',
      head: { ref: 'feature/new', sha: git(world.secondBaseBare, 'rev-parse', 'refs/pull/3/head'), repo: { name: 'fork-repo', owner: { login: 'fork-owner' }, html_url: 'https://github.com/fork-owner/fork-repo' } },
      base: { ref: 'main', sha: git(world.secondBaseBare, 'rev-parse', 'refs/heads/main'), repo: { name: 'other-repo', owner: { login: 'other-owner' }, html_url: 'https://github.com/other-owner/other-repo' } }
    })
    world.repointToSecond(secondItem)
    const second = await create({ github: '#3' })
    expect(first.worktree.head).not.toBe(second.worktree.head)
    expect(second.worktree).toMatchObject({
      branch: 'feature/new',
      name: 'Reword the README',
      displayName: 'Reword the README',
      path: join(world.worktreesRoot, 'project', 'Reword-the-README-2'),
      linkedPR: { repository: { owner: 'other-owner', repo: 'other-repo' } },
      baseRef: 'origin/main'
    })
    const refs = git(world.project, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/quirky/pull').split('\n')
    expect(refs).toHaveLength(2)
    expect(refs.map((line) => line.split(' ')[0])).toContain(`refs/quirky/pull/${createHash('sha256').update(world.baseUrl).digest('hex')}/3`)
    expect(refs.map((line) => line.split(' ')[0])).toContain(`refs/quirky/pull/${createHash('sha256').update(world.secondBaseUrl).digest('hex')}/3`)
    expect(git(second.worktree.path, 'rev-parse', 'HEAD')).toBe(git(world.secondBaseBare, 'rev-parse', 'refs/pull/3/head'))
  })

  test('refuses moved PR heads and invalid GitHub modes without creating or mutating a branch', async () => {
    world = await startGithubWorld()
    const original = world.state.pulls['3']!
    world.setPull(makePull(original, { head: { ...original.head, sha: 'f'.repeat(40) } }))
    await expect(create({ github: '#3' })).rejects.toThrow(/head.*changed|head.*move|does not match/i)
    expect(git(world.project, 'branch', '--list', 'feature/conflict')).toBe('')
    expect(git(world.project, 'worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree '))).toHaveLength(1)

    world.setPull(original)
    await expect(create({ github: '#3', branch: 'feature/conflict' })).rejects.toBeDefined()
    await expect(create({ github: '#3', branchName: 'custom' })).rejects.toBeDefined()
    await expect(create({ github: '#3', base: 'main' })).rejects.toBeDefined()
    await expect(world.call('quirky.worktree/create', { group: 'unknown', github: '#3' })).rejects.toBeDefined()
    await expect(create({ github: 'https://example.invalid/owner/repo/pull/3' })).rejects.toBeDefined()
    expect(git(world.project, 'branch', '--list', 'feature/conflict')).toBe('')
  })

  test('refuses an unauthenticated GitHub source without creating a worktree', async () => {
    world = await startGithubWorld({ authenticated: false })
    await expect(create({ github: '#3' })).rejects.toBeDefined()
    expect(git(world.project, 'branch', '--list', 'feature/conflict')).toBe('')
    expect(git(world.project, 'worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree '))).toHaveLength(1)
  })
  test('an issue title supplies the default label, folder, note, and prefixed branch', async () => {
    world = await startGithubWorld()
    const made = await create({ github: '#4' })
    expect(made.worktree).toMatchObject({
      branch: 'fixture-user/Add-a-multiply-function',
      name: 'Add a multiply function',
      displayName: 'Add a multiply function',
      path: join(world.worktreesRoot, 'project', 'Add-a-multiply-function'),
      comment: 'Issue #4 — Add a multiply function',
      baseRef: 'origin/main',
      linkedIssue: { provider: 'github', kind: 'issue', number: 4, title: 'Add a multiply function' }
    })
    expect(made.issueCommand).toEqual({ ran: 'none' })
  })
  test('issue commands are independently trusted at the selected commit, interpolated safely, and skippable', async () => {
    world = await startGithubWorld()
    world.setIssue({ ...world.state.issues['4']!, title: '$(touch title-executed.txt)' })
    const script = `printf '%s|%s|%s' '{{issue}}' '{{artifact_url}}' '{{title}}' > issue-values.txt`
    writeFileSync(join(world.project, 'quirky.yaml'), `issueCommand: ${JSON.stringify(script)}\n`)
    git(world.project, 'add', 'quirky.yaml')
    git(world.project, 'commit', '--quiet', '-m', 'add issue command')
    git(world.project, 'push', '--quiet', 'origin', 'main')
    git(world.project, 'fetch', '--quiet', 'origin')
    git(world.project, 'checkout', '--quiet', '-b', 'issue-base')
    writeFileSync(join(world.project, 'issue-base-only.txt'), 'selected issue base\n')
    git(world.project, 'add', 'issue-base-only.txt')
    git(world.project, 'commit', '--quiet', '-m', 'issue base')
    git(world.project, 'push', '--quiet', 'origin', 'issue-base')
    git(world.project, 'checkout', '--quiet', 'main')
    git(world.project, 'fetch', '--quiet', 'origin')
    await world.call('quirky.repo/set', { repo: world.repo.id, setupPolicy: 'run-by-default', setupScript: 'touch setup-ran.txt' })
    const refused = await world.call('quirky.worktree/create', { repo: world.repo.id, github: '#4', setup: 'run', trustSetup: true }).then(
      () => null,
      (error) => error as { data?: Record<string, unknown>; message?: string }
    )
    expect(refused?.data).toMatchObject({ reason: 'hooks-untrusted', kind: 'issue' })
    expect(refused?.message).toContain('kind issue')
    expect(git(world.project, 'branch', '--list', 'fixture-user/*')).toBe('')
    expect((await world.call('quirky.worktree/list', { repo: world.repo.id }) as Worktree[])).toHaveLength(1)
    await expect(create({ github: '#4', branch: 'main' })).rejects.toBeDefined()

    const oneShotCli = await world.cli(['worktree', 'create', '--repo', world.repo.id, '--github', '#4', '--setup', 'run', '--trust-issue-command', '--json'])
    expect({ code: oneShotCli.code, stderr: oneShotCli.stderr }).toEqual({ code: 0, stderr: '' })
    const oneShot = JSON.parse(oneShotCli.stdout) as WorktreeCreateResult
    expect(oneShot.issueCommand).toMatchObject({ ran: 'daemon', exitCode: 0, timedOut: false })
    const mainHooks = await world.call('quirky.repo/hooks', { repo: world.repo.id, ref: git(world.project, 'rev-parse', 'origin/main') }) as { issueCommand?: { shared?: { trusted: boolean } | null } }
    expect(mainHooks.issueCommand?.shared?.trusted).toBe(false)
    const skippedCli = await world.cli(['worktree', 'create', '--repo', world.repo.id, '--github', '#4', '--issue-command', 'skip', '--json'])
    expect({ code: skippedCli.code, stderr: skippedCli.stderr }).toEqual({ code: 0, stderr: '' })
    const skipped = JSON.parse(skippedCli.stdout) as WorktreeCreateResult
    expect(skipped.issueCommand).toEqual({ ran: 'skipped' })
    expect(existsSync(join(skipped.worktree.path, 'issue-values.txt'))).toBe(false)

    const hooksRef = git(world.project, 'rev-parse', 'origin/issue-base')
    const details = await world.call('quirky.repo/hooks', { repo: world.repo.id, ref: hooksRef }) as { issueCommand?: { shared?: { hash: string } | null } }
    const hash = details.issueCommand?.shared?.hash
    expect(hash).toMatch(/^[a-f0-9]{64}$/)
    await world.call('quirky.repo/trustHooks', { repo: world.repo.id, kind: 'issue', ref: hooksRef })
    const made = await world.call('quirky.worktree/create', {
      repo: world.repo.id,
      github: '#4',
      name: 'custom-issue-folder',
      branchName: 'issue/four',
      displayName: 'Issue Four',
      comment: '',
      base: 'origin/issue-base',
      setup: 'run'
    }) as WorktreeCreateResult
    expect(made.worktree).toMatchObject({
      branch: 'issue/four',
      name: 'Issue Four',
      displayName: 'Issue Four',
      comment: '',
      linkedIssue: { provider: 'github', kind: 'issue', number: 4, title: '$(touch title-executed.txt)' },
      baseRef: 'origin/issue-base',
    })
    expect(existsSync(join(made.worktree.path, 'issue-base-only.txt'))).toBe(true)
    expect(made.issueCommand).toMatchObject({ ran: 'daemon', exitCode: 0, timedOut: false })
    expect(readFileSync(join(made.worktree.path, 'issue-values.txt'), 'utf8')).toBe('4|https://github.com/test-owner/test-repo/issues/4|{{title}}')
    expect(existsSync(join(made.worktree.path, 'title-executed.txt'))).toBe(false)
    expect(existsSync(join(made.worktree.path, 'setup-ran.txt'))).toBe(true)
    const changedScript = script.replace('issue-values.txt', 'changed-issue-values.txt')
    git(world.project, 'checkout', '--quiet', 'issue-base')
    writeFileSync(join(world.project, 'quirky.yaml'), `issueCommand: ${JSON.stringify(changedScript)}\n`)
    git(world.project, 'add', 'quirky.yaml')
    git(world.project, 'commit', '--quiet', '-m', 'change issue command')
    git(world.project, 'push', '--quiet', 'origin', 'issue-base')
    git(world.project, 'fetch', '--quiet', 'origin')
    git(world.project, 'checkout', '--quiet', 'main')
    const changedRef = git(world.project, 'rev-parse', 'origin/issue-base')
    const changed = await world.call('quirky.worktree/create', {
      repo: world.repo.id,
      github: '#4',
      base: 'origin/issue-base',
      branchName: 'changed/four'
    }).then(() => null, (error) => error as { data?: Record<string, unknown>; message?: string })
    expect(changed?.data).toMatchObject({ reason: 'hooks-untrusted', kind: 'issue', changed: true, ref: changedRef })
    expect(changed?.message).toContain(`--ref ${changedRef}`)
    expect(git(world.project, 'branch', '--list', 'changed/four')).toBe('')
  })

  test('reuses a matching PR branch and preserves it when the worktree is removed', async () => {
    world = await startGithubWorld()
    const expected = git(world.baseBare, 'rev-parse', 'refs/pull/3/head')
    git(world.project, 'fetch', '--quiet', 'origin', '+refs/pull/3/head:refs/heads/feature/conflict')
    const made = await create({ github: '#3' })
    expect(made.worktree).toMatchObject({ branch: 'feature/conflict', head: expected, keepBranch: true })
    await world.call('quirky.worktree/remove', { worktree: `id:${made.worktree.id}` })
    expect(git(world.project, 'rev-parse', 'refs/heads/feature/conflict')).toBe(expected)
    expect(git(world.project, 'worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree '))).toHaveLength(1)
  })

  test('refuses diverged and occupied PR branches without moving or deleting either checkout', async () => {
    world = await startGithubWorld()
    const expected = git(world.baseBare, 'rev-parse', 'refs/pull/3/head')
    git(world.project, 'fetch', '--quiet', 'origin', '+refs/pull/3/head:refs/heads/feature/conflict')
    const divergedHead = git(world.project, 'commit-tree', 'origin/main^{tree}', '-p', 'origin/main', '-m', 'diverged')
    git(world.project, 'branch', '--force', 'feature/conflict', divergedHead)
    await expect(create({ github: '#3' })).rejects.toBeDefined()
    expect(git(world.project, 'rev-parse', 'refs/heads/feature/conflict')).toBe(divergedHead)
    expect(git(world.project, 'worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree '))).toHaveLength(1)

    git(world.project, 'branch', '--force', 'feature/conflict', expected)
    const holder = join(world.root, 'held-branch')
    git(world.project, 'worktree', 'add', '--quiet', holder, 'feature/conflict')
    await expect(create({ github: '#3', name: 'occupied' })).rejects.toBeDefined()
    expect(git(world.project, 'rev-parse', 'refs/heads/feature/conflict')).toBe(expected)
    expect(git(holder, 'rev-parse', 'HEAD')).toBe(expected)
    expect(git(world.project, 'worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree '))).toHaveLength(2)
  })
  test('reuses an existing configured remote when the PR head repository is the project origin', async () => {
    world = await startGithubWorld()
    const original = world.state.pulls['3']!
    const localHead = git(world.baseBare, 'rev-parse', 'refs/pull/3/head')
    const sameRepo = makePull(original, {
      title: 'Same repository head',
      head: { ref: 'feature/conflict', sha: localHead, repo: { name: 'test-repo', owner: { login: 'test-owner' }, html_url: 'https://github.com/test-owner/test-repo' } }
    })
    world.setPull(sameRepo)
    git(world.baseBare, 'update-ref', 'refs/heads/feature/conflict', localHead)
    const made = await create({ github: '#3' })
    expect(made.worktree.pushTarget).toMatchObject({ remoteName: 'origin', branchName: 'feature/conflict' })
    expect(git(world.project, 'remote').split('\n')).not.toContain('pr-test-owner-test-repo')
    expect(git(world.project, 'config', '--get', 'branch.feature/conflict.pushRemote')).toBe('origin')
  })

  test('reuses another configured remote that matches the PR head repository', async () => {
    world = await startGithubWorld()
    git(world.project, 'remote', 'add', 'contributor', world.forkUrl)
    const made = await create({ github: '#3' })
    expect(made.worktree.pushTarget).toMatchObject({ remoteName: 'contributor', branchName: 'feature/conflict' })
    expect(git(world.project, 'config', '--get', 'branch.feature/conflict.pushRemote')).toBe('contributor')
    expect(git(world.project, 'remote').split('\n')).not.toContain('pr-fork-owner-fork-repo')
  })

  test('places an issue terminal beside Setup without stealing the prior terminal focus', async () => {
    world = await startGithubWorld({ includeTerminal: true })
    await world.call('quirky.repo/set', {
      repo: world.repo.id,
      setupPolicy: 'run-by-default',
      setupScript: 'sleep 30; echo setup >> setup-output.txt',
      issueCommand: 'sleep 30; echo issue >> issue-output.txt'
    })
    const beforeFocus = await world.call('quirky.terminal/focusContext')
    const made = await create({ github: '#4', setup: 'run' })
    expect(made.setup.ran).toBe('terminal')
    expect(made.issueCommand).toMatchObject({ ran: 'terminal' })
    if (made.setup.ran !== 'terminal' || made.issueCommand?.ran !== 'terminal') throw new Error('expected independent terminal sessions')
    const issueSession = await world.call('quirky.session/get', { session: made.issueCommand.sessionId }) as { title: string }
    expect(issueSession.title).toBe('Issue #4')
    const state = await world.call('quirky.terminal/workspace', { workspace: `id:${made.worktree.id}` }) as { workspace: { root: unknown } }
    const splitTab = tabsIn(state.workspace.root).find((tab) => {
      const sessions = sessionsIn(tab.root)
      return sessions.includes(made.setup.sessionId) && sessions.includes(made.issueCommand!.sessionId!)
    })
    expect(splitTab).toBeDefined()
    expect(sessionsIn((splitTab as Record<string, unknown>).root)).toHaveLength(2)
    expect(await world.call('quirky.terminal/focusContext')).toEqual(beforeFocus)
  })

  test('a failed post-create issue command warns and preserves its linked workspace', async () => {
    world = await startGithubWorld()
    await world.call('quirky.repo/set', { repo: world.repo.id, issueCommand: 'exit 7' })
    const made = await create({ github: '#4' })
    expect(made.issueCommand).toMatchObject({ ran: 'daemon', exitCode: 7, timedOut: false })
    expect(made.warnings.some((warning) => warning.includes('issue command for #4') && warning.includes('exited with 7'))).toBe(true)
    const listed = await world.call('quirky.worktree/list', { repo: world.repo.id }) as Worktree[]
    expect(listed.some((worktree) => worktree.id === made.worktree.id && worktree.linkedIssue?.number === 4)).toBe(true)
  })

  test('a failed PR fetch never falls back to a pre-existing URL-scoped synthetic ref', async () => {
    world = await startGithubWorld()
    const trackingRef = `refs/quirky/pull/${createHash('sha256').update(world.baseUrl).digest('hex')}/3`
    const staleHead = git(world.project, 'rev-parse', 'origin/main')
    git(world.project, 'update-ref', trackingRef, staleHead)
    git(world.baseBare, 'update-ref', '-d', 'refs/pull/3/head')
    await expect(create({ github: '#3' })).rejects.toBeDefined()
    expect(git(world.project, 'rev-parse', trackingRef)).toBe(staleHead)
    expect(git(world.project, 'branch', '--list', 'feature/conflict')).toBe('')
    expect(git(world.project, 'worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree '))).toHaveLength(1)
  })

  test('a conflicting deterministic fork remote is not overwritten', async () => {
    world = await startGithubWorld()
    git(world.project, 'remote', 'add', 'pr-fork-owner-fork-repo', 'https://github.com/someone-else/wrong-repo.git')
    await expect(create({ github: '#3' })).rejects.toBeDefined()
    expect(git(world.project, 'config', '--get', 'remote.pr-fork-owner-fork-repo.url')).toBe('https://github.com/someone-else/wrong-repo.git')
    expect(git(world.project, 'branch', '--list', 'feature/conflict')).toBe('')
    expect(git(world.project, 'worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree '))).toHaveLength(1)
  })
  test('refuses GitHub sources for folder projects and groups', async () => {
    world = await startGithubWorld()
    const folderPath = join(world.root, 'folder-project')
    mkdirSync(folderPath, { recursive: true })
    const folder = await world.call('quirky.repo/add', { path: folderPath, folder: true }) as { id: string }
    await expect(world.call('quirky.worktree/create', { repo: folder.id, github: '#4' })).rejects.toBeDefined()
    expect(await world.call('quirky.worktree/list', { repo: folder.id })).toHaveLength(1)

    const group = await world.call('quirky.repo/groupCreate', { name: 'notes', parentPath: world.root }) as { id: string }
    await expect(world.call('quirky.worktree/create', { group: group.id, github: '#4' })).rejects.toBeDefined()
    expect(await world.call('quirky.worktree/list', { group: group.id })).toEqual([])
  })
})
