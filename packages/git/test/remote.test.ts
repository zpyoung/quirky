import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { commitFiles, git, isolateGitConfig, makeRepo } from '../../../plugins/quirky.repo/test/git-fixtures'
import {
  RemoteError,
  fastForward,
  fetch,
  pull,
  push,
  pushTarget,
  pushUrlFingerprint,
  rebaseFromBase,
  remotePushUrls,
  remoteTrackingSha,
  type RemoteErrorReason
} from '../src/index'

const { scratch } = isolateGitConfig()

// each test spawns dozens of git processes; a loaded machine needs more than bun's 5 s
setDefaultTimeout(60_000)

type Env = { origin: string; work: string; peer: string }

/** A bare `origin` on main, a working clone on branch `feat` (one commit ahead of main), and a `peer` clone of origin. */
function setup(): Env {
  const root = scratch()
  mkdirSync(root, { recursive: true })
  const origin = join(root, 'origin.git')
  git(root, 'init', '-q', '--bare', '-b', 'main', origin)
  const work = makeRepo(join(root, 'work'))
  git(work, 'remote', 'add', 'origin', origin)
  git(work, 'push', '-q', '-u', 'origin', 'main')
  git(work, 'checkout', '-q', '-b', 'feat')
  commitFiles(work, { 'feat.txt': 'feat\n' })
  const peer = join(root, 'peer')
  git(root, 'clone', '-q', origin, peer)
  git(peer, 'config', 'user.name', 'Peer')
  git(peer, 'config', 'user.email', 'peer@example.com')
  git(peer, 'config', 'commit.gpgsign', 'false')
  return { origin, work, peer }
}

async function failureOf(promise: Promise<unknown>): Promise<RemoteError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(RemoteError)
    return error as RemoteError
  }
  throw new Error('expected the call to fail')
}

async function reasonOf(promise: Promise<unknown>): Promise<RemoteErrorReason> {
  return (await failureOf(promise)).reason
}

const head = (cwd: string, rev = 'HEAD') => git(cwd, 'rev-parse', rev)
const originHead = (env: Env, branch: string) => git(env.origin, 'rev-parse', `refs/heads/${branch}`)
async function exactTarget(env: Env, remote: string, dest: string) {
  const urls = await remotePushUrls(env.work, remote)
  const pushUrl = urls[0]
  if (urls.length !== 1 || pushUrl === undefined) throw new Error('expected one configured push URL')
  return { remote, dest, localBranch: 'feat', localHead: head(env.work), pushUrl, pushUrlFingerprint: pushUrlFingerprint(pushUrl) }
}

/** The peer checks out `branch` from origin (creating it when absent) and commits one file. */
function peerCommit(env: Env, branch: string, files: Record<string, string>): string {
  const exists = Bun.spawnSync(['git', 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], { cwd: env.peer }).exitCode === 0
  git(env.peer, 'fetch', '-q', 'origin')
  if (exists || originExists(env, branch)) git(env.peer, 'checkout', '-q', '-B', branch, `origin/${branch}`)
  else git(env.peer, 'checkout', '-q', '-B', branch)
  commitFiles(env.peer, files)
  git(env.peer, 'push', '-q', 'origin', `HEAD:refs/heads/${branch}`)
  return head(env.peer)
}

function originExists(env: Env, branch: string): boolean {
  return Bun.spawnSync(['git', 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: env.origin }).exitCode === 0
}

function hook(cwd: string, name: string, body: string): void {
  const path = join(cwd, '.git', 'hooks', name)
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
}

describe('push', () => {
  test('publishes a branch with no upstream and sets it', async () => {
    const env = setup()
    const result = await push(env.work)
    expect(result).toEqual({ remote: 'origin', branch: 'feat', upstream: 'origin/feat' })
    expect(originHead(env, 'feat')).toBe(head(env.work))
    expect(git(env.work, 'rev-parse', '--abbrev-ref', 'feat@{upstream}')).toBe('origin/feat')
  })

  test('pushes new commits to the existing upstream', async () => {
    const env = setup()
    await push(env.work)
    commitFiles(env.work, { 'more.txt': 'more\n' })
    await push(env.work)
    expect(originHead(env, 'feat')).toBe(head(env.work))
  })

  test('pushes to the upstream branch name when it differs from the local name', async () => {
    const env = setup()
    git(env.work, 'push', '-q', 'origin', 'HEAD:refs/heads/other')
    git(env.work, 'branch', '-q', '--set-upstream-to=origin/other', 'feat')
    commitFiles(env.work, { 'more.txt': 'more\n' })
    const result = await push(env.work)
    expect(result.upstream).toBe('origin/other')
    expect(originHead(env, 'other')).toBe(head(env.work))
    expect(originExists(env, 'feat')).toBe(false)
  })

  test('honours branch.<b>.pushRemote', async () => {
    const env = setup()
    const fork = join(env.origin, '..', 'fork.git')
    git(env.work, 'init', '-q', '--bare', '-b', 'main', fork)
    git(env.work, 'remote', 'add', 'fork', fork)
    git(env.work, 'config', 'branch.feat.pushRemote', 'fork')
    const result = await push(env.work)
    expect(result.remote).toBe('fork')
    expect(git(fork, 'rev-parse', 'refs/heads/feat')).toBe(head(env.work))
    expect(originExists(env, 'feat')).toBe(false)
  })

  test('uses the provider-validated remote and branch even when the default push remote differs', async () => {
    const env = setup()
    const fork = join(env.origin, '..', 'fork.git')
    git(env.work, 'init', '-q', '--bare', '-b', 'main', fork)
    git(env.work, 'remote', 'add', 'fork', fork)
    git(env.work, 'config', 'branch.feat.pushRemote', 'origin')
    git(env.work, 'config', 'branch.feat.remote', 'fork')
    git(env.work, 'config', 'branch.feat.merge', 'refs/heads/review/feature')
    const target = await exactTarget(env, 'fork', 'review/feature')

    expect(await push(env.work, { target })).toEqual({ remote: 'fork', branch: 'feat', upstream: 'fork/review/feature' })
    expect(git(fork, 'rev-parse', 'refs/heads/review/feature')).toBe(target.localHead)
    expect(originExists(env, 'feat')).toBe(false)
    expect(originExists({ ...env, origin: fork }, 'feat')).toBe(false)
  })

  test('a changed configured push URL refuses the validated snapshot without contacting either destination', async () => {
    const env = setup()
    const fork = join(env.origin, '..', 'fork.git')
    const replacement = join(env.origin, '..', 'replacement.git')
    git(env.work, 'init', '-q', '--bare', '-b', 'main', fork)
    git(env.work, 'init', '-q', '--bare', '-b', 'main', replacement)
    git(env.work, 'remote', 'add', 'fork', fork)
    const target = await exactTarget(env, 'fork', 'feat')
    git(env.work, 'remote', 'set-url', '--push', 'fork', replacement)

    const error = await failureOf(push(env.work, { target }))
    expect(error.message).toContain('configured push URL changed')
    expect(originExists({ ...env, origin: fork }, 'feat')).toBe(false)
    expect(originExists({ ...env, origin: replacement }, 'feat')).toBe(false)
  })
  test('redacts the validated push URL from remote failure diagnostics', async () => {
    const env = setup()
    const remoteUrl = 'https://push-user:push-secret@127.0.0.1:1/private.git'
    git(env.work, 'remote', 'add', 'fork', remoteUrl)
    const target = await exactTarget(env, 'fork', 'feat')
    const error = await failureOf(push(env.work, { target }))
    const diagnostic = JSON.stringify({ message: error.message, summary: error.summary, output: error.output })

    expect(diagnostic).not.toContain(remoteUrl)
    expect(diagnostic).not.toContain('push-secret')
    expect(diagnostic).not.toContain('127.0.0.1')
  })

  test('a stale exact target refuses mutation after local HEAD changes', async () => {
    const env = setup()
    const fork = join(env.origin, '..', 'fork.git')
    git(env.work, 'init', '-q', '--bare', '-b', 'main', fork)
    git(env.work, 'remote', 'add', 'fork', fork)
    git(env.work, 'config', 'branch.feat.pushRemote', 'fork')
    const target = await exactTarget(env, 'fork', 'feat')
    commitFiles(env.work, { 'raced.txt': 'new head\\n' })

    const error = await failureOf(push(env.work, { target }))
    expect(error.message).toContain('local branch or HEAD changed')
    expect(originExists({ ...env, origin: fork }, 'feat')).toBe(false)
  })

  test('is rejected as non-fast-forward when the remote moved', async () => {
    const env = setup()
    await push(env.work)
    const theirs = peerCommit(env, 'feat', { 'peer.txt': 'p\n' })
    commitFiles(env.work, { 'mine.txt': 'm\n' })
    const err = await failureOf(push(env.work))
    expect(err.reason).toBe('non-fast-forward')
    expect(err.message).toBe('Push rejected: remote has newer commits (non-fast-forward). Please pull or sync first.')
    expect(originHead(env, 'feat')).toBe(theirs)
  })

  test('refuses a detached HEAD', async () => {
    const env = setup()
    git(env.work, 'checkout', '-q', '--detach')
    const err = await failureOf(push(env.work))
    expect(err.reason).toBe('detached')
    expect(err.message).toBe('Check out a branch first.')
  })

  test('a failing lint pre-push hook blocks the push as lint', async () => {
    const env = setup()
    hook(env.work, 'pre-push', 'echo "lint-staged failed"\nexit 1')
    const err = await failureOf(push(env.work))
    expect(err.reason).toBe('lint')
    expect(err.summary).toBe('Lint failed during push.')
    expect(err.message).toBe('Lint failed during push.')
    expect(err.output).toContain('lint-staged failed')
    expect(originExists(env, 'feat')).toBe(false)
  })

  test('a failing pre-push hook blocks the push as hook', async () => {
    const env = setup()
    hook(env.work, 'pre-push', 'echo "pre-push: tests are red"\nexit 1')
    const err = await failureOf(push(env.work))
    expect(err.reason).toBe('hook')
    expect(err.summary).toBe('Pre-push hook failed.')
    expect(err.output).toContain('tests are red')
  })
})

describe('force push with a lease', () => {
  async function rebasedFeat(env: Env): Promise<string> {
    await push(env.work)
    const published = head(env.work)
    git(env.work, 'commit', '-q', '--amend', '-m', 'rewritten')
    return published
  }

  test('succeeds when the lease matches the remote', async () => {
    const env = setup()
    const published = await rebasedFeat(env)
    await push(env.work, { lease: { expected: published } })
    expect(originHead(env, 'feat')).toBe(head(env.work))
  })

  test('is refused as stale when the remote moved, and the peer commit survives', async () => {
    const env = setup()
    const published = await rebasedFeat(env)
    const theirs = peerCommit(env, 'feat', { 'peer.txt': 'p\n' })
    const err = await failureOf(push(env.work, { lease: { expected: published } }))
    expect(err.reason).toBe('stale-lease')
    expect(err.message).toBe('Force push rejected — remote changed since last fetch. Fetch first, then try again.')
    expect(originHead(env, 'feat')).toBe(theirs)
  })

  test('expecting an absent branch succeeds only when it is absent', async () => {
    const env = setup()
    await push(env.work, { lease: { expected: null } })
    expect(originHead(env, 'feat')).toBe(head(env.work))
    git(env.work, 'commit', '-q', '--amend', '-m', 'again')
    expect(await reasonOf(push(env.work, { lease: { expected: null } }))).toBe('stale-lease')
  })

  test('rejects an expected value that is not a full sha before running git', async () => {
    const env = setup()
    const err = await failureOf(push(env.work, { lease: { expected: 'main' } }))
    expect(err.reason).toBe('failed')
    expect(originExists(env, 'feat')).toBe(false)
  })
})

describe('pushTarget and remoteTrackingSha', () => {
  test('resolves remote precedence', async () => {
    const env = setup()
    expect(await pushTarget(env.work, 'feat')).toEqual({ remote: 'origin', dest: 'feat' })
    git(env.work, 'config', 'branch.feat.remote', 'up')
    expect(await pushTarget(env.work, 'feat')).toEqual({ remote: 'up', dest: 'feat' })
    git(env.work, 'config', 'remote.pushDefault', 'pd')
    expect(await pushTarget(env.work, 'feat')).toEqual({ remote: 'pd', dest: 'feat' })
    git(env.work, 'config', 'branch.feat.pushRemote', 'pr')
    expect(await pushTarget(env.work, 'feat')).toEqual({ remote: 'pr', dest: 'feat' })
  })

  test('uses the upstream branch name only when the upstream is on the push remote', async () => {
    const env = setup()
    git(env.work, 'config', 'branch.feat.remote', 'origin')
    git(env.work, 'config', 'branch.feat.merge', 'refs/heads/other')
    expect(await pushTarget(env.work, 'feat')).toEqual({ remote: 'origin', dest: 'other' })
    git(env.work, 'config', 'branch.feat.pushRemote', 'fork')
    expect(await pushTarget(env.work, 'feat')).toEqual({ remote: 'fork', dest: 'feat' })
  })

  test('remoteTrackingSha reads the local tracking ref without fetching', async () => {
    const env = setup()
    expect(await remoteTrackingSha(env.work, 'origin', 'feat')).toBeNull()
    await push(env.work)
    expect(await remoteTrackingSha(env.work, 'origin', 'feat')).toBe(head(env.work))
    peerCommit(env, 'feat', { 'peer.txt': 'p\n' })
    expect(await remoteTrackingSha(env.work, 'origin', 'feat')).toBe(head(env.work))
  })
})

describe('pull', () => {
  test('fast-forwards when behind', async () => {
    const env = setup()
    await push(env.work)
    const theirs = peerCommit(env, 'feat', { 'peer.txt': 'p\n' })
    await pull(env.work)
    expect(head(env.work)).toBe(theirs)
  })

  test('retries a divergent pull as a merge when pull.rebase is unset', async () => {
    const env = setup()
    await push(env.work)
    const theirs = peerCommit(env, 'feat', { 'peer.txt': 'p\n' })
    commitFiles(env.work, { 'mine.txt': 'm\n' })
    await pull(env.work)
    expect(git(env.work, 'rev-list', '--parents', '-n1', 'HEAD').split(' ')).toHaveLength(3)
    expect(Bun.spawnSync(['git', 'merge-base', '--is-ancestor', theirs, 'HEAD'], { cwd: env.work }).exitCode).toBe(0)
  })

  test('rebases a divergent pull when pull.rebase is set', async () => {
    const env = setup()
    await push(env.work)
    peerCommit(env, 'feat', { 'peer.txt': 'p\n' })
    commitFiles(env.work, { 'mine.txt': 'm\n' })
    git(env.work, 'config', 'pull.rebase', 'true')
    await pull(env.work)
    expect(git(env.work, 'rev-list', '--parents', '-n1', 'HEAD').split(' ')).toHaveLength(2)
  })

  test('is blocked by local changes the incoming commit would overwrite', async () => {
    const env = setup()
    commitFiles(env.work, { 'math.ts': 'one\n' })
    await push(env.work)
    peerCommit(env, 'feat', { 'math.ts': 'two\n' })
    writeFileSync(join(env.work, 'math.ts'), 'local edit\n')
    const before = head(env.work)
    const err = await failureOf(pull(env.work))
    expect(err.reason).toBe('local-changes')
    expect(err.message).toBe('Pull would overwrite local changes. Commit, stash, or discard them before pulling.')
    expect(head(env.work)).toBe(before)
    expect(readFileSync(join(env.work, 'math.ts'), 'utf8')).toBe('local edit\n')
  })

  test('reports merge conflicts', async () => {
    const env = setup()
    commitFiles(env.work, { 'math.ts': 'one\n' })
    await push(env.work)
    peerCommit(env, 'feat', { 'math.ts': 'theirs\n' })
    commitFiles(env.work, { 'math.ts': 'mine\n' })
    expect(await reasonOf(pull(env.work))).toBe('conflicts')
  })

  test('refuses a branch with no upstream before running git', async () => {
    const env = setup()
    const err = await failureOf(pull(env.work))
    expect(err.reason).toBe('no-upstream')
    expect(err.message).toBe('Branch has no upstream. Publish the branch first.')
  })

  test('refuses a detached HEAD', async () => {
    const env = setup()
    git(env.work, 'checkout', '-q', '--detach')
    expect(await reasonOf(pull(env.work))).toBe('detached')
  })
})

describe('fastForward', () => {
  test('brings the branch level when behind', async () => {
    const env = setup()
    await push(env.work)
    const theirs = peerCommit(env, 'feat', { 'peer.txt': 'p\n' })
    await fastForward(env.work)
    expect(head(env.work)).toBe(theirs)
  })

  test('fails on divergence with git detail and changes nothing', async () => {
    const env = setup()
    await push(env.work)
    peerCommit(env, 'feat', { 'peer.txt': 'p\n' })
    commitFiles(env.work, { 'mine.txt': 'm\n' })
    const before = head(env.work)
    const err = await failureOf(fastForward(env.work))
    expect(err.reason).toBe('failed')
    expect(err.message).toStartWith('Fast-forward failed. ')
    expect(err.message.length).toBeGreaterThan('Fast-forward failed. '.length)
    expect(head(env.work)).toBe(before)
  })

  test('refuses no upstream and detached HEAD', async () => {
    const env = setup()
    expect(await reasonOf(fastForward(env.work))).toBe('no-upstream')
    git(env.work, 'checkout', '-q', '--detach')
    expect(await reasonOf(fastForward(env.work))).toBe('detached')
  })
})

describe('fetch', () => {
  test('explains when no remote is configured instead of silently succeeding', async () => {
    const work = makeRepo(scratch())
    const error = await failureOf(fetch(work))
    expect(error.reason).toBe('failed')
    expect(error.message).toMatch(/no remote/i)
    expect(error.message).toMatch(/configur|add/i)
  })

  test('fetches remote changes without an upstream on the current branch', async () => {
    const env = setup()
    const theirs = peerCommit(env, 'main', { 'upstream.txt': 'new\n' })
    await fetch(env.work)
    expect(await remoteTrackingSha(env.work, 'origin', 'main')).toBe(theirs)
    expect(git(env.work, 'for-each-ref', '--format=%(upstream)', 'refs/heads/feat')).toBe('')
  })

  test('updates remote-tracking refs and prunes deleted branches', async () => {
    const env = setup()
    await push(env.work)
    peerCommit(env, 'old', { 'old.txt': 'o\n' })
    await fetch(env.work)
    expect(await remoteTrackingSha(env.work, 'origin', 'old')).not.toBeNull()
    git(env.peer, 'push', '-q', 'origin', '--delete', 'old')
    const theirs = peerCommit(env, 'feat', { 'peer.txt': 'p\n' })
    await fetch(env.work)
    expect(await remoteTrackingSha(env.work, 'origin', 'old')).toBeNull()
    expect(await remoteTrackingSha(env.work, 'origin', 'feat')).toBe(theirs)
  })

  test('refuses a detached HEAD', async () => {
    const env = setup()
    git(env.work, 'checkout', '-q', '--detach')
    expect(await reasonOf(fetch(env.work))).toBe('detached')
  })
})

describe('rebaseFromBase', () => {
  const tempRefs = (cwd: string) => git(cwd, 'for-each-ref', 'refs/quirky/')

  test('rebases the branch onto the fetched remote base and leaves no temp refs', async () => {
    const env = setup()
    const theirs = peerCommit(env, 'main', { 'upstream.txt': 'u\n' })
    commitFiles(env.work, { 'two.txt': 'two\n' })
    const result = await rebaseFromBase(env.work, 'origin/main')
    expect(result).toEqual({ result: 'rebased' })
    expect(Bun.spawnSync(['git', 'merge-base', '--is-ancestor', theirs, 'HEAD'], { cwd: env.work }).exitCode).toBe(0)
    expect(git(env.work, 'rev-list', '--count', `${theirs}..HEAD`)).toBe('2')
    expect(await remoteTrackingSha(env.work, 'origin', 'main')).toBe(theirs)
    expect(tempRefs(env.work)).toBe('')
  })

  test('reports up-to-date when the base is already contained', async () => {
    const env = setup()
    expect(await rebaseFromBase(env.work, 'origin/main')).toEqual({ result: 'up-to-date' })
    expect(tempRefs(env.work)).toBe('')
  })

  test('rejects a base that is not <remote>/<branch>', async () => {
    const env = setup()
    for (const base of ['main', 'nope/main', 'origin/', 'origin/-x', 'origin/bad..name', '']) {
      const err = await failureOf(rebaseFromBase(env.work, base))
      expect(err.reason).toBe('invalid-base')
      expect(err.message).toBe('Rebase needs a remote base branch (like origin/main).')
    }
  })

  test('a conflict leaves the rebase in progress and still cleans the temp ref', async () => {
    const env = setup()
    commitFiles(env.work, { 'math.ts': 'mine\n' })
    peerCommit(env, 'main', { 'math.ts': 'theirs\n' })
    const err = await failureOf(rebaseFromBase(env.work, 'origin/main'))
    expect(err.reason).toBe('conflicts')
    expect(err.message).toBe('Rebase stopped with conflicts.')
    const gitDir = git(env.work, 'rev-parse', '--absolute-git-dir')
    expect(existsSync(join(gitDir, 'rebase-merge')) || existsSync(join(gitDir, 'rebase-apply'))).toBe(true)
    expect(tempRefs(env.work)).toBe('')
  })

  test('refuses a detached HEAD', async () => {
    const env = setup()
    git(env.work, 'checkout', '-q', '--detach')
    expect(await reasonOf(rebaseFromBase(env.work, 'origin/main'))).toBe('detached')
  })
})

describe('network failures', () => {
  const savedPath = process.env.PATH
  const savedSsh = process.env.GIT_SSH_COMMAND
  afterEach(() => {
    process.env.PATH = savedPath
    if (savedSsh === undefined) delete process.env.GIT_SSH_COMMAND
    else process.env.GIT_SSH_COMMAND = savedSsh
  })

  test('an unreachable http remote is a network error that never shows the password', async () => {
    const env = setup()
    git(env.work, 'remote', 'set-url', 'origin', 'http://zoe:s3cr3t@127.0.0.1:9/x.git')
    const err = await failureOf(fetch(env.work))
    expect(err.reason).toBe('network')
    expect(err.message).toBe('Network error. Check your connection.')
    expect(JSON.stringify({ message: err.message, summary: err.summary, output: err.output })).not.toContain('s3cr3t')
    const pushErr = await failureOf(push(env.work))
    expect(pushErr.reason).toBe('network')
    expect(pushErr.message).not.toContain('s3cr3t')
  })

  test('an ssh remote that wants a password fails fast as auth instead of hanging', async () => {
    const env = setup()
    const bin = join(scratch(), 'bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(
      join(bin, 'ssh'),
      [
        '#!/bin/sh',
        'for arg in "$@"; do',
        '  if [ "$arg" = "BatchMode=yes" ]; then',
        '    echo "git@example.invalid: Permission denied (publickey)." >&2',
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
    git(env.work, 'remote', 'set-url', 'origin', 'ssh://git@example.invalid/x.git')
    const started = Date.now()
    const err = await failureOf(fetch(env.work))
    expect(err.reason).toBe('auth')
    expect(err.message).toBe('Authentication failed. Check your remote credentials.')
    expect(Date.now() - started).toBeLessThan(20_000)
  })
})
