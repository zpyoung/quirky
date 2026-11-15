import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { afterEach, expect, test } from 'bun:test'
import { QuirkyClient } from '@quirky/protocol'
import { isDaemonAlive, readRuntime, rpcUrl } from '@quirky/protocol/node'
import { eventually, startWorkerAcceptance, type WorkerAcceptance } from '../../quirky.orchestration/test/workers/acceptance-support'
import { GITHUB_STAND_IN, standInState, type StandInState } from '../../quirky.sitter/test/github-stand-in'

type Entry = {
  kind: string; seq: number; attemptId?: string; state?: string; effect?: string; dispatchId?: string
  action?: { kind: string; evidenceKey: string; contentIdentity?: string }
  handoff?: { watcherId: string; kind: string }
}
type Inspection = {
  enrollment: { watcherId: string; kind: string; workspacePath: string; worktreeId?: string | null; kindPayload: Record<string, unknown>; capabilities: Record<string, string> }
  journal: Entry[]
  status: { state: string; reason?: string; detail?: string } | null
  summary?: { state: string; reason: string } | null
}
type Show = Inspection & { openEscalations: { escalationId: string; approvalScope?: { actionKind: string; evidenceKey: string; contentIdentity: string } }[] }
type Detail = {
  landings: { rung: string; payload: Record<string, unknown> }[]
  completion: { state: string; requestedBar: string; reachedBar: string | null; reason: string; handoff: { watcherId: string; kind: string } | null; mergedEvidence: { watcherId: string; observedAtMs: number; review: { headSha: string } } | null }
  next: { reason: string | null }
}
type State = StandInState & { loseCreateReply?: boolean; lookupUnavailable?: boolean }
type Fixture = { worker: WorkerAcceptance; bare: string; writes: string; read(): State; save(value: State): void }
let active: Fixture | undefined
let restarted: (() => Promise<void>) | undefined
afterEach(async () => {
  try { await restarted?.() } finally { restarted = undefined; await active?.worker.cleanup(); active = undefined }
})

function git(repo: string, ...args: string[]): string {
  return execFileSync('/usr/bin/git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', HOME: repo, QUIRKY_HOME: repo, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
  }).trim()
}
async function jsonCli<T>(worker: WorkerAcceptance, args: string[]): Promise<T> {
  const result = await worker.fixture.cli([...args, '--json'])
  if (result.code !== 0) throw new Error(`${args.join(' ')}: ${result.stderr}\n${result.stdout}`)
  return JSON.parse(result.stdout) as T
}
async function inspect(worker: WorkerAcceptance, watcherId: string): Promise<Inspection> {
  const all = await worker.fixture.call('quirky.heimdall/inspect', { watcherId }) as Inspection[]
  const found = all.find(value => value.enrollment.watcherId === watcherId)
  if (!found) throw new Error(`Missing watcher ${watcherId}`)
  return found
}
async function detail(worker: WorkerAcceptance, watcherId: string): Promise<Detail> {
  return jsonCli(worker, ['heimdall', 'objective', watcherId])
}
async function progressingDetail(worker: WorkerAcceptance, watcherId: string): Promise<Detail> {
  const [projection, current] = await Promise.all([detail(worker, watcherId), inspect(worker, watcherId)])
  if (current.status?.state === 'parked' || current.status?.reason === 'tick-error') {
    throw new Error(`Objective stopped progressing: ${JSON.stringify({
      status: current.status, completion: projection.completion, next: projection.next,
      escalations: current.journal.filter(entry => entry.kind === 'escalation').slice(-2),
    })}`)
  }
  return projection
}
async function reconcile(worker: WorkerAcceptance, watcherId: string): Promise<void> {
  await worker.fixture.call('quirky.heimdall/reconcile', { watcherId })
}
async function held(worker: WorkerAcceptance, watcherId: string, action: string): Promise<Show['openEscalations'][number]> {
  const shown = await eventually(async () => {
    const value = await jsonCli<Show>(worker, ['heimdall', 'show', watcherId])
    if (value.status?.reason === 'tick-error') throw new Error(`Watcher tick failed while awaiting ${action}: ${value.status.detail}`)
    const objective = value.enrollment.kind === 'objective'
      ? await worker.fixture.call('quirky.objective/detail', { watcherId }) as Detail | null
      : null
    if (value.status?.state === 'parked') {
      const eligibility = value.enrollment.worktreeId
        ? await worker.fixture.call('quirky.hosting/creationEligibility', { worktree: value.enrollment.worktreeId, title: 'Fixture diagnostics' }).catch(error => String(error))
        : null
      throw new Error(`Watcher parked before ${action}: ${JSON.stringify({ status: value.status, next: objective?.next, landings: objective?.landings, eligibility })}`)
    }
    if (objective?.next.reason?.startsWith('creation-blocked:') || objective?.next.reason?.includes('unavailable')) {
      throw new Error(`Objective cannot reach ${action}: ${objective.next.reason}`)
    }
    return { status: value.status, next: objective?.next ?? null, openEscalations: value.openEscalations }
  }, value => value.openEscalations.some(entry => entry.approvalScope?.actionKind === action), `approval ${action}`, 90_000)
  return shown.openEscalations.find(entry => entry.approvalScope?.actionKind === action)!
}
async function approve(worker: WorkerAcceptance, watcherId: string, action: string): Promise<Show['openEscalations'][number]> {
  const escalation = await held(worker, watcherId, action)
  expect(await jsonCli(worker, ['heimdall', 'approve', watcherId, escalation.escalationId])).toMatchObject({ kind: 'applied' })
  await reconcile(worker, watcherId)
  return escalation
}
async function running(worker: WorkerAcceptance, watcherId: string, action: string): Promise<Entry> {
  const entry = await eventually(async () => (await inspect(worker, watcherId)).journal.filter(entry => entry.kind === 'attempt' && entry.action?.kind === action).at(-1), value => value?.state === 'running' && typeof value.dispatchId === 'string', `worker ${action}`, 90_000)
  return entry!
}
async function report(worker: WorkerAcceptance, watcherId: string, entry: Entry, value: unknown): Promise<void> {
  const current = await inspect(worker, watcherId) as Inspection & { enrollment: { orchestrationRunId: string } }
  const listed = await worker.fixture.call('quirky.orchestration/taskList', { runId: current.enrollment.orchestrationRunId }) as { tasks: { id: string; spec: string }[] }
  const task = listed.tasks.find(task => task.spec.includes(`/.quirky/objective/${watcherId}/${entry.attemptId}.json`))
  if (!task) throw new Error('Missing objective task')
  const reportPath = task.spec.match(/^REPORT PATH: (.+)$/m)?.[1]
  if (!reportPath) throw new Error('Missing issued report path')
  writeFileSync(reportPath, JSON.stringify(value))
  const session = await eventually(() => worker.fixture.call('quirky.orchestration/workerShow', { dispatchId: entry.dispatchId }) as Promise<{ worker: { sessionId: string | null } }>, value => typeof value.worker?.sessionId === 'string', 'launched worker session', 90_000)
  expect(await worker.callAs(session.worker.sessionId!, 'send', ['--type', 'worker_done', '--task-id', task.id, '--dispatch-id', entry.dispatchId!, '--outcome', 'succeeded', '--subject', 'Remote objective report', '--body', 'Assigned work complete.', '--report-path', reportPath])).toMatchObject({ report: { status: 'accepted' } })
  await reconcile(worker, watcherId)
}

async function fixture(hosted: boolean): Promise<Fixture> {
  const worker = await startWorkerAcceptance()
  const { repo, home, fakebin } = worker.fixture
  const bare = join(home, 'fixture.git')
  const statePath = join(home, 'state.json')
  const writes = join(home, 'remote-writes.jsonl')
  const f: Fixture = {
    worker, bare, writes,
    read: () => JSON.parse(readFileSync(statePath, 'utf8')) as State,
    save(value) { const tmp = statePath + '.tmp'; writeFileSync(tmp, JSON.stringify(value)); renameSync(tmp, statePath) },
  }
  active = f
  git(repo, 'config', 'user.name', 'Fixture')
  git(repo, 'config', 'user.email', 'fixture@example.test')
  git(repo, 'config', 'commit.gpgsign', 'false')
  git(repo, 'branch', '-M', 'main')
  git(repo, 'init', '--bare', bare)
  git(repo, 'push', bare, 'HEAD:refs/heads/main')
  git(repo, 'switch', '-c', 'feature')
  git(repo, 'remote', 'add', 'origin', hosted ? 'https://github.com/test-owner/test-repo.git' : bare)
  if (hosted) git(repo, 'update-ref', 'refs/remotes/origin/main', git(repo, 'rev-parse', 'main'))
  writeFileSync(writes, '')
  f.save(standInState({ prs: [], checkRuns: [], mergeVisible: true }))
  const source = join(home, 'github.mjs')
  writeFileSync(source, GITHUB_STAND_IN)
  const template = standInState().prs[0]!
  const gh = join(fakebin, 'gh')
  writeFileSync(gh, `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
const statePath = ${JSON.stringify(statePath)}
const args = process.argv.slice(2)
const input = await new Response(Bun.stdin.stream()).text()
const state = JSON.parse(readFileSync(statePath, 'utf8'))
const save = () => { const tmp = statePath + '.' + process.pid; writeFileSync(tmp, JSON.stringify(state)); renameSync(tmp, statePath) }
const option = name => args[args.indexOf(name) + 1]
const reviewRead = args[0] === 'pr' && args[1] === 'view' || args[0] === 'api' && args.some(arg => arg.includes('/pulls'))
if (state.lookupUnavailable && reviewRead) { console.error('fixture lookup unavailable'); process.exit(1) }
if (args[0] === 'pr' && args[1] === 'create') {
  if (option('--repo') !== 'github.com/test-owner/test-repo' || option('--base') !== 'main' || option('--head') !== 'feature') throw new Error('Refusing nonfixture review creation: ' + JSON.stringify(args))
  if (state.prs.length) throw new Error('Duplicate review creation')
  const head = execFileSync('/usr/bin/git', ['--git-dir', ${JSON.stringify(bare)}, 'rev-parse', 'refs/heads/feature'], { encoding: 'utf8' }).trim()
  state.prs.push({ ...${JSON.stringify(template)}, headRefOid: head, baseRefOid: execFileSync('/usr/bin/git', ['--git-dir', ${JSON.stringify(bare)}, 'rev-parse', 'refs/heads/main'], {encoding:'utf8'}).trim(), mergeStateStatus: 'CLEAN', title: option('--title'), body: readFileSync(option('--body-file'), 'utf8') })
  appendFileSync(${JSON.stringify(writes)}, JSON.stringify({ kind: 'create', args, head }) + '\\n')
  if (state.loseCreateReply) { state.lookupUnavailable = true; save(); console.error('connection lost after create'); process.exit(1) }
  save(); console.log(state.prs[0].url); process.exit(0)
}
if (args[0] === 'pr' && args[1] === 'merge' || args.some(arg => arg.endsWith('/merge-async'))) appendFileSync(${JSON.stringify(writes)}, JSON.stringify({ kind: 'merge', args, input }) + '\\n')
process.env.QUIRKY_TEST_FIXTURE_DIR = ${JSON.stringify(home)}
process.env.QUIRKY_TEST_GH_INPUT = input
// the generated stand-in reads its fixture environment during module initialization
await import(${JSON.stringify(source)})
`)
  chmodSync(gh, 0o755)
  const wrapper = join(fakebin, 'git')
  writeFileSync(wrapper, `#!${process.execPath}
import { appendFileSync } from 'node:fs'
const args = process.argv.slice(2)
const command = args.findIndex(arg => arg === 'push' || arg === 'ls-remote' || arg === 'fetch')
if (command >= 0) {
  const urls = args.map((arg,index) => ({arg,index})).filter(({arg}) => arg === 'https://github.com/test-owner/test-repo.git' || arg === ${JSON.stringify(bare)})
  if (urls.length !== 1 || args[command] === 'fetch') { console.error('Refusing nonfixture network Git command: ' + JSON.stringify(args)); process.exit(1) }
  args[urls[0].index] = ${JSON.stringify(bare)}
  if (args[command] === 'push') {
    if (args.some(arg => arg === '-f' || arg.startsWith('--force')) || !/^(?:[0-9a-f]{40}|[0-9a-f]{64}):refs\\/heads\\/.+$/.test(args.at(-1) ?? '')) throw new Error('Fixture requires one normal full-SHA exact-ref push')
    appendFileSync(${JSON.stringify(writes)}, JSON.stringify({ kind: 'push', args }) + '\\n')
  }
}
const child = Bun.spawn(['/usr/bin/git', ...args], { env: process.env, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' })
process.on('SIGTERM', () => child.kill('SIGTERM'))
process.exitCode = await child.exited
`)
  chmodSync(wrapper, 0o755)
  if (hosted) {
    const workspace = await worker.fixture.call('quirky.worktree/resolve', { selector: `path:${repo}` }) as { id: string }
    await worker.fixture.call('quirky.hosting/diagnoseAuth', { worktree: workspace.id, force: true })
  }
  return f
}
function mutations(f: Fixture, kind: string): Record<string, unknown>[] {
  return readFileSync(f.writes, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>).filter(value => value.kind === kind)
}
async function completeWork(f: Fixture, bar: string): Promise<{ watcherId: string; commitApproval: Show['openEscalations'][number] }> {
  const { worker } = f
  const created = await jsonCli<{ kind: string; enrollment: { watcherId: string } }>(worker, ['heimdall', 'create', 'objective', '--worktree', `path:${worker.fixture.repo}`, '--objective', '\nPublish the approved feature\nOnly the approved content.', '--tier', 'express', '--territory', 'src/**', '--landing-bar', bar])
  expect(created.kind).toBe('enrolled')
  const watcherId = created.enrollment.watcherId
  await reconcile(worker, watcherId)
  await approve(worker, watcherId, 'dispatch-planner')
  const planner = await running(worker, watcherId, 'dispatch-planner')
  await report(worker, watcherId, planner, { plan: { tasks: [{ taskKey: 'feature', title: 'Implement feature', spec: 'Write src/feature.ts.', deps: [], territory: ['src/**'], criteria: [{ body: 'The feature is present', shellCheckable: true, checkCommand: 'grep -q feature src/feature.ts' }] }] }, assumptions: [] })
  await approve(worker, watcherId, 'activate-plan')
  const implementer = await running(worker, watcherId, 'dispatch-node')
  mkdirSync(join(worker.fixture.repo, 'src'), { recursive: true })
  writeFileSync(join(worker.fixture.repo, 'src/feature.ts'), 'export const feature = true\n')
  await report(worker, watcherId, implementer, { taskKey: 'feature', summary: 'Implemented feature', filesModified: ['src/feature.ts'], criteriaSelfAssessment: [{ criterionIndex: 0, result: 'pass', note: 'Feature present' }] })
  const commitApproval = await approve(worker, watcherId, 'commit-local-branch')
  return { watcherId, commitApproval }
}
async function pushed(f: Fixture, watcherId: string, commitApproval: Show['openEscalations'][number]): Promise<string> {
  const escalation = await held(f.worker, watcherId, 'push-ref')
  expect(escalation.approvalScope?.evidenceKey).not.toBe(commitApproval.approvalScope?.evidenceKey)
  expect(mutations(f, 'push')).toEqual([])
  expect(git(f.worker.fixture.repo, 'ls-remote', f.bare, 'refs/heads/feature')).toBe('')
  await approve(f.worker, watcherId, 'push-ref')
  const head = git(f.worker.fixture.repo, 'rev-parse', 'HEAD')
  await eventually(() => git(f.worker.fixture.repo, 'ls-remote', f.bare, 'refs/heads/feature'), value => value === `${head}\trefs/heads/feature`, 'exact bare destination', 90_000)
  return head
}
async function restart(f: Fixture): Promise<void> {
  const { fixture } = f.worker
  const old = readRuntime(fixture.home)
  if (!old) throw new Error('Missing isolated daemon runtime')
  process.kill(old.pid, 'SIGTERM')
  await eventually(() => isDaemonAlive(old), alive => !alive, 'isolated daemon shutdown', 20_000)
  await restarted?.()
  fixture.client.close()
  const root = dirname(fixture.home)
  const daemon = fixture.processScope.spawn([process.execPath, resolve(import.meta.dir, '../../../packages/daemon/src/main.ts')], {
    env: {
      QUIRKY_HOME: fixture.home, HOME: fixture.userHome, SHELL: join(root, 'shells', 'sh'),
      PATH: `${fixture.fakebin}:/usr/bin:/bin`, QUIRKY_AGENT_SEARCH_DIRS: '',
      QUIRKY_PORT: '0', QUIRKY_TEST_AGENT_TIME_SCALE: '0.1',
      WORKER_TEST_CLI: resolve(import.meta.dir, '../../../packages/cli/src/main.ts'),
      ...fixture.processScope.env,
    },
    stdout: Bun.file(join(root, `restart-${old.pid}.log`)),
    stderr: Bun.file(join(root, `restart-${old.pid}.log`)),
  })
  const runtime = await eventually(async () => {
    if (daemon.exitCode !== null) throw new Error(`Restart exited ${daemon.exitCode}`)
    const current = readRuntime(fixture.home)
    return current && current.pid !== old.pid && await isDaemonAlive(current) ? current : null
  }, value => value !== null, 'restarted isolated daemon', 20_000)
  const client = await QuirkyClient.connect(rpcUrl(runtime!), { role: 'cli', name: 'remote-objective-restart' })
  fixture.client = client
  fixture.call = (method, params = {}) => client.callAny(method, params)
  restarted = async () => { client.close() }
}

test('pushed-ref reaches the exact bare ref and stops without a review', async () => {
  const f = await fixture(false)
  const { watcherId, commitApproval } = await completeWork(f, 'pushed-ref')
  const head = await pushed(f, watcherId, commitApproval)
  await eventually(() => inspect(f.worker, watcherId), value => value.status?.state === 'terminal', 'pushed terminal', 90_000)
  expect((await detail(f.worker, watcherId)).completion).toMatchObject({ state: 'landed', reachedBar: 'pushed-ref', reason: 'pushed-ref landing bar reached' })
  expect(git(f.worker.fixture.repo, 'ls-remote', f.bare, 'refs/heads/feature')).toBe(`${head}\trefs/heads/feature`)
  expect(mutations(f, 'push')).toHaveLength(1)
  expect(mutations(f, 'create')).toEqual([])
  expect(mutations(f, 'merge')).toEqual([])
  const all = await f.worker.fixture.call('quirky.heimdall/inspect', {}) as Inspection[]
  expect(all.filter(value => value.enrollment.kind === 'hosted-review')).toEqual([])
}, 300_000)

test('handoff reports hosted-review completion but never premature merged completion', async () => {
  const f = await fixture(true)
  const { watcherId, commitApproval } = await completeWork(f, 'hosted-review')
  const head = await pushed(f, watcherId, commitApproval)
  const reviewApproval = await held(f.worker, watcherId, 'open-hosted-review')
  expect(reviewApproval.approvalScope?.evidenceKey).not.toBe(commitApproval.approvalScope?.evidenceKey)
  expect(mutations(f, 'create')).toEqual([])
  await approve(f.worker, watcherId, 'open-hosted-review')
  const completed = await eventually(() => progressingDetail(f.worker, watcherId), value => value.completion?.state === 'landed', 'hosted-review handoff', 90_000)
  expect(completed.completion).toMatchObject({ requestedBar: 'hosted-review', reachedBar: 'hosted-review', reason: 'hosted-review landing bar reached' })
  const child = await inspect(f.worker, completed.completion.handoff!.watcherId)
  expect(child.enrollment.capabilities).toEqual({ updateBranch: 'off', resolveConflicts: 'off', fixChecks: 'off', merge: 'off' })
  expect(child.enrollment.kindPayload).toMatchObject({ mergeCheckScope: 'all', branchUpdateMode: 'merge-base-update', mergeMethod: null, expectedReview: { headSha: head } })
  expect((await inspect(f.worker, watcherId)).summary).toMatchObject({ state: 'landed' })
  expect(f.read().prs[0]).toMatchObject({ title: 'Publish the approved feature', isDraft: false, headRefOid: head })
  expect(f.read().prs[0]!.body).toContain('The feature is present')
  expect(mutations(f, 'create')).toHaveLength(1)
  expect(mutations(f, 'merge')).toEqual([])
  const moved = f.worker.fixture.repo + '-moved'
  renameSync(f.worker.fixture.repo, moved)
  try {
    const historical = await f.worker.fixture.call('quirky.objective/detail', { watcherId }) as Detail
    expect(historical.completion).toEqual(completed.completion)
  } finally {
    renameSync(moved, f.worker.fixture.repo)
  }
}, 300_000)

test('merged waits for the pinned sitter merge and survives restart', async () => {
  const f = await fixture(true)
  const { watcherId, commitApproval } = await completeWork(f, 'merged')
  const head = await pushed(f, watcherId, commitApproval)
  await approve(f.worker, watcherId, 'open-hosted-review')
  const waiting = await eventually(() => progressingDetail(f.worker, watcherId), value => value.completion?.state === 'waiting' && value.completion.handoff !== null, 'merged handoff', 90_000)
  const successor = waiting.completion.handoff!.watcherId
  expect(waiting.completion.reachedBar).toBe('hosted-review')
  expect(waiting.next.reason).toBe('awaiting-sitter-merge')
  expect((await inspect(f.worker, watcherId)).summary).toMatchObject({ state: 'handed-off' })
  const child = await inspect(f.worker, successor)
  expect(child.enrollment.capabilities).toEqual({ updateBranch: 'off', resolveConflicts: 'off', fixChecks: 'off', merge: 'gated' })
  const mergeApproval = await held(f.worker, successor, 'merge')
  expect(mergeApproval.approvalScope?.contentIdentity).toContain(head)
  expect((await detail(f.worker, watcherId)).completion.state).toBe('waiting')
  expect(mutations(f, 'merge')).toEqual([])
  await restart(f)
  expect((await detail(f.worker, watcherId)).completion).toMatchObject({ state: 'waiting', reachedBar: 'hosted-review', handoff: { watcherId: successor } })
  const changed = f.read()
  changed.prs[0]!.headRefOid = (head[0] === 'a' ? 'b' : 'a') + head.slice(1)
  changed.prs[0]!.state = 'MERGED'
  f.save(changed)
  await reconcile(f.worker, successor)
  const parked = await eventually(() => inspect(f.worker, successor), value => value.status?.state === 'parked', 'moved-head sitter hold', 90_000)
  expect(parked.status?.detail).toContain('objective-head-moved')
  expect(parked.summary).toBeNull()
  expect((await detail(f.worker, watcherId)).completion.state).toBe('blocked')
  expect(mutations(f, 'merge')).toEqual([])
  const restored = f.read()
  restored.prs[0]!.headRefOid = head
  restored.prs[0]!.state = 'OPEN'
  f.save(restored)
  expect(await jsonCli(f.worker, ['heimdall', 'resume', successor])).toMatchObject({ kind: 'applied' })
  await reconcile(f.worker, successor)
  await approve(f.worker, successor, 'merge')
  await eventually(() => inspect(f.worker, successor), value => value.summary?.state === 'merged', 'pinned merged observation', 90_000)
  const landed = await detail(f.worker, watcherId)
  expect(landed.completion).toMatchObject({ state: 'landed', reachedBar: 'merged', reason: 'merged landing bar reached', mergedEvidence: { watcherId: successor, observedAtMs: expect.any(Number), review: { headSha: head } } })
  expect((await inspect(f.worker, watcherId)).summary).toMatchObject({ state: 'handed-off' })
  expect(mutations(f, 'merge')).toHaveLength(1)
  await restart(f)
  expect((await detail(f.worker, watcherId)).completion).toEqual(landed.completion)
  expect(mutations(f, 'merge')).toHaveLength(1)
}, 300_000)

test('remote uncertainty survives restart and resolves without a second mutation', async () => {
  const f = await fixture(true)
  const { watcherId, commitApproval } = await completeWork(f, 'hosted-review')
  const head = await pushed(f, watcherId, commitApproval)
  f.save({ ...f.read(), loseCreateReply: true })
  await approve(f.worker, watcherId, 'open-hosted-review')
  const uncertain = await eventually(() => inspect(f.worker, watcherId), value => value.journal.some(entry => entry.kind === 'attempt' && entry.action?.kind === 'open-hosted-review' && entry.effect === 'indeterminate'), 'indeterminate create', 90_000)
  expect(uncertain.status?.state).not.toBe('terminal')
  expect(f.read().prs[0]?.headRefOid).toBe(head)
  expect(mutations(f, 'create')).toHaveLength(1)
  await restart(f)
  await reconcile(f.worker, watcherId)
  expect((await detail(f.worker, watcherId)).completion.state).not.toBe('landed')
  expect(mutations(f, 'create')).toHaveLength(1)
  f.save({ ...f.read(), lookupUnavailable: false })
  await reconcile(f.worker, watcherId)
  const recovered = await eventually(() => progressingDetail(f.worker, watcherId), value => value.completion?.state === 'landed', 'read-only create recovery', 90_000)
  expect(recovered.completion.reachedBar).toBe('hosted-review')
  expect(mutations(f, 'create')).toHaveLength(1)
  expect(mutations(f, 'push')).toHaveLength(1)
}, 300_000)

test('remote approval cannot follow changed content branch or destination', async () => {
  const f = await fixture(false)
  const { watcherId } = await completeWork(f, 'pushed-ref')
  const original = await held(f.worker, watcherId, 'push-ref')
  git(f.worker.fixture.repo, 'config', 'branch.feature.remote', 'origin')
  git(f.worker.fixture.repo, 'config', 'branch.feature.merge', 'refs/heads/approved-destination')
  await f.worker.fixture.cli(['heimdall', 'approve', watcherId, original.escalationId, '--json'])
  await reconcile(f.worker, watcherId)
  const retargeted = await eventually(() => jsonCli<Show>(f.worker, ['heimdall', 'show', watcherId]), value => value.openEscalations.some(entry => entry.approvalScope?.actionKind === 'push-ref' && entry.approvalScope.evidenceKey !== original.approvalScope?.evidenceKey), 'new destination approval', 90_000)
  const current = retargeted.openEscalations.find(entry => entry.approvalScope?.actionKind === 'push-ref' && entry.approvalScope.evidenceKey !== original.approvalScope?.evidenceKey)!
  expect(mutations(f, 'push')).toEqual([])
  expect(git(f.worker.fixture.repo, 'ls-remote', f.bare, 'refs/heads/feature', 'refs/heads/approved-destination')).toBe('')
  expect(await jsonCli(f.worker, ['heimdall', 'approve', watcherId, current.escalationId])).toMatchObject({ kind: 'applied' })
  await reconcile(f.worker, watcherId)
  const head = git(f.worker.fixture.repo, 'rev-parse', 'HEAD')
  await eventually(() => detail(f.worker, watcherId), value => value.completion?.state === 'landed', 'approved destination publication', 90_000)
  expect(git(f.worker.fixture.repo, 'ls-remote', f.bare, 'refs/heads/approved-destination')).toBe(`${head}\trefs/heads/approved-destination`)
  expect(git(f.worker.fixture.repo, 'ls-remote', f.bare, 'refs/heads/feature')).toBe('')
  expect(mutations(f, 'push')).toHaveLength(1)
}, 300_000)
