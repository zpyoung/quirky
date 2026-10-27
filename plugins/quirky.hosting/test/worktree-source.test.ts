import { afterEach, expect, test } from 'bun:test'
import { bootHosting, type HostingTest } from './helpers'

const hosts: HostingTest[] = []
afterEach(async () => {
  for (const hosting of hosts.splice(0).reverse()) await hosting.cleanup()
})

const ghFixture = String.raw`
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const root = process.env.QUIRKY_TEST_FIXTURE_DIR
if (typeof root !== 'string') throw new Error('missing isolated fixture directory')
const state = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'))
const emit = (value) => process.stdout.write(JSON.stringify(value))
const fail = (message) => {
  process.stderr.write(message)
  process.exit(1)
}
if (args[0] === 'auth' && args[1] === 'status') {
  process.stdout.write('Logged in to github.com account hosting-fixture (keyring)\nActive account: true\nToken scopes: repo, project, read:org\n')
  process.exit(0)
}
if (args[0] === 'auth' && args[1] === 'token' && args.includes('--help')) {
  process.stdout.write('gh auth token [--user USER] [--hostname HOST]')
  process.exit(0)
}
if (args[0] === 'pr' && args[1] === 'view') {
  const repoIndex = args.indexOf('--repo')
  const repo = repoIndex >= 0 ? args[repoIndex + 1] : ''
  const key = repo + '/' + (args[2] ?? '')
  const value = state.prViews && state.prViews[key]
  if (value) emit(value)
  else fail('HTTP 404: Not Found')
  process.exit(0)
}
if (args[0] === 'api') {
  const endpoint = args.find((value) => value.startsWith('repos/'))
  if (typeof endpoint !== 'string') fail('HTTP 400: Missing endpoint')
  const error = state.errors && state.errors[endpoint]
  if (typeof error === 'string') fail(error)
  emit(state.responses && Object.hasOwn(state.responses, endpoint) ? state.responses[endpoint] : {})
  process.exit(0)
}
fail('HTTP 400: Unsupported fixture command')
`

function pullRequest(options: {
  number?: number
  url?: string
  baseOwner?: string
  baseRepo?: string
  headOwner?: string | null
  headRepo?: string
  headOid?: string
  baseOid?: string
  headRef?: string
  baseRef?: string
  maintainerCanModify?: boolean
} = {}): Record<string, unknown> {
  const number = options.number ?? 3
  const baseOwner = options.baseOwner ?? 'upstream'
  const baseRepo = options.baseRepo ?? 'base'
  const headOwner = options.headOwner === undefined ? 'fork-owner' : options.headOwner
  const headRepo = options.headRepo ?? 'fork-base'
  const baseUrl = `https://github.com/${baseOwner}/${baseRepo}`
  const head = headOwner === null ? null : {
    ref: options.headRef ?? 'feat/conflict',
    sha: options.headOid ?? 'a'.repeat(40),
    repo: {
      name: headRepo,
      owner: { login: headOwner },
      html_url: `https://github.com/${headOwner}/${headRepo}`,
      clone_url: `https://github.com/${headOwner}/${headRepo}.git`,
      ssh_url: `git@github.com:${headOwner}/${headRepo}.git`
    }
  }
  return {
    number,
    title: 'Reword the README',
    state: 'open',
    html_url: options.url ?? `${baseUrl}/pull/${number}`,
    head,
    base: {
      ref: options.baseRef ?? 'main',
      sha: options.baseOid ?? 'b'.repeat(40),
      repo: {
        name: baseRepo,
        owner: { login: baseOwner },
        html_url: baseUrl
      }
    },
    maintainer_can_modify: options.maintainerCanModify ?? false
  }
}

function pullView(number = 3, repository = 'upstream/base'): Record<string, unknown> {
  return {
    number,
    title: 'Reword the README',
    state: 'OPEN',
    url: `https://github.com/${repository}/pull/${number}`,
    headRefName: 'feat/conflict',
    baseRefName: 'main',
    headRefOid: 'a'.repeat(40),
    baseRefOid: 'b'.repeat(40)
  }
}

function issue(number = 4): Record<string, unknown> {
  return {
    number,
    title: 'Add a multiply function',
    html_url: `https://github.com/test-owner/test-repo/issues/${number}`,
    state: 'open'
  }
}

function stateForPull(options: {
  number?: number
  baseOwner?: string
  baseRepo?: string
  headOwner?: string | null
  headRepo?: string
  headOid?: string
  baseOid?: string
  headRef?: string
  baseRef?: string
  maintainerCanModify?: boolean
} = {}, target = { owner: 'upstream', repo: 'base' }): Record<string, unknown> {
  const number = options.number ?? 3
  return {
    responses: {
      [`repos/${target.owner}/${target.repo}/issues/${number}`]: {
        number,
        title: 'Reword the README',
        html_url: `https://github.com/${target.owner}/${target.repo}/issues/${number}`,
        pull_request: { url: `https://api.github.com/repos/${target.owner}/${target.repo}/pulls/${number}` }
      },
      [`repos/${target.owner}/${target.repo}/pulls/${number}`]: pullRequest({
        ...options,
        number,
        baseOwner: options.baseOwner ?? target.owner,
        baseRepo: options.baseRepo ?? target.repo
      })
    },
    prViews: { [`${target.owner}/${target.repo}/${number}`]: pullView(number, `${target.owner}/${target.repo}`) }
  }
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('expected an object result')
  return value as Record<string, unknown>
}

async function hosting(options?: Parameters<typeof bootHosting>[1]): Promise<HostingTest> {
  const instance = await bootHosting(ghFixture, options)
  hosts.push(instance)
  return instance
}

test('worktreeSource resolves #N in configured order, returns fork metadata, and refreshes PR head through API and CLI', async () => {
  const host = await hosting({ remote: 'https://github.com/fork/base.git', upstream: 'https://github.com/upstream/base.git' })
  host.writeState(stateForPull())

  const first = object(await host.call('worktreeSource', { reference: '#3' }))
  expect(first).toMatchObject({
    item: {
      provider: 'github', kind: 'pullRequest', number: 3, title: 'Reword the README',
      url: 'https://github.com/upstream/base/pull/3',
      repository: { host: 'github.com', owner: 'upstream', repo: 'base' }
    },
    head: {
      repository: { host: 'github.com', owner: 'fork-owner', repo: 'fork-base' },
      refName: 'feat/conflict', oid: 'a'.repeat(40),
      sshUrl: 'git@github.com:fork-owner/fork-base.git',
      httpsUrl: 'https://github.com/fork-owner/fork-base.git', maintainerCanModify: false
    },
    base: {
      repository: { host: 'github.com', owner: 'upstream', repo: 'base' },
      refName: 'main', oid: 'b'.repeat(40)
    }
  })
  expect(host.invocations().some(({ args }) => args.includes('repos/upstream/base/pulls/3'))).toBe(true)
  expect(host.invocations().some(({ args }) => args.includes('repos/fork/base/pulls/3'))).toBe(false)
  expect(JSON.stringify(first)).not.toContain('fixture-ambient-token')

  host.writeState(stateForPull({ headOid: 'c'.repeat(40) }))
  const cli = await host.cli([
    '--json', 'hosting', 'worktree-source', '--reference', 'https://github.com/upstream/base/pull/3', '--worktree', host.worktree
  ])
  expect(cli).toMatchObject({ code: 0, stderr: '' })
  expect(object(JSON.parse(cli.stdout)).head).toMatchObject({ oid: 'c'.repeat(40) })
})

test('worktreeSource returns an issue link with exact canonical identity and null PR head and base', async () => {
  const host = await hosting()
  host.writeState({ responses: { 'repos/test-owner/test-repo/issues/4': issue() } })

  expect(await host.call('worktreeSource', { reference: '#4' })).toEqual({
    item: {
      provider: 'github', kind: 'issue', number: 4, title: 'Add a multiply function',
      url: 'https://github.com/test-owner/test-repo/issues/4',
      repository: { host: 'github.com', owner: 'test-owner', repo: 'test-repo' }
    },
    head: null,
    base: null
  })
  expect(host.invocations().some(({ args }) => args.some((arg) => arg.includes('/pulls/4')))).toBe(false)
  expect(await host.call('worktreeSource', { reference: 'https://github.com/test-owner/test-repo/issues/4' }))
    .toMatchObject({ item: { kind: 'issue', url: 'https://github.com/test-owner/test-repo/issues/4' }, head: null, base: null })
  expect(host.invocations().filter(({ args }) => args.includes('repos/test-owner/test-repo/issues/4'))).toHaveLength(2)
})

test('worktreeSource accepts same-repository PR heads and derives safe canonical clone URLs', async () => {
  const host = await hosting()
  host.writeState(stateForPull({ headOwner: 'test-owner', headRepo: 'test-repo' }, { owner: 'test-owner', repo: 'test-repo' }))

  const result = object(await host.call('worktreeSource', { reference: 'https://github.com/test-owner/test-repo/pull/3' }))
  expect(result.head).toMatchObject({
    repository: { host: 'github.com', owner: 'test-owner', repo: 'test-repo' },
    sshUrl: 'git@github.com:test-owner/test-repo.git',
    httpsUrl: 'https://github.com/test-owner/test-repo.git'
  })
})

test('worktreeSource fails closed for unconfigured URLs, missing fork repositories, mismatches, and unavailable reads', async () => {
  const host = await hosting()
  await expect(host.call('worktreeSource', { reference: 'https://attacker.invalid/other/repo/pull/3' }))
    .rejects.toMatchObject({ data: { reason: 'validation_error' } })

  host.writeState(stateForPull({ headOwner: null }, { owner: 'test-owner', repo: 'test-repo' }))
  await expect(host.call('worktreeSource', { reference: '#3' }))
    .rejects.toMatchObject({ data: { reason: 'upstream_unavailable' } })

  host.writeState({ responses: { 'repos/test-owner/test-repo/pulls/3': pullRequest({ url: 'https://github.com/elsewhere/repo/pull/3' }) } })
  await expect(host.call('worktreeSource', { reference: 'https://github.com/test-owner/test-repo/pull/3' }))
    .rejects.toMatchObject({ data: { reason: 'upstream_unavailable' } })

  host.writeState({
    responses: {
      'repos/test-owner/test-repo/pulls/3': pullRequest({
        baseOwner: 'elsewhere',
        baseRepo: 'repo',
        url: 'https://github.com/test-owner/test-repo/pull/3'
      })
    }
  })
  await expect(host.call('worktreeSource', { reference: 'https://github.com/test-owner/test-repo/pull/3' }))
    .rejects.toMatchObject({ data: { reason: 'upstream_unavailable' } })

  host.writeState({ errors: { 'repos/test-owner/test-repo/pulls/3': 'HTTP 401: Bad credentials' } })
  await expect(host.call('worktreeSource', { reference: 'https://github.com/test-owner/test-repo/pull/3' }))
    .rejects.toMatchObject({ data: { reason: 'not_authenticated' } })
  host.writeState({ errors: { 'repos/test-owner/test-repo/pulls/3': 'HTTP 403: API rate limit exceeded' } })
  await expect(host.call('worktreeSource', { reference: 'https://github.com/test-owner/test-repo/pull/3' }))
    .rejects.toMatchObject({ data: { reason: 'rate_limited' } })
})

test('worktreeSource preserves not-found as distinct from unavailable and rejects unsafe PR branches', async () => {
  const host = await hosting()
  host.writeState({ errors: { 'repos/test-owner/test-repo/pulls/3': 'HTTP 404: Not Found' } })
  await expect(host.call('worktreeSource', { reference: 'https://github.com/test-owner/test-repo/pull/3' }))
    .rejects.toMatchObject({ data: { reason: 'not_found' } })

  host.writeState({
    responses: {
      'repos/test-owner/test-repo/pulls/3': pullRequest({ headOwner: 'test-owner', headRepo: 'test-repo', headRef: 'bad..branch' })
    }
  })
  await expect(host.call('worktreeSource', { reference: 'https://github.com/test-owner/test-repo/pull/3' }))
    .rejects.toMatchObject({ data: { reason: 'upstream_unavailable' } })

  const badClone = stateForPull({ headOwner: 'test-owner', headRepo: 'test-repo' }, { owner: 'test-owner', repo: 'test-repo' })
  const responses = object(badClone.responses)
  const pull = object(responses['repos/test-owner/test-repo/pulls/3'])
  const head = object(pull.head)
  object(head.repo).clone_url = 'https://attacker.invalid/test-owner/test-repo.git'
  host.writeState(badClone)
  await expect(host.call('worktreeSource', { reference: 'https://github.com/test-owner/test-repo/pull/3' }))
    .rejects.toMatchObject({ data: { reason: 'upstream_unavailable' } })

  host.writeState(stateForPull(
    { headOwner: 'test-owner', headRepo: 'test-repo', headOid: 'not-an-oid' },
    { owner: 'test-owner', repo: 'test-repo' }
  ))
  await expect(host.call('worktreeSource', { reference: 'https://github.com/test-owner/test-repo/pull/3' }))
    .rejects.toMatchObject({ data: { reason: 'upstream_unavailable' } })
})
