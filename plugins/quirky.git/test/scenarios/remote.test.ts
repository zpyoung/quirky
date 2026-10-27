import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RpcErrorCode, type GitStatus } from '@quirky/protocol'
import { waitForAsync } from '../../../../packages/daemon/test/helpers'
import { git } from '../../../quirky.repo/test/git-fixtures'
import { makeOrigin } from '../../../quirky.worktree/test/fixtures/repos'
import { addPeer, commitInFeat, installHook, isolateScenarioGit, jsonError, originHead, startScenario, type Scenario } from './fixture'

const { scratch } = isolateScenarioGit()
let s: Scenario | undefined
const savedPath = process.env.PATH
afterEach(async () => {
  process.env.PATH = savedPath
  await s?.cleanup()
  s = undefined
})

const status = (): Promise<GitStatus> => s!.api('status')
const counts = async () => {
  const { ahead, behind } = await status()
  return { ahead, behind }
}

/** Publishes feat with one commit, so it has an upstream. */
async function published(files: Record<string, string> = { 'extra.txt': 'extra\n' }): Promise<Scenario> {
  s = await startScenario(scratch)
  commitInFeat(s, files)
  await s.api('push')
  return s
}

/** Captures the daemon's log lines while `run` executes. */
async function logged<T>(run: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = []
  const spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => void lines.push(args.join(' ')))
  try {
    return { result: await run(), lines }
  } finally {
    spy.mockRestore()
  }
}

describe('push', () => {
  test('SC-31: the first push publishes the branch and sets the upstream, the second pushes the new commit (CLI)', async () => {
    s = await startScenario(scratch)
    const first = commitInFeat(s, { 'one.txt': '1\n' })
    const { result, lines } = await logged(() => s!.cli(['git', 'push', '--json']))
    expect(JSON.parse(result.stdout)).toEqual({ remote: 'origin', branch: 'zoe/feat', upstream: 'origin/zoe/feat' })
    expect(originHead(s, 'zoe/feat')).toBe(first)
    expect(await status()).toMatchObject({ upstream: 'origin/zoe/feat', ahead: 0, behind: 0 })
    expect(lines.some((line) => new RegExp(`quirky.git: push ${s!.feat.id} ok \\d+$`).test(line))).toBe(true)

    const second = commitInFeat(s, { 'two.txt': '2\n' })
    expect(await counts()).toEqual({ ahead: 1, behind: 0 })
    expect((await s.cli(['git', 'push'])).code).toBe(0)
    expect(originHead(s, 'zoe/feat')).toBe(second)
    expect(await counts()).toEqual({ ahead: 0, behind: 0 })
  })

  test('SC-31: branch.<b>.pushRemote sends the push to that remote', async () => {
    s = await startScenario(scratch)
    const fork = makeOrigin(join(scratch(), 'fork.git'), { files: { 'a.txt': 'x\n' } })
    s.gitIn('remote', 'add', 'fork', fork)
    s.gitIn('config', 'branch.zoe/feat.pushRemote', 'fork')
    const sha = commitInFeat(s, { 'one.txt': '1\n' })
    expect(await s.api('push')).toEqual({ remote: 'fork', branch: 'zoe/feat', upstream: 'fork/zoe/feat' })
    expect(git(fork, 'rev-parse', 'refs/heads/zoe/feat')).toBe(sha)
    expect(originHead(s, 'zoe/feat')).toBeNull()
  })

  test('a successful push announces one change, a refused one announces none', async () => {
    s = await startScenario(scratch)
    commitInFeat(s, { 'one.txt': '1\n' })
    const before = s.changedEvents()
    await s.api('push')
    await Bun.sleep(80)
    expect(s.changedEvents()).toBe(before + 1)

    s.gitIn('checkout', '-q', '--detach')
    expect((await s.fails(s.api('push'))).data.reason).toBe('detached')
    await Bun.sleep(80)
    expect(s.changedEvents()).toBe(before + 1)
  })

  test('SC-32: a push the remote has moved past is rejected as non-fast-forward and says to pull first (CLI)', async () => {
    await published()
    const peer = addPeer(s!, join(scratch(), 'peer'), 'zoe/feat')
    peer.commit({ 'peer.txt': 'p\n' })
    peer.push('zoe/feat')
    commitInFeat(s!, { 'mine.txt': 'm\n' })

    const result = await s!.cli(['git', 'push', '--json'])
    expect(result.code).toBe(1)
    expect(jsonError(result)).toMatchObject({
      code: 'conflict',
      reason: 'non-fast-forward',
      message: 'Push rejected: remote has newer commits (non-fast-forward). Please pull or sync first.'
    })
    expect(originHead(s!, 'zoe/feat')).toBe(peer.git('rev-parse', 'HEAD'))
  })

  test('SC-38: a failing pre-push hook blocks the push with its summary and output (CLI)', async () => {
    s = await startScenario(scratch)
    commitInFeat(s, { 'one.txt': '1\n' })
    installHook(s, 'pre-push', 'echo "lint-staged failed"; exit 1')
    const result = await s.cli(['git', 'push', '--json'])
    expect(result.code).toBe(1)
    const error = jsonError(result)
    expect(error).toMatchObject({ code: 'conflict', reason: 'lint', message: 'Lint failed during push.', data: { reason: 'lint', summary: 'Lint failed during push.' } })
    expect(error.data!.output).toContain('lint-staged failed')
    expect(originHead(s, 'zoe/feat')).toBeNull()
  })

  test('SC-40: a detached HEAD is told to check out a branch for every remote operation (CLI)', async () => {
    s = await startScenario(scratch)
    s.gitIn('checkout', '-q', '--detach')
    for (const command of ['push', 'pull', 'fastForward', 'sync', 'fetch', 'forcePush', 'rebaseFromBase']) {
      const result = await s.cli(['git', command, '--json', ...(command === 'forcePush' ? ['--yes'] : [])])
      expect(result.code, command).toBe(1)
      expect(jsonError(result), command).toMatchObject({ reason: 'detached', message: 'Check out a branch first.' })
    }
  })
})

describe('pull', () => {
  test('SC-33a: a branch that is behind fast-forwards (CLI)', async () => {
    await published()
    const peer = addPeer(s!, join(scratch(), 'peer'), 'zoe/feat')
    const theirs = peer.commit({ 'peer.txt': 'p\n' })
    peer.push('zoe/feat')
    expect((await s!.cli(['git', 'pull', '--json'])).code).toBe(0)
    expect(s!.gitIn('rev-parse', 'HEAD')).toBe(theirs)
    expect(await counts()).toEqual({ ahead: 0, behind: 0 })
  })

  test('SC-33b: a divergent branch is merged when pull.rebase is unset, and rebased when it is true (CLI)', async () => {
    await published()
    const peer = addPeer(s!, join(scratch(), 'peer'), 'zoe/feat')
    peer.commit({ 'peer.txt': 'p\n' })
    peer.push('zoe/feat')
    const mine = commitInFeat(s!, { 'mine.txt': 'm\n' })
    expect((await s!.cli(['git', 'pull'])).code).toBe(0)
    expect(s!.gitIn('rev-list', '--parents', '-n1', 'HEAD').split(' ')).toHaveLength(3)
    expect(s!.gitIn('rev-parse', 'HEAD^1')).toBe(mine)
    expect(await counts()).toEqual({ ahead: 2, behind: 0 })

    s!.gitIn('reset', '-q', '--hard', mine)
    s!.gitIn('config', 'pull.rebase', 'true')
    expect((await s!.cli(['git', 'pull'])).code).toBe(0)
    expect(s!.gitIn('rev-list', '--parents', '-n1', 'HEAD').split(' ')).toHaveLength(2)
    expect(await counts()).toEqual({ ahead: 1, behind: 0 })
  })

  test('SC-33c: an incoming change to a locally edited file is refused as local-changes and nothing changes (CLI)', async () => {
    await published({ 'extra.txt': 'extra\n' })
    const peer = addPeer(s!, join(scratch(), 'peer'), 'zoe/feat')
    peer.commit({ 'math.ts': 'a\nb\nCHANGED\nd\ne\n' })
    peer.push('zoe/feat')
    const head = s!.gitIn('rev-parse', 'HEAD')
    s!.write('math.ts', 'a\nb\nmine\nd\ne\n')

    const result = await s!.cli(['git', 'pull', '--json'])
    expect(result.code).toBe(1)
    expect(jsonError(result)).toMatchObject({
      reason: 'local-changes',
      message: 'Pull would overwrite local changes. Commit, stash, or discard them before pulling.'
    })
    expect(s!.gitIn('rev-parse', 'HEAD')).toBe(head)
    expect(readFileSync(join(s!.feat.path, 'math.ts'), 'utf8')).toBe('a\nb\nmine\nd\ne\n')
  })

  test('a pull that stops on conflicts leaves the merge in progress and still announces the change', async () => {
    await published()
    const peer = addPeer(s!, join(scratch(), 'peer'), 'zoe/feat')
    peer.commit({ 'math.ts': 'a\nb\ntheirs\nd\ne\n' })
    peer.push('zoe/feat')
    commitInFeat(s!, { 'math.ts': 'a\nb\nours\nd\ne\n' })
    const before = s!.changedEvents()

    const failure = await s!.fails(s!.api('pull'))
    expect(failure).toMatchObject({ code: RpcErrorCode.Conflict, message: 'Pull stopped with merge conflicts.', data: { reason: 'conflicts' } })
    const after = await status()
    expect(after.operation).toBe('merge')
    expect(after.entries.filter((entry) => entry.area === 'conflicts').map((entry) => entry.path)).toEqual(['math.ts'])
    expect(after.busy).toBeNull()
    await Bun.sleep(80)
    expect(s!.changedEvents()).toBe(before + 1)
  })

  test('SC-40: pull, fastForward and sync without an upstream say to publish first (CLI)', async () => {
    s = await startScenario(scratch)
    for (const command of ['pull', 'fastForward', 'sync']) {
      const result = await s.cli(['git', command, '--json'])
      expect(result.code, command).toBe(1)
      expect(jsonError(result), command).toMatchObject({ reason: 'no-upstream', message: 'Branch has no upstream. Publish the branch first.' })
    }
  })
})

describe('fetch and fast-forward', () => {
  test('SC-34: fetch brings in the remote commit and prunes deleted branches, fast-forward then levels the branch (CLI)', async () => {
    await published()
    const peer = addPeer(s!, join(scratch(), 'peer'), 'zoe/feat')
    peer.git('branch', 'old')
    peer.push('old')
    s!.gitIn('fetch', '-q')
    expect(s!.gitIn('rev-parse', '--verify', 'origin/old')).toBeTruthy()
    const theirs = peer.commit({ 'peer.txt': 'p\n' })
    peer.push('zoe/feat')
    peer.git('push', '-q', 'origin', '--delete', 'old')

    expect(JSON.parse((await s!.cli(['git', 'status', '--json'])).stdout)).toMatchObject({ behind: 0 })
    expect(JSON.parse((await s!.cli(['git', 'fetch', '--json'])).stdout)).toEqual({ ok: true })
    expect(JSON.parse((await s!.cli(['git', 'status', '--json'])).stdout)).toMatchObject({ behind: 1 })
    expect(s!.gitTry(null, 'rev-parse', '--verify', 'origin/old').code).not.toBe(0)
    expect(JSON.parse((await s!.cli(['git', 'fastForward', '--json'])).stdout)).toEqual({ ok: true })
    expect(s!.gitIn('rev-parse', 'HEAD')).toBe(theirs)
  })

  test('SC-34: fast-forwarding a diverged branch fails with git detail and changes nothing (CLI)', async () => {
    await published()
    const peer = addPeer(s!, join(scratch(), 'peer'), 'zoe/feat')
    peer.commit({ 'peer.txt': 'p\n' })
    peer.push('zoe/feat')
    const mine = commitInFeat(s!, { 'mine.txt': 'm\n' })
    const result = await s!.cli(['git', 'fastForward', '--json'])
    expect(result.code).toBe(1)
    expect(jsonError(result)).toMatchObject({ reason: 'failed' })
    expect(jsonError(result).message).toStartWith('Fast-forward failed.')
    expect(s!.gitIn('rev-parse', 'HEAD')).toBe(mine)
  })
})

describe('sync', () => {
  test('SC-35a: sync fetches, pulls the other commit and pushes ours (CLI)', async () => {
    await published()
    const peer = addPeer(s!, join(scratch(), 'peer'), 'zoe/feat')
    peer.commit({ 'peer.txt': 'p\n' })
    peer.push('zoe/feat')
    commitInFeat(s!, { 'mine.txt': 'm\n' })

    const result = await s!.cli(['git', 'sync', '--json'])
    expect(JSON.parse(result.stdout)).toEqual({ steps: ['fetch', 'pull', 'push'] })
    expect(await counts()).toEqual({ ahead: 0, behind: 0 })
    expect(originHead(s!, 'zoe/feat')).toBe(s!.gitIn('rev-parse', 'HEAD'))
  })

  test('sync with nothing to do only fetches, and one that is only ahead pushes', async () => {
    await published()
    expect(await s!.api('sync')).toEqual({ steps: ['fetch'] })
    commitInFeat(s!, { 'mine.txt': 'm\n' })
    expect(await s!.api('sync')).toEqual({ steps: ['fetch', 'push'] })
    const peer = addPeer(s!, join(scratch(), 'peer'), 'zoe/feat')
    peer.commit({ 'peer.txt': 'p\n' })
    peer.push('zoe/feat')
    expect(await s!.api('sync')).toEqual({ steps: ['fetch', 'pull'] })
  })

  test('SC-35b: a branch rebased onto a newer main is force-pushed with a lease on the upstream it read (CLI)', async () => {
    await rebasedBranch()
    expect(await counts()).toEqual({ ahead: 3, behind: 2 })
    const result = await s!.cli(['git', 'sync', '--json'])
    expect(JSON.parse(result.stdout)).toEqual({ steps: ['fetch', 'force-push'] })
    expect(originHead(s!, 'zoe/feat')).toBe(s!.gitIn('rev-parse', 'HEAD'))
    expect(await counts()).toEqual({ ahead: 0, behind: 0 })
  })

  test('sync stops with the pull error when the pull hits conflicts', async () => {
    await published()
    const peer = addPeer(s!, join(scratch(), 'peer'), 'zoe/feat')
    peer.commit({ 'math.ts': 'a\nb\ntheirs\nd\ne\n' })
    peer.push('zoe/feat')
    commitInFeat(s!, { 'math.ts': 'a\nb\nours\nd\ne\n' })
    expect(await s!.fails(s!.api('sync'))).toMatchObject({ data: { reason: 'conflicts' } })
    expect((await status()).operation).toBe('merge')
    expect(originHead(s!, 'zoe/feat')).toBe(peer.git('rev-parse', 'HEAD'))
  })
})

/** feat with commits A and B pushed, then rebased onto an origin/main that moved on (A' B'). */
async function rebasedBranch(): Promise<{ b: string }> {
  s = await startScenario(scratch)
  commitInFeat(s, { 'a.txt': 'A\n' }, 'A')
  const b = commitInFeat(s, { 'b.txt': 'B\n' }, 'B')
  await s.api('push')
  const main = addPeer(s, join(scratch(), 'main-peer'))
  main.commit({ 'newer.txt': 'n\n' }, 'newer main')
  main.push('main')
  s.gitIn('fetch', '-q')
  s.gitIn('rebase', '-q', 'origin/main')
  return { b }
}

describe('force push', () => {
  test('SC-36: a lease on a commit the remote has moved past is refused as stale, and the peer commit survives (CLI)', async () => {
    const { b } = await rebasedBranch()
    const peer = addPeer(s!, join(scratch(), 'peer'), 'zoe/feat')
    const c = peer.commit({ 'c.txt': 'C\n' }, 'C')
    peer.push('zoe/feat')

    const result = await s!.cli(['git', 'forcePush', '--expected', b, '--yes', '--json'])
    expect(result.code).toBe(1)
    expect(jsonError(result)).toMatchObject({
      reason: 'stale-lease',
      message: 'Force push rejected — remote changed since last fetch. Fetch first, then try again.'
    })
    expect(originHead(s!, 'zoe/feat')).toBe(c)
  })

  test('SC-36: without --yes the kernel asks first, naming the branch and remote, and a declined ask pushes nothing (CLI)', async () => {
    const { b } = await rebasedBranch()
    const declined = await s!.cliAsk(['git', 'forcePush', '--expected', b], false)
    expect(declined.code).not.toBe(0)
    expect(declined.stderr).toContain('Force push zoe/feat to origin? This replaces the remote branch with your local commits.')
    expect(originHead(s!, 'zoe/feat')).toBe(b)

    const confirmed = await s!.cliAsk(['git', 'forcePush', '--expected', b], true)
    expect(confirmed.code).toBe(0)
    expect(originHead(s!, 'zoe/feat')).toBe(s!.gitIn('rev-parse', 'HEAD'))
  })

  test('without expected the lease is the remote-tracking ref, so a fetch that saw the peer commit lets it through', async () => {
    const { b } = await rebasedBranch()
    expect(await s!.api('describeForcePush')).toBe('Force push zoe/feat to origin? This replaces the remote branch with your local commits.')
    const peer = addPeer(s!, join(scratch(), 'peer'), 'zoe/feat')
    peer.commit({ 'c.txt': 'C\n' }, 'C')
    peer.push('zoe/feat')

    expect(await s!.fails(s!.api('forcePush', { yes: true }))).toMatchObject({ data: { reason: 'stale-lease' } })
    expect(originHead(s!, 'zoe/feat')).not.toBe(s!.gitIn('rev-parse', 'HEAD'))
    await s!.api('fetch')
    expect(await s!.api('forcePush', { yes: true })).toEqual({ remote: 'origin', branch: 'zoe/feat', upstream: 'origin/zoe/feat' })
    expect(originHead(s!, 'zoe/feat')).toBe(s!.gitIn('rev-parse', 'HEAD'))
    expect(originHead(s!, 'zoe/feat')).not.toBe(b)
  })

  test('a branch never fetched is led by an absent lease, so it only creates a branch the remote does not have', async () => {
    s = await startScenario(scratch)
    const mine = commitInFeat(s, { 'one.txt': '1\n' })
    const peer = addPeer(s, join(scratch(), 'peer'))
    peer.commit({ 'p.txt': 'p\n' })
    peer.push('zoe/feat')
    expect(await s.fails(s.api('forcePush', { yes: true }))).toMatchObject({ data: { reason: 'stale-lease' } })
    peer.git('push', '-q', 'origin', '--delete', 'zoe/feat')
    expect(await s.api('forcePush', { yes: true })).toMatchObject({ upstream: 'origin/zoe/feat' })
    expect(originHead(s, 'zoe/feat')).toBe(mine)
  })

  test('expected must be a full commit id', async () => {
    s = await startScenario(scratch)
    commitInFeat(s, { 'one.txt': '1\n' })
    for (const method of ['forcePush', 'describeForcePush']) {
      expect(await s.fails(s.api(method, { expected: 'abc123', yes: true }))).toMatchObject({ code: RpcErrorCode.InvalidParams })
    }
  })
})

describe('network and credentials', () => {
  test('SC-37: an unreachable https remote fails as network without ever showing the password (CLI)', async () => {
    s = await startScenario(scratch)
    s.gitIn('remote', 'set-url', 'origin', 'https://zoe:s3cr3t@127.0.0.1:9/repo.git')
    const { result, lines } = await logged(() => s!.cli(['git', 'fetch', '--json']))
    expect(result.code).toBe(1)
    expect(jsonError(result)).toMatchObject({ reason: 'network', message: 'Network error. Check your connection.' })
    for (const text of [result.stdout, result.stderr, ...lines]) expect(text).not.toContain('s3cr3t')
    expect(lines.some((line) => line.includes(`fetch ${s!.feat.id} network`))).toBe(true)
  })

  test('SC-37: an ssh remote that wants a password fails fast as auth instead of hanging (CLI)', async () => {
    s = await startScenario(scratch)
    const bin = join(scratch(), 'bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(
      join(bin, 'ssh'),
      [
        '#!/bin/sh',
        'for arg in "$@"; do',
        '  if [ "$arg" = "BatchMode=yes" ]; then',
        '    echo "zoe@example.invalid: Permission denied (publickey,password)." >&2',
        '    exit 255',
        '  fi',
        'done',
        'sleep 60',
        ''
      ].join('\n')
    )
    chmodSync(join(bin, 'ssh'), 0o755)
    process.env.PATH = `${bin}:${savedPath}`
    delete process.env.GIT_SSH_COMMAND
    s.gitIn('remote', 'set-url', 'origin', 'ssh://zoe@example.invalid/repo.git')

    const started = Date.now()
    const result = await s.cli(['git', 'fetch', '--json'])
    expect(result.code).toBe(1)
    expect(jsonError(result)).toMatchObject({ reason: 'auth', message: 'Authentication failed. Check your remote credentials.' })
    expect(Date.now() - started).toBeLessThan(20_000)
  })
})

describe('rebase from base', () => {
  test('SC-39: fetches the remote base, rebases the branch onto it and leaves no temporary refs; a local base is refused (CLI)', async () => {
    s = await startScenario(scratch)
    commitInFeat(s, { 'a.txt': 'A\n' }, 'A')
    commitInFeat(s, { 'b.txt': 'B\n' }, 'B')
    const peer = addPeer(s, join(scratch(), 'peer'))
    const incoming = peer.commit({ 'newer.txt': 'n\n' }, 'newer main')
    peer.push('main')

    const result = await s.cli(['git', 'rebaseFromBase', '--json'])
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, base: 'origin/main' })
    expect(s.gitIn('rev-parse', 'HEAD~2')).toBe(incoming)
    expect(s.gitIn('log', '--format=%s', '-2')).toBe('B\nA')
    expect(s.gitIn('for-each-ref', 'refs/quirky')).toBe('')

    expect(JSON.parse((await s.cli(['git', 'setBase', '--base', 'main', '--json'])).stdout)).toEqual({ target: 'worktree', base: 'main' })
    const refused = await s.cli(['git', 'rebaseFromBase', '--json'])
    expect(refused.code).toBe(1)
    expect(jsonError(refused)).toMatchObject({
      code: 'invalid-params',
      reason: 'invalid-base',
      message: 'Rebase needs a remote base branch (like origin/main).'
    })
  })

  test('SC-39: a conflicting incoming commit stops the rebase with its conflicts, and the change is announced', async () => {
    s = await startScenario(scratch)
    commitInFeat(s, { 'math.ts': 'a\nb\nours\nd\ne\n' }, 'ours')
    const peer = addPeer(s, join(scratch(), 'peer'))
    peer.commit({ 'math.ts': 'a\nb\ntheirs\nd\ne\n' }, 'theirs')
    peer.push('main')
    const before = s.changedEvents()

    const failure = await s.fails(s.api('rebaseFromBase'))
    expect(failure).toMatchObject({ code: RpcErrorCode.Conflict, data: { reason: 'conflicts' }, message: 'Rebase stopped with conflicts.' })
    const after = await status()
    expect(after.operation).toBe('rebase')
    expect(after.entries.filter((entry) => entry.area === 'conflicts').map((entry) => entry.path)).toEqual(['math.ts'])
    expect(s.gitIn('for-each-ref', 'refs/quirky')).toBe('')
    await Bun.sleep(80)
    expect(s.changedEvents()).toBe(before + 1)
  })

  test('an explicit base wins over the effective base, and never falls back to the upstream', async () => {
    s = await startScenario(scratch)
    commitInFeat(s, { 'a.txt': 'A\n' }, 'A')
    await s.api('push')
    const peer = addPeer(s, join(scratch(), 'peer'))
    peer.git('checkout', '-q', '-b', 'release')
    peer.commit({ 'rel.txt': 'r\n' }, 'release work')
    peer.push('release')
    expect(await s.api('rebaseFromBase', { base: 'origin/release' })).toEqual({ ok: true, base: 'origin/release' })
    expect(s.gitIn('log', '--format=%s', '-2')).toBe('A\nrelease work')

    await s.api('setBase', { clear: true })
    await s.client.callAny('quirky.worktree/set', { worktree: s.feat.id, baseRef: null })
    await s.client.callAny('quirky.repo/set', { repo: s.repo.id, defaultBase: '' })
    await s.client.callAny('setting.set', { id: 'setting:quirky.git/compareBase', value: 'branch-upstream' })
    s.gitIn('remote', 'set-head', 'origin', '-d')
    expect(await s.api('rebaseFromBase')).toMatchObject({ base: 'origin/main' })
  })
})

describe('locking', () => {
  test('SC-30: a push holds the lock, status reports it, a second call is refused, and the lock frees afterwards (CLI)', async () => {
    s = await startScenario(scratch)
    commitInFeat(s, { 'one.txt': '1\n' })
    const hooks = join(s.originDir, 'hooks')
    mkdirSync(hooks, { recursive: true })
    writeFileSync(join(hooks, 'pre-receive'), '#!/bin/sh\nsleep 3\n')
    chmodSync(join(hooks, 'pre-receive'), 0o755)
    const mine = () => s!.events.filter((event) => event.type === 'quirky.git/changed' && (event as { data: { worktreeId: string } }).data.worktreeId === s!.feat.id).length
    const before = mine()

    const slow = s.cli(['git', 'push', '--json'])
    await waitForAsync(async () => (await status()).busy === 'push', 10_000)
    const refused = await s.cli(['git', 'fetch', '--json'])
    expect(refused.code).toBe(1)
    expect(jsonError(refused)).toMatchObject({ reason: 'busy', message: 'A push is already running in this worktree.' })
    expect(await s.fails(s.api('sync'))).toMatchObject({ data: { reason: 'busy' } })
    const other = await s.addWorktree('other')
    expect(await s.api('fetch', { worktree: other.id })).toEqual({ ok: true })
    expect(mine()).toBe(before)

    expect((await slow).code).toBe(0)
    expect((await status()).busy).toBeNull()
    expect(await counts()).toEqual({ ahead: 0, behind: 0 })
    await Bun.sleep(80)
    expect(mine()).toBe(before + 1)
  })
})
