import { afterEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { git, isolateGitConfig } from '../../../quirky.repo/test/git-fixtures'
import { createProcessScope, type ProcessScope } from '../../../../scripts/test-support/process-scope'
import { buttonText, click, messageBox, primary, q, text, type } from './dom'
import { boot, openView, PANEL, SESSION_VIEW, shutdown, type World } from './world'

const { scratch } = isolateGitConfig()
const SLOW = 90_000
const ENV_KEYS = [
  'HOME', 'QUIRKY_HOME', 'XDG_CONFIG_HOME', 'GH_CONFIG_DIR', 'PATH', 'GH_TOKEN', 'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_HOST', 'GH_REPO', 'GH_PROMPT_DISABLED',
  'QUIRKY_TEST_GH_STATE', 'QUIRKY_TEST_GH_SIGNALS', 'QUIRKY_TEST_SCOPE'
]

const ghFixture = String.raw`
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, watch, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
const args = process.argv.slice(2)
const state = JSON.parse(readFileSync(process.env.QUIRKY_TEST_GH_STATE, 'utf8'))
const signalDir = process.env.QUIRKY_TEST_GH_SIGNALS
const input = process.env.QUIRKY_TEST_GH_INPUT ?? ''
const emit = (value) => process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value))
const fail = (message) => { process.stderr.write(message + '\n'); process.exit(1) }
const endpoint = args.find((value) => value.startsWith('repos/')) ?? ''
const branchKey = (branch) => branch.replaceAll('/', '_')
const currentHead = () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd() }).toString().trim()
const lookupFor = (branch) => state.lookups?.[branch] ?? { kind: 'none' }
const reviewFor = (branch, lookup) => {
  const stateName = lookup.state ?? 'OPEN'
  return {
    number: lookup.number,
    id: 'PR_' + lookup.number,
    title: 'Review ' + lookup.number,
    body: 'Fixture review body',
    state: stateName,
    url: 'https://github.com/test-owner/test-repo/pull/' + lookup.number,
    isDraft: stateName === 'DRAFT',
    updatedAt: '2026-10-28T00:00:00Z',
    baseRefName: 'main',
    baseRefOid: 'b'.repeat(40),
    headRefName: branch,
    headRefOid: currentHead(),
    headRepositoryOwner: { login: 'test-owner' },
    headRepository: { name: 'test-repo', owner: { login: 'test-owner' } },
    mergeable: 'MERGEABLE',
    reviewDecision: 'NONE',
    mergeStateStatus: 'CLEAN',
    statusCheckRollup: [],
    autoMergeRequest: null,
    stack: null
  }
}
const restPull = (branch, lookup) => {
  const raw = reviewFor(branch, lookup)
  const merged = raw.state === 'MERGED'
  return {
    number: raw.number,
    html_url: raw.url,
    state: merged || raw.state === 'CLOSED' ? 'closed' : 'open',
    merged_at: merged ? '2026-10-28T00:00:00Z' : null,
    draft: raw.isDraft,
    head: { ref: raw.headRefName, sha: raw.headRefOid, repo: { name: 'test-repo', owner: { login: 'test-owner' } } },
    base: { ref: raw.baseRefName, sha: raw.baseRefOid, repo: { name: 'test-repo', owner: { login: 'test-owner' } } }
  }
}
if (args[0] === '--version') emit('gh version 2.70.0\n')
else if (args[0] === 'auth' && args[1] === 'status') emit('Logged in to github.com account fixture-user (keyring)\nActive account: true\nToken scopes: repo, read:org\n')
else if (args[0] === 'auth' && args[1] === 'token') emit('fixture-token\n')
else if (args[0] === 'repo' && args[1] === 'view') emit({ defaultBranchRef: { name: 'main' } })
else if (args[0] === 'pr' && args[1] === 'view') {
  const number = Number(args[2])
  const match = Object.entries(state.lookups ?? {}).find(([, lookup]) => lookup.number === number)
  if (!match) fail('HTTP 404: Not Found')
  emit(reviewFor(match[0], match[1]))
}
else if (args[0] === 'api' && args.includes('rate_limit')) emit({ resources: { core: { limit: 5000, remaining: 4500, reset: 1999999999 }, graphql: { limit: 5000, remaining: 4500, reset: 1999999999 }, search: { limit: 30, remaining: 30, reset: 1999999999 } } })
else if (args[0] === 'api' && args.includes('user')) emit({ login: 'fixture-user' })
else if (args[0] === 'api' && args.includes('graphql')) {
  const request = input.length === 0 ? {} : JSON.parse(input)
  const variables = request.variables ?? {}
  emit({ data: { repository: {
    id: 'REPO_' + (variables.owner ?? 'test-owner') + '_' + (variables.name ?? 'test-repo'),
    viewerDefaultMergeMethod: 'SQUASH',
    mergeCommitAllowed: true,
    rebaseMergeAllowed: true,
    squashMergeAllowed: true,
    autoMergeAllowed: true,
    defaultBranchRef: { name: 'main' },
    mergeQueue: null,
    ref: { rules: { nodes: [] } }
  } } })
}
else if (args[0] === 'api' && endpoint.includes('/pulls?')) {
  const query = new URLSearchParams(endpoint.split('?')[1] ?? '')
  const branch = (query.get('head') ?? '').split(':').at(-1) ?? ''
  const lookup = lookupFor(branch)
  if (lookup.hold === true) {
    mkdirSync(signalDir, { recursive: true })
    writeFileSync(join(signalDir, 'pending-' + branchKey(branch)), 'pending')
    const releasePath = join(signalDir, 'release-' + branchKey(branch))
    const { promise, resolve } = Promise.withResolvers()
    const watcher = watch(signalDir, { persistent: false }, (_event, filename) => {
      if (filename?.toString() === basename(releasePath) || existsSync(releasePath)) {
        watcher.close()
        resolve()
      }
    })
    if (existsSync(releasePath)) {
      watcher.close()
      resolve()
    }
    await promise
  }
  if (lookup.kind === 'unavailable') fail('HTTP 503: fixture lookup unavailable')
  if (lookup.kind !== 'found') emit([])
  else emit([restPull(branch, lookup)])
  if (lookup.hold === true) writeFileSync(join(signalDir, 'done-' + branchKey(branch)), 'done')
}
else if (args[0] === 'api' && /\/pulls\/\d+$/.test(endpoint)) {
  const number = Number(endpoint.match(/\/pulls\/(\d+)$/)?.[1])
  const match = Object.entries(state.lookups ?? {}).find(([, lookup]) => lookup.number === number)
  if (!match) fail('HTTP 404: Not Found')
  emit(restPull(match[0], match[1]))
}
else fail('Unexpected fixture GitHub command: ' + args.join(' '))
`

type LookupFixture = { kind: 'none' } | { kind: 'unavailable' } | { kind: 'found'; number: number; state?: 'OPEN' | 'DRAFT' | 'CLOSED' | 'MERGED'; hold?: boolean }
type GitHubFixture = {
  setLookup(branch: string, lookup: LookupFixture): void
  pending(branch: string): string
  release(branch: string): void
  done(branch: string): string
}

let savedEnvironment: Map<string, string | undefined> | null = null
let processScope: ProcessScope | null = null
let fixture: GitHubFixture | null = null

afterEach(async () => {
  if (fixture) {
    for (const branch of ['zoe/slow', 'zoe/slow-primary', 'zoe/loading-primary']) fixture.release(branch)
  }
  try {
    await shutdown()
  } finally {
    try {
      await processScope?.cleanup()
    } finally {
      processScope = null
      if (savedEnvironment) {
        for (const [key, value] of savedEnvironment) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
      }
      savedEnvironment = null
      fixture = null
    }
  }
})

function startFixture(root: string): GitHubFixture {
  const bin = join(root, 'bin')
  const signals = join(root, 'signals')
  const statePath = join(root, 'state.json')
  const scope = createProcessScope()
  processScope = scope
  const home = scope.home
  mkdirSync(bin, { recursive: true })
  mkdirSync(home, { recursive: true })
  mkdirSync(join(home, '.config'), { recursive: true })
  mkdirSync(signals, { recursive: true })
  const ghPath = join(bin, 'gh')
  writeFileSync(ghPath, `#!/usr/bin/env bun\n${ghFixture}\n`, { mode: 0o755 })
  chmodSync(ghPath, 0o755)
  writeFileSync(statePath, JSON.stringify({ lookups: { 'zoe/feat': { kind: 'none' } } }))

  savedEnvironment = new Map(ENV_KEYS.map((key) => [key, process.env[key]]))
  process.env.HOME = home
  process.env.QUIRKY_HOME = scope.home
  process.env.QUIRKY_TEST_SCOPE = scope.env.QUIRKY_TEST_SCOPE
  process.env.XDG_CONFIG_HOME = join(home, '.config')
  process.env.GH_CONFIG_DIR = join(home, '.config', 'gh')
  process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ''}`
  process.env.QUIRKY_TEST_GH_STATE = statePath
  process.env.QUIRKY_TEST_GH_SIGNALS = signals
  process.env.GH_PROMPT_DISABLED = '1'
  delete process.env.GH_TOKEN
  delete process.env.GITHUB_TOKEN
  delete process.env.GH_ENTERPRISE_TOKEN
  delete process.env.GITHUB_ENTERPRISE_TOKEN
  delete process.env.GH_HOST
  delete process.env.GH_REPO

  const readState = () => JSON.parse(readFileSync(statePath, 'utf8')) as { lookups: Record<string, LookupFixture> }
  const writeState = (state: unknown) => {
    const temporary = `${statePath}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify(state))
    renameSync(temporary, statePath)
  }
  const signalPath = (action: string, branch: string) => join(signals, `${action}-${branch.replaceAll('/', '_')}`)
  return {
    setLookup(branch, lookup) {
      const state = readState()
      state.lookups[branch] = lookup
      writeState(state)
    },
    pending: (branch) => signalPath('pending', branch),
    release: (branch) => writeFileSync(signalPath('release', branch), 'release'),
    done: (branch) => signalPath('done', branch)
  }
}

async function selectWorktree(w: World, worktree: string, branch: string): Promise<void> {
  await w.agent.callAny('ui.view.open', { id: SESSION_VIEW, input: { worktree } })
  await w.win.waitFor(() => text(q('.scm-branch-name')) === branch)
}
function unsetUpstream(path: string, branch: string): void {
  const upstream = git(path, 'for-each-ref', '--format=%(upstream:short)', `refs/heads/${branch}`)
  if (upstream !== '') git(path, 'branch', '--unset-upstream', branch)
}

function reviewStatus() {
  return q('[data-scm-review-status]')
}
const reviewAction = () => q('.scm-create-review button') as HTMLButtonElement | null

async function waitForReviewState(w: World, kind: string, summary?: string) {
  return w.win.waitFor(() => {
    const status = reviewStatus()
    return status?.getAttribute('data-state') === kind && (summary === undefined || text(status).includes(summary)) ? status : undefined
  })
}
async function waitForPrimary(w: World, label: string, title: string, enabled: boolean): Promise<void> {
  const reported = await w.win.waitFor(async () => {
    const value = (await w.report())?.primary
    return value?.label === label && value.title === title ? value : undefined
  })
  expect(reported).toEqual({ label, enabled, title })
  expect(primary().disabled).toBe(!enabled)
}

async function openGitHubPanel(w: World): Promise<void> {
  await w.agent.callAny('setting.set', { id: 'setting:quirky.agent-status/hooks', value: false })
  await w.agent.callAny('ui.panel.open', { id: PANEL })
  await w.win.waitFor(() => q('.scm-header'))
}

test('GitHub Source Control reports current PR status, ignores stale worktree replies, and hands off guarded creation to Reviews', async () => {
  const root = scratch()
  fixture = startFixture(join(root, 'github-ui'))
  const w = await boot(scratch, { noPanel: true })
  w.git('remote', 'set-url', 'origin', 'https://github.com/test-owner/test-repo.git')
  w.git('remote', 'set-url', '--push', 'origin', w.originDir)
  await openGitHubPanel(w)

  await waitForReviewState(w, 'no-review', 'No pull request is linked')
  expect(buttonText('Create PR')?.disabled).toBe(false)
  const originalHead = w.git('rev-parse', 'HEAD')
  fixture.setLookup('zoe/feat', { kind: 'found', number: 70, state: 'OPEN' })
  const externalRefresh = await w.agent.callAny('quirky.hosting/refresh', {
    candidate: { worktree: w.feat.id, branch: 'zoe/feat', number: 70, headOid: originalHead },
    reason: 'manual'
  })
  expect(externalRefresh).toMatchObject({ kind: 'found', review: { number: 70 } })
  await waitForReviewState(w, 'found', 'Pull request #70 · Open')
  expect(w.git('rev-parse', 'HEAD')).toBe(originalHead)
  expect(buttonText('Create PR')).toBeUndefined()

  const linked = await w.addWorktree('linked')
  fixture.setLookup('zoe/linked', { kind: 'found', number: 71, state: 'OPEN' })
  await selectWorktree(w, linked.id, 'zoe/linked')
  await waitForReviewState(w, 'found', 'Pull request #71 · Open')
  expect(buttonText('Open PR #71')).toBeDefined()
  expect(buttonText('Create PR')).toBeUndefined()

  const unavailable = await w.addWorktree('unavailable')
  fixture.setLookup('zoe/unavailable', { kind: 'unavailable' })
  await selectWorktree(w, unavailable.id, 'zoe/unavailable')
  await waitForReviewState(w, 'unavailable', 'unavailable')
  expect(reviewAction()?.disabled).toBe(true)

  const merged = await w.addWorktree('merged')
  fixture.setLookup('zoe/merged', { kind: 'found', number: 73, state: 'MERGED' })
  await selectWorktree(w, merged.id, 'zoe/merged')
  await waitForReviewState(w, 'found', 'Pull request #73 · Merged')
  expect(buttonText('Create PR')).toBeUndefined()

  const closed = await w.addWorktree('closed')
  fixture.setLookup('zoe/closed', { kind: 'found', number: 74, state: 'CLOSED' })
  await selectWorktree(w, closed.id, 'zoe/closed')
  await waitForReviewState(w, 'found', 'Pull request #74 · Closed')
  expect(buttonText('Create PR')).toBeUndefined()

  const slow = await w.addWorktree('slow')
  const current = await w.addWorktree('current')
  fixture.setLookup('zoe/slow', { kind: 'found', number: 75, state: 'OPEN', hold: true })
  fixture.setLookup('zoe/current', { kind: 'found', number: 76, state: 'OPEN' })
  await selectWorktree(w, slow.id, 'zoe/slow')
  await w.win.waitFor(() => existsSync(fixture!.pending('zoe/slow')))
  await waitForReviewState(w, 'loading', 'Checking for a pull request')
  expect(reviewAction()?.disabled).toBe(true)

  await selectWorktree(w, current.id, 'zoe/current')
  await waitForReviewState(w, 'found', 'Pull request #76 · Open')
  const shownStates: string[] = []
  const observer = new MutationObserver(() => shownStates.push(text(reviewStatus())))
  observer.observe(reviewStatus()!.parentElement!, { subtree: true, childList: true, characterData: true })
  try {
    fixture.release('zoe/slow')
    await w.win.waitFor(() => existsSync(fixture!.done('zoe/slow')))
    const slowStatus = await w.agent.callAny('quirky.git/status', { worktree: slow.id }) as { head: string }
    const slowReply = await w.agent.callAny('quirky.hosting/forBranch', {
      worktree: slow.id, branch: 'zoe/slow', headOid: slowStatus.head
    }) as { kind?: string; review?: { number?: number } }
    expect(slowReply).toMatchObject({ kind: 'found', review: { number: 75 } })
    await selectWorktree(w, current.id, 'zoe/current')
    await w.win.waitFor(() => text(reviewStatus()).includes('Pull request #76 · Open'))
    expect(shownStates.some((state) => state.includes('Pull request #75'))).toBe(false)
  } finally {
    observer.disconnect()
  }

  const preparation = await w.addWorktree('prepare')
  unsetUpstream(preparation.path, 'zoe/prepare')
  await selectWorktree(w, preparation.id, 'zoe/prepare')
  await waitForReviewState(w, 'no-review', 'No pull request is linked')
  const before = git(preparation.path, 'rev-parse', 'HEAD')
  writeFileSync(join(preparation.path, 'math.ts'), 'a\nB\nc\nd\ne\n')
  await w.win.waitFor(() => q('.scm-row-main[title="math.ts"]'))
  expect(buttonText('Commit, push & Create PR')?.disabled).toBe(true)
  expect(git(preparation.path, 'rev-parse', 'HEAD')).toBe(before)

  await type(messageBox(), 'Prepare guarded pull request')
  const create = await w.win.waitFor(() => {
    const button = buttonText('Commit, push & Create PR')
    return button && !button.disabled ? button : undefined
  })
  await click(create)
  const view = await w.win.waitFor(async () => {
    const currentView = await openView(w)
    return currentView?.id === 'view:quirky.reviews/create' ? currentView : undefined
  })
  const after = git(preparation.path, 'rev-parse', 'HEAD')
  expect(view.input).toEqual({ worktree: preparation.id })
  expect(after).not.toBe(before)
  expect(git(preparation.path, 'rev-parse', 'origin/zoe/prepare')).toBe(after)
  expect(git(preparation.path, 'log', '-1', '--format=%s')).toBe('Prepare guarded pull request')
  expect(w.problems()).toEqual([])
}, SLOW)

test('SC-28: unpublished primary waits for current GitHub state before publishing', async () => {
  const root = scratch()
  fixture = startFixture(join(root, 'github-primary'))
  const w = await boot(scratch, { noPanel: true })
  w.git('remote', 'set-url', 'origin', 'https://github.com/test-owner/test-repo.git')
  w.git('remote', 'set-url', '--push', 'origin', w.originDir)
  await openGitHubPanel(w)

  const noReview = await w.addWorktree('no-review-primary')
  unsetUpstream(noReview.path, 'zoe/no-review-primary')
  fixture.setLookup('zoe/no-review-primary', { kind: 'none' })
  await selectWorktree(w, noReview.id, 'zoe/no-review-primary')
  await waitForReviewState(w, 'no-review', 'No pull request is linked')
  await waitForPrimary(w, 'Publish Branch', 'Publish this branch to origin', true)

  const loading = await w.addWorktree('loading-primary')
  unsetUpstream(loading.path, 'zoe/loading-primary')
  fixture.setLookup('zoe/loading-primary', { kind: 'found', number: 81, state: 'OPEN', hold: true })
  await selectWorktree(w, loading.id, 'zoe/loading-primary')
  await w.win.waitFor(() => existsSync(fixture!.pending('zoe/loading-primary')))
  await waitForReviewState(w, 'loading', 'Checking for a pull request')
  await waitForPrimary(w, 'Publish Branch', 'Checking GitHub pull-request status before publishing this branch.', false)
  fixture.release('zoe/loading-primary')
  await w.win.waitFor(() => existsSync(fixture!.done('zoe/loading-primary')))
  await waitForReviewState(w, 'found', 'Pull request #81 · Open')

  const unavailable = await w.addWorktree('unavailable-primary')
  unsetUpstream(unavailable.path, 'zoe/unavailable-primary')
  fixture.setLookup('zoe/unavailable-primary', { kind: 'unavailable' })
  await selectWorktree(w, unavailable.id, 'zoe/unavailable-primary')
  await waitForReviewState(w, 'unavailable', 'unavailable')
  await waitForPrimary(w, 'Publish Branch', 'GitHub pull-request status is unavailable. Retry before publishing this branch.', false)
  writeFileSync(join(unavailable.path, 'math.ts'), 'changed while lookup was unavailable\n')
  await w.win.waitFor(() => text(primary()) === 'Stage All')
  expect(primary().disabled).toBe(false)

  const merged = await w.addWorktree('merged-primary')
  unsetUpstream(merged.path, 'zoe/merged-primary')
  fixture.setLookup('zoe/merged-primary', { kind: 'found', number: 82, state: 'MERGED' })
  await selectWorktree(w, merged.id, 'zoe/merged-primary')
  await waitForReviewState(w, 'found', 'Pull request #82 · Merged')
  await waitForPrimary(w, 'Publish Branch', 'Nothing to commit. PR is already merged.', false)
  expect(w.problems()).toEqual([])
}, SLOW)
