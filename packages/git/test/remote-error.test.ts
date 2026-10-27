import { describe, expect, test } from 'bun:test'
import { RemoteError, normalizeRemoteError, redactCredentials, type RemoteAction } from '../src/remote-error'

describe('redactCredentials', () => {
  test('hides user:pass and token userinfo', () => {
    expect(redactCredentials('fatal: unable to access \'https://zoe:s3cr3t@host.test/r.git/\'')).toBe(
      "fatal: unable to access 'https://***@host.test/r.git/'"
    )
    expect(redactCredentials('https://ghp_abc123@github.com/o/r.git')).toBe('https://***@github.com/o/r.git')
    expect(redactCredentials('ssh://git@host/x.git')).toBe('ssh://***@host/x.git')
  })

  test('hides every occurrence and handles an @ inside the password', () => {
    expect(redactCredentials('a http://u:p@w@h/x and git+ssh://t@h2/y')).toBe('a http://***@h/x and git+ssh://***@h2/y')
  })

  test('leaves urls without userinfo and plain text alone', () => {
    const text = 'https://example.com/path@thing and name@example.com'
    expect(redactCredentials(text)).toBe(text)
  })
})

type Row = [string, RemoteAction, string, string, string, string]
const rows: Row[] = [
  [
    'non-fast-forward',
    'push',
    ' ! [rejected]        HEAD -> feat (non-fast-forward)\nerror: failed to push some refs to \'/o.git\'',
    '',
    'non-fast-forward',
    'Push rejected: remote has newer commits (non-fast-forward). Please pull or sync first.'
  ],
  [
    'fetch first',
    'push',
    ' ! [rejected]        HEAD -> feat (fetch first)\nerror: failed to push some refs',
    '',
    'non-fast-forward',
    'Push rejected: remote has newer commits (non-fast-forward). Please pull or sync first.'
  ],
  [
    'stale lease',
    'force-push',
    ' ! [rejected]        HEAD -> feat (stale info)\nerror: failed to push some refs',
    '',
    'stale-lease',
    'Force push rejected — remote changed since last fetch. Fetch first, then try again.'
  ],
  ['auth failed', 'push', "fatal: Authentication failed for 'https://h/r.git/'", '', 'auth', 'Authentication failed. Check your remote credentials.'],
  [
    'ssh denied',
    'fetch',
    'git@h: Permission denied (publickey).\nfatal: Could not read from remote repository.',
    '',
    'auth',
    'Authentication failed. Check your remote credentials.'
  ],
  ['no username', 'pull', "fatal: could not read Username for 'https://h': No such device or address", '', 'auth', 'Authentication failed. Check your remote credentials.'],
  ['terminal prompts', 'pull', "fatal: could not read Password: terminal prompts disabled", '', 'auth', 'Authentication failed. Check your remote credentials.'],
  ['host key', 'fetch', 'Host key verification failed.\nfatal: Could not read from remote repository.', '', 'auth', 'Authentication failed. Check your remote credentials.'],
  ['dns', 'fetch', 'fatal: unable to access \'https://h/\': Could not resolve host: h', '', 'network', 'Network error. Check your connection.'],
  ['refused', 'fetch', 'fatal: unable to connect: Connection refused', '', 'network', 'Network error. Check your connection.'],
  ['timed out', 'fetch', 'ssh: connect to host h port 22: Connection timed out', '', 'network', 'Network error. Check your connection.'],
  ['unreachable', 'fetch', 'connect: Network is unreachable', '', 'network', 'Network error. Check your connection.'],
  ['remote unreadable', 'fetch', "fatal: '/nope' does not appear to be a git repository\nfatal: Could not read from remote repository.", '', 'network', 'Network error. Check your connection.'],
  ['no upstream', 'pull', 'There is no tracking information for the current branch.', '', 'no-upstream', 'Branch has no upstream. Publish the branch first.'],
  ['no upstream 2', 'fast-forward', 'fatal: no upstream configured for branch feat', '', 'no-upstream', 'Branch has no upstream. Publish the branch first.'],
  [
    'divergent',
    'pull',
    'hint: You have divergent branches\nfatal: Need to specify how to reconcile divergent branches.',
    '',
    'divergent-policy',
    'Need to specify how to reconcile divergent branches.'
  ],
  [
    'local changes (merge)',
    'pull',
    'error: Your local changes to the following files would be overwritten by merge:\n\tmath.ts\nPlease commit your changes or stash them before you merge.\nAborting',
    '',
    'local-changes',
    'Pull would overwrite local changes. Commit, stash, or discard them before pulling.'
  ],
  [
    'untracked overwrite',
    'pull',
    'error: The following untracked working tree files would be overwritten by merge:\n\tnew.txt\nPlease move or remove them before you merge.',
    '',
    'untracked-overwrite',
    'Pull would overwrite untracked files. Move, remove, or add them before pulling.'
  ],
  ['merge conflict', 'pull', 'CONFLICT (content): Merge conflict in a.txt\nAutomatic merge failed; fix conflicts and then commit the result.', '', 'conflicts', 'Pull stopped with merge conflicts.'],
  ['conflict on stdout', 'pull', '', 'CONFLICT (content): Merge conflict in a.txt', 'conflicts', 'Pull stopped with merge conflicts.'],
  ['rebase conflict', 'rebase', 'error: could not apply abc123... msg\nhint: Resolve all conflicts manually', '', 'conflicts', 'Rebase stopped with conflicts.'],
  ['rebase conflict via pull', 'pull', 'error: could not apply abc123... msg', '', 'conflicts', 'Pull stopped with merge conflicts.'],
  ['fatal block', 'fetch', 'warning: x\nfatal: bad object HEAD', '', 'failed', 'fatal: bad object HEAD'],
  ['last error block', 'rebase', 'error: first problem\nsomething\nerror: cannot rebase: You have unstaged changes.\nerror: Please commit or stash them.', '', 'failed', 'error: cannot rebase: You have unstaged changes. error: Please commit or stash them.'],
  ['last line fallback', 'fetch', 'remote: oops\n\nweird failure\n', '', 'failed', 'weird failure'],
  ['stdout fallback', 'fetch', '', 'only stdout line\n', 'failed', 'only stdout line'],
  ['nothing at all', 'push', '', '', 'failed', 'Push failed.']
]

describe('normalizeRemoteError', () => {
  for (const [name, action, stderr, stdout, reason, message] of rows) {
    test(name, () => {
      const r = normalizeRemoteError(action, stderr, stdout)
      expect(r.reason).toBe(reason as never)
      expect(r.message).toBe(message)
    })
  }

  test('fast-forward failures are prefixed and capped at 200 chars of detail', () => {
    const r = normalizeRemoteError('fast-forward', 'fatal: Not possible to fast-forward, aborting.', '')
    expect(r).toEqual({ reason: 'failed', message: 'Fast-forward failed. fatal: Not possible to fast-forward, aborting.' })
    const long = normalizeRemoteError('fast-forward', `fatal: ${'y'.repeat(500)}`, '')
    expect(long.message).toBe(`Fast-forward failed. ${`fatal: ${'y'.repeat(500)}`.slice(0, 200)}`)
  })

  test('a pre-push hook gives hook/lint with summary and output', () => {
    const hook = normalizeRemoteError('push', 'pre-push: tests failed\nerror: failed to push some refs to x', '')
    expect(hook).toEqual({
      reason: 'hook',
      message: 'Pre-push hook failed.',
      summary: 'Pre-push hook failed.',
      output: 'pre-push: tests failed\nerror: failed to push some refs to x'
    })
    const lint = normalizeRemoteError('push', '\u001b[31mlint-staged failed\u001b[0m\nerror: failed to push some refs', '')
    expect(lint.reason).toBe('lint')
    expect(lint.summary).toBe('Lint failed during push.')
    expect(lint.output).toBe('lint-staged failed\nerror: failed to push some refs')
  })

  test('a submodule push failure keeps its detail', () => {
    const r = normalizeRemoteError(
      'push',
      "The following submodule paths contain changes that can not be found on any remote:\n  libs/x\nerror: failed to push all needed submodules\nerror: failed to push some refs",
      ''
    )
    expect(r.reason).toBe('failed')
    expect(r.message).toContain('submodule')
    expect(r.message).not.toBe('Push failed.')
  })

  test('non-fast-forward is not mistaken for a hook even with hook words around', () => {
    const r = normalizeRemoteError('push', 'husky\n ! [rejected] HEAD -> x (non-fast-forward)\nerror: failed to push some refs', '')
    expect(r.reason).toBe('non-fast-forward')
  })

  test('credentials never reach the message, summary or output', () => {
    const r = normalizeRemoteError(
      'push',
      "lint-staged failed https://zoe:s3cr3t@h.test/r.git\nerror: failed to push some refs to 'https://zoe:s3cr3t@h.test/r.git'",
      ''
    )
    expect(JSON.stringify(r)).not.toContain('s3cr3t')
    const failed = normalizeRemoteError('fetch', "fatal: weird 'https://zoe:s3cr3t@h.test/r.git'", '')
    expect(failed.message).not.toContain('s3cr3t')
    expect(failed.message).toContain('https://***@h.test')
  })
})

describe('RemoteError', () => {
  test('carries reason, summary and output, redacted and capped', () => {
    const output = `https://u:pw0rd@h/x ${'z'.repeat(70 * 1024)}`
    const err = new RemoteError('hook', 'blocked https://u:pw0rd@h/x', { summary: 'Pre-push hook failed.', output })
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('RemoteError')
    expect(err.reason).toBe('hook')
    expect(err.message).toBe('blocked https://***@h/x')
    expect(err.summary).toBe('Pre-push hook failed.')
    expect(err.output).not.toContain('pw0rd')
    expect(Buffer.byteLength(err.output!)).toBeLessThanOrEqual(64 * 1024)
  })

  test('strips ANSI from output and leaves summary/output undefined when not given', () => {
    expect(new RemoteError('hook', 'm', { output: '\u001b[31mred\u001b[0m' }).output).toBe('red')
    const plain = new RemoteError('detached', 'Check out a branch first.')
    expect(plain.summary).toBeUndefined()
    expect(plain.output).toBeUndefined()
  })
})
