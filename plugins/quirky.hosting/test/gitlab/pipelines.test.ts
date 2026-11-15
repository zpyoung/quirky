import { afterEach, expect, test } from 'bun:test'
import { bootGitLab, type GitLabWorld } from './world'
import { mergeRequest } from './stand-in'

let active: GitLabWorld | undefined
async function boot(options: Parameters<typeof bootGitLab>[0] = {}): Promise<GitLabWorld> {
  active = await bootGitLab(options)
  return active
}
afterEach(async () => {
  await active?.cleanup()
  active = undefined
})

const reason = (value: string) => ({ data: { reason: value } })
async function expectInputRejected(request: Promise<unknown>): Promise<void> {
  const error = await request.then(() => undefined, value => value)
  const rejected = error !== undefined && typeof error === 'object' && error !== null && (
    ('code' in error && error.code === -32602)
    || ('data' in error && typeof error.data === 'object' && error.data !== null && !Array.isArray(error.data)
      && 'reason' in error.data && error.data.reason === 'invalid_input')
  )
  expect(rejected).toBe(true)
}
function errorReasonValue(error: unknown): unknown {
  if (typeof error !== 'object' || error === null || !('data' in error)) return undefined
  const data = error.data
  return typeof data === 'object' && data !== null && !Array.isArray(data) && 'reason' in data
    ? data.reason
    : undefined
}
function errorDataValue(error: unknown, key: string): unknown {
  if (typeof error !== 'object' || error === null || !('data' in error)) return undefined
  const data = error.data
  return typeof data === 'object' && data !== null && !Array.isArray(data) ? Reflect.get(data, key) : undefined
}
const projectPath = (world: GitLabWorld) => `/api/v4/projects/${encodeURIComponent(`${world.identity.owner}/${world.identity.repo}`)}`
const mergeRequestPath = (world: GitLabWorld, number = 5) => `${projectPath(world)}/merge_requests/${number}`
const pipelinePath = (world: GitLabWorld, id: number) => `${projectPath(world)}/pipelines/${id}`
const pipelineJobsPath = (world: GitLabWorld, id: number) => `${pipelinePath(world, id)}/jobs`
const jobPath = (world: GitLabWorld, id: number) => `${projectPath(world)}/jobs/${id}`
const tracePath = (world: GitLabWorld, id: number) => `${jobPath(world, id)}/trace`

function localHead(world: GitLabWorld): string {
  const result = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: world.repoPath, env: process.env })
  if (result.exitCode !== 0) throw new Error('could not read the fixture branch head')
  return new TextDecoder().decode(result.stdout).trim()
}

function pipeline(id: number, headSha: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    project_id: 42,
    sha: headSha,
    ref: 'feature',
    status: 'failed',
    source: 'push',
    web_url: `https://gitlab.example.test/group/sub/proj/-/pipelines/${id}`,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:01:00.000Z',
    ...overrides
  }
}

function job(
  world: GitLabWorld,
  id: number,
  name: string,
  status: string,
  headSha: string,
  pipelineId = 90,
  overrides: Record<string, unknown> = {}
): Record<string, any> {
  return {
    id,
    name,
    stage: 'test',
    status,
    allow_failure: false,
    created_at: '2026-01-01T00:00:00.000Z',
    started_at: '2026-01-01T00:00:01.000Z',
    finished_at: '2026-01-01T00:00:02.000Z',
    web_url: `${world.server.url}/group/sub/proj/-/jobs/${id}`,
    pipeline: { id: pipelineId, project_id: 42, ref: 'feature', sha: headSha, status: 'failed' },
    commit: { id: headSha, short_id: headSha.slice(0, 8), title: 'fixture', message: 'fixture', author_name: 'Fixture', author_email: 'fixture@example.test', committed_date: '2026-01-01T00:00:00.000Z' },
    ...overrides
  }
}

function setupDefault(world: GitLabWorld): { head: string; current: Record<string, unknown>; jobs: Record<string, any>[] } {
  const head = localHead(world)
  const current = pipeline(90, head)
  const jobs = [job(world, 201, 'build', 'failed', head), job(world, 202, 'lint', 'success', head)]
  world.server.mergeRequests = [mergeRequest({
    sha: head,
    diff_refs: { base_sha: 'b'.repeat(40), start_sha: 'c'.repeat(40), head_sha: head },
    head_pipeline: { ...current }
  })]
  world.server.mergeRequestPipelines.set('5', [
    pipeline(95, 'd'.repeat(40), { ref: 'feature' }),
    current
  ])
  world.server.pipelines = [current]
  world.server.jobs = jobs
  return { head, current, jobs }
}

function setCurrentPipeline(
  world: GitLabWorld,
  head: string,
  id = 90,
  status = 'failed',
  jobs: Record<string, any>[] = []
): Record<string, unknown> {
  const current = pipeline(id, head, { status })
  world.server.mergeRequests = [mergeRequest({
    sha: head,
    diff_refs: { base_sha: 'b'.repeat(40), start_sha: 'c'.repeat(40), head_sha: head },
    head_pipeline: { ...current }
  })]
  world.server.mergeRequestPipelines.clear()
  world.server.mergeRequestPipelines.set('5', [current])
  world.server.pipelines = [current]
  world.server.jobs = jobs
  return current
}
test('routed checks select the current MR pipeline and map its failed and successful jobs', async () => {
  const world = await boot()
  const { head } = setupDefault(world)
  const result = await world.call('checks', { number: 5, noCache: true })

  expect(result).toEqual({
    number: 5,
    headSha: head,
    rollup: 'failure',
    partial: false,
    partialFailures: [],
    checks: [
      { kind: 'check_run', name: 'build', status: 'completed', conclusion: 'failure', url: `${world.server.url}/group/sub/proj/-/jobs/201`, checkRunId: 201, workflowRunId: 90, suiteId: null, required: null },
      { kind: 'check_run', name: 'lint', status: 'completed', conclusion: 'success', url: `${world.server.url}/group/sub/proj/-/jobs/202`, checkRunId: 202, workflowRunId: 90, suiteId: null, required: null }
    ]
  })
  const pipelineListingPath = `${mergeRequestPath(world)}/pipelines`
  const pipelineListings = world.server.requests.filter((request) => request.path === pipelineListingPath)
  expect(pipelineListings).toEqual([expect.objectContaining({ query: { per_page: '100', page: '1' } })])
  expect(world.server.requests.some((request) => request.path === `${projectPath(world)}/pipelines`)).toBe(false)
  expect(world.server.requests.every((request) => request.method === 'GET')).toBe(true)
  expect(world.glabInvocations()).toEqual([])
  expect(world.invocations()).toEqual([])
})

test('routed checkDetails verifies and reads only the selected current-head job trace', async () => {
  const world = await boot()
  const { head } = setupDefault(world)
  const result = await world.call('checkDetails', { number: 5, checkRunId: 201, workflowRunId: 90, jobName: 'build' })

  expect(result).toMatchObject({
    check: { id: 201, name: 'build', status: 'completed', conclusion: 'failure', headSha: head, detailsUrl: `${world.server.url}/group/sub/proj/-/jobs/201`, workflowRunId: 90 },
    annotations: [],
    jobs: [{ id: 201, name: 'build', status: 'completed', conclusion: 'failure', htmlUrl: `${world.server.url}/group/sub/proj/-/jobs/201`, checkRunUrl: null }],
    logTails: [{ jobId: 201, jobName: 'build', tail: 'trace for job 201\n' }],
    partialFailures: [],
    truncated: false
  })
  await world.call('checkDetails', { number: 5, checkRunId: 201, workflowRunId: 90, jobName: 'build' })
  expect(world.server.requests.filter((request) => request.path === jobPath(world, 201))).toHaveLength(2)
  expect(world.server.requests.filter((request) => request.path.endsWith('/trace')).map((request) => request.path)).toEqual([
    tracePath(world, 201),
    tracePath(world, 201)
  ])
  expect(world.server.requests.every((request) => request.method === 'GET')).toBe(true)
  expect(world.server.requests.every((request) => request.authorization === 'Bearer dummy-gitlab-token')).toBe(true)
  expect(world.glabInvocations()).toEqual([])
  expect(world.invocations()).toEqual([])
})
test('every GitLab job status and allowed failure maps to the public check vocabulary', async () => {
  const world = await boot()
  const head = localHead(world)
  const mappings = [
    ['created', 'queued', null],
    ['waiting_for_resource', 'queued', null],
    ['preparing', 'queued', null],
    ['pending', 'queued', null],
    ['scheduled', 'queued', null],
    ['running', 'in_progress', null],
    ['success', 'completed', 'success'],
    ['failed', 'completed', 'failure'],
    ['canceled', 'completed', 'cancelled'],
    ['skipped', 'completed', 'neutral'],
    ['manual', 'action_required', null],
    ['mystery_status', 'unknown', null]
  ] as const
  const jobs = mappings.map(([status], index) => job(world, 300 + index, `job-${status}`, status, head))
  jobs.push(job(world, 399, 'job-allowed-failure', 'failed', head, 90, { allow_failure: true }))
  setCurrentPipeline(world, head, 90, 'failed', jobs)

  const result = await world.call('checks', { number: 5, noCache: true }) as { checks: Array<{ name: string; status: string; conclusion: string | null }> }
  const actual = Object.fromEntries(result.checks.map((check) => [check.name, [check.status, check.conclusion]]))
  expect(actual).toEqual(Object.fromEntries([
    ...mappings.map(([status, mappedStatus, conclusion]) => [`job-${status}`, [mappedStatus, conclusion]]),
    ['job-allowed-failure', ['completed', 'neutral']]
  ]))
  expect(result.checks.every((check) => check.conclusion !== 'failure' || check.name !== 'job-allowed-failure')).toBe(true)
})

test('pipeline statuses and job outcomes combine using failure, pending, unknown, success, neutral precedence', async () => {
  const world = await boot()
  const head = localHead(world)
  const pipelineMappings = [
    ['created', 'pending'],
    ['waiting_for_resource', 'pending'],
    ['preparing', 'pending'],
    ['pending', 'pending'],
    ['running', 'pending'],
    ['success', 'success'],
    ['failed', 'failure'],
    ['canceled', 'neutral'],
    ['skipped', 'neutral'],
    ['manual', 'neutral'],
    ['future_status', 'unknown']
  ] as const
  for (const [status, rollup] of pipelineMappings) {
    setCurrentPipeline(world, head, 90, status)
    const result = await world.call('checks', { number: 5, noCache: true }) as { rollup: string }
    expect(result.rollup).toBe(rollup)
  }

  const combinations = [
    ['failed', 'success', 'failure'],
    ['pending', 'failed', 'failure'],
    ['pending', 'skipped', 'pending'],
    ['future_status', 'success', 'unknown'],
    ['success', 'skipped', 'success'],
    ['manual', 'skipped', 'neutral']
  ] as const
  for (const [pipelineStatus, jobStatus, rollup] of combinations) {
    const record = job(world, 450, 'combined', jobStatus, head)
    setCurrentPipeline(world, head, 90, pipelineStatus, [record])
    const result = await world.call('checks', { number: 5, noCache: true }) as { rollup: string }
    expect(result.rollup).toBe(rollup)
  }
}, 20_000)

test('an old-head MR pipeline is not a current pipeline and an empty current pipeline list is neutral', async () => {
  const world = await boot()
  const head = localHead(world)
  world.server.mergeRequests = [mergeRequest({
    sha: head,
    diff_refs: { base_sha: 'b'.repeat(40), start_sha: 'c'.repeat(40), head_sha: head }
  })]
  world.server.mergeRequestPipelines.set('5', [pipeline(99, 'd'.repeat(40))])

  expect(await world.call('checks', { number: 5, noCache: true })).toEqual({
    number: 5, headSha: head, rollup: 'neutral', checks: [], partial: false, partialFailures: []
  })
  expect(world.server.requests.some((request) => request.path.includes('/pipelines/99'))).toBe(false)
  expect(world.server.requests.some((request) => request.path.includes('/jobs'))).toBe(false)

  world.server.requests.length = 0
  world.server.mergeRequestPipelines.set('5', [])
  const pending = pipeline(100, head, { status: 'pending' })
  world.server.mergeRequestPipelines.set('5', [pending])
  world.server.pipelines = [pending]
  expect(await world.call('checks', { number: 5, noCache: true })).toMatchObject({ rollup: 'pending', checks: [], partial: false })
  expect(world.server.requests.some((request) => request.path === pipelineJobsPath(world, 100))).toBe(true)
})

test('the greatest positive current-SHA pipeline among MR pages is selected and verified', async () => {
  const world = await boot()
  const head = localHead(world)
  const current90 = pipeline(90, head)
  const current92 = pipeline(92, head, { status: 'success' })
  const old93 = pipeline(93, 'd'.repeat(40))
  const job92 = job(world, 292, 'new-head', 'success', head, 92)
  world.server.mergeRequests = [mergeRequest({ sha: head, diff_refs: { base_sha: 'b'.repeat(40), start_sha: 'c'.repeat(40), head_sha: head } })]
  world.server.mergeRequestPipelines.set('5', [current90, old93, current92])
  world.server.pipelines = [current90, current92]
  world.server.jobs = [job92]

  expect(await world.call('checks', { number: 5, noCache: true })).toMatchObject({
    rollup: 'success',
    checks: [{ checkRunId: 292, workflowRunId: 92 }]
  })
  expect(world.server.requests.some((request) => request.path === pipelinePath(world, 92))).toBe(true)
  expect(world.server.requests.some((request) => request.path === pipelinePath(world, 90))).toBe(false)
  expect(world.server.requests.some((request) => request.path === pipelinePath(world, 93))).toBe(false)
})

test('checks enumerate all 150 current-pipeline jobs over two bounded pages', async () => {
  const world = await boot()
  const head = localHead(world)
  const jobs = Array.from({ length: 150 }, (_, index) => job(world, 1000 + index, `job-${String(index).padStart(3, '0')}`, 'success', head))
  setCurrentPipeline(world, head, 90, 'success', jobs)

  const result = await world.call('checks', { number: 5, noCache: true }) as { checks: Array<{ checkRunId: number | null }> }
  const pages = world.server.requests.filter((request) => request.path === pipelineJobsPath(world, 90))
  expect(result.checks).toHaveLength(150)
  expect(new Set(result.checks.map((check) => check.checkRunId)).size).toBe(150)
  expect(pages.map((request) => request.query)).toEqual([
    { per_page: '100', page: '1', include_retried: 'false' },
    { per_page: '100', page: '2', include_retried: 'false' }
  ])
})

test('checks stop at five job pages and incomplete rollups preserve observed failure and pending outcomes', async () => {
  const world = await boot()
  const head = localHead(world)
  const jobs = Array.from({ length: 600 }, (_, index) => job(world, 2000 + index, `job-${String(index).padStart(3, '0')}`, 'success', head))
  setCurrentPipeline(world, head, 90, 'success', jobs)

  const result = await world.call('checks', { number: 5, noCache: true }) as { checks: unknown[]; rollup: string; partial: boolean; partialFailures: string[] }
  const pages = world.server.requests.filter((request) => request.path === pipelineJobsPath(world, 90))
  expect(result.checks).toHaveLength(500)
  expect(pages.map((request) => request.query.page)).toEqual(['1', '2', '3', '4', '5'])
  expect(result).toMatchObject({ rollup: 'unknown', partial: true, partialFailures: ['jobs_truncated'] })

  for (const [status, rollup] of [['failed', 'failure'], ['pending', 'pending']] as const) {
    jobs[0] = job(world, 2000, 'job-000', status, head)
    world.server.requests.length = 0
    const incomplete = await world.call('checks', { number: 5, noCache: true }) as { rollup: string; partial: boolean }
    expect(incomplete).toMatchObject({ rollup, partial: true })
  }
})

test('MR pipeline discovery stops after five pages and exposes incomplete membership', async () => {
  const world = await boot()
  const head = localHead(world)
  const pipelines = Array.from({ length: 600 }, (_, index) => pipeline(index + 1, head))
  const selected = pipeline(500, head, { status: 'success' })
  world.server.mergeRequests = [mergeRequest({ sha: head, diff_refs: { base_sha: 'b'.repeat(40), start_sha: 'c'.repeat(40), head_sha: head } })]
  world.server.mergeRequestPipelines.set('5', pipelines)
  world.server.pipelines = [selected]

  const result = await world.call('checks', { number: 5, noCache: true }) as { rollup: string; partial: boolean; partialFailures: string[] }
  const listPath = `${mergeRequestPath(world)}/pipelines`
  const pages = world.server.requests.filter((request) => request.path === listPath)
  expect(pages.map((request) => request.query.page)).toEqual(['1', '2', '3', '4', '5'])
  expect(world.server.requests.some((request) => request.path === pipelinePath(world, 500))).toBe(true)
  expect(result).toMatchObject({ rollup: 'unknown', partial: true, partialFailures: ['pipelines_truncated'] })
  world.server.pipelines = [pipeline(500, head, { status: 'failed' })]
  const observedFailure = await world.call('checks', { number: 5, noCache: true }) as { rollup: string; partial: boolean }
  expect(observedFailure).toMatchObject({ rollup: 'failure', partial: true })
})
test('details refuse incomplete MR pipeline discovery before a trace request', async () => {
  const world = await boot()
  const head = localHead(world)
  const current = pipeline(500, head)
  const list = Array.from({ length: 600 }, (_, index) => pipeline(index + 1, head))
  world.server.mergeRequests = [mergeRequest({ sha: head, diff_refs: { base_sha: 'b'.repeat(40), start_sha: 'c'.repeat(40), head_sha: head } })]
  world.server.mergeRequestPipelines.set('5', list)
  world.server.pipelines = [current]
  world.server.jobs = [job(world, 520, 'build', 'failed', head, 500)]

  await expect(world.call('checkDetails', { number: 5, checkRunId: 520, workflowRunId: 500, jobName: 'build' })).rejects.toMatchObject(reason('checks_incomplete'))
  expect(world.server.requests.some((request) => request.path.endsWith('/trace'))).toBe(false)
})


test('checks de-duplicate identical job IDs and reject conflicting identity, commit, or pipeline data', async () => {
  const world = await boot()
  const head = localHead(world)
  const duplicate = job(world, 801, 'build', 'failed', head)
  setCurrentPipeline(world, head, 90, 'failed', [duplicate, structuredClone(duplicate)])
  const result = await world.call('checks', { number: 5, noCache: true }) as { checks: Array<{ checkRunId: number | null }> }
  expect(result.checks).toHaveLength(1)
  expect(result.checks[0]?.checkRunId).toBe(801)

  const conflicts = [
    job(world, 801, 'lint', 'failed', head),
    job(world, 801, 'build', 'failed', head, 90, { pipeline: { ...duplicate.pipeline, project_id: 99 } }),
    job(world, 801, 'build', 'failed', head, 90, { commit: { id: 'd'.repeat(40), short_id: 'dddddddd' } })
  ]
  for (const conflicting of conflicts) {
    world.server.requests.length = 0
    setCurrentPipeline(world, head, 90, 'failed', [duplicate, conflicting])
    await expect(world.call('checks', { number: 5, noCache: true })).rejects.toMatchObject(reason('schema_drift'))
  }
})

test('non-advancing page values stop enumeration and malformed next-page URLs fail closed locally', async () => {
  const world = await boot()
  const head = localHead(world)
  const jobs = Array.from({ length: 250 }, (_, index) => job(world, 3000 + index, `job-${index}`, 'success', head))
  setCurrentPipeline(world, head, 90, 'success', jobs)
  const jobsPath = pipelineJobsPath(world, 90)
  world.server.nextPages.set(`GET ${jobsPath}?page=2`, '2')

  const repeated = await world.call('checks', { number: 5, noCache: true }) as { partial: boolean; rollup: string }
  expect(world.server.requests.filter((request) => request.path === jobsPath).map((request) => request.query.page)).toEqual(['1', '2'])
  expect(repeated).toMatchObject({ partial: true, rollup: 'unknown' })

  world.server.requests.length = 0
  world.server.nextPages.clear()
  world.server.nextPages.set(`GET ${jobsPath}?page=1`, 'https://attacker.invalid/api/v4/projects/group%2Fsub%2Fproj/pipelines/90/jobs?page=2')
  const malformed = await world.call('checks', { number: 5, noCache: true }) as { partial: boolean; rollup: string }
  expect(world.server.requests.filter((request) => request.path === jobsPath)).toHaveLength(1)
  expect(world.server.requests.every((request) => request.authorization === 'Bearer dummy-gitlab-token')).toBe(true)
  expect(malformed).toMatchObject({ partial: true, rollup: 'unknown' })
})

test('partial page failures retain observed jobs and never claim successful completion', async () => {
  const world = await boot()
  const head = localHead(world)
  const firstPage = Array.from({ length: 100 }, (_, index) => job(world, 4000 + index, `job-${index}`, 'success', head))
  const allJobs = [...firstPage, ...Array.from({ length: 20 }, (_, index) => job(world, 4100 + index, `later-${index}`, 'success', head))]
  setCurrentPipeline(world, head, 90, 'success', allJobs)
  const jobsPath = pipelineJobsPath(world, 90)
  world.server.failures.set(`GET ${jobsPath}?page=2`, { status: 500 })

  const pageTwoFailure = await world.call('checks', { number: 5, noCache: true }) as { checks: unknown[]; rollup: string; partial: boolean; partialFailures: string[] }
  expect(pageTwoFailure).toMatchObject({ rollup: 'unknown', partial: true, partialFailures: ['jobs_unavailable'] })
  expect(pageTwoFailure.checks).toHaveLength(100)

  world.server.requests.length = 0
  world.server.failures.clear()
  world.server.failures.set(`GET ${jobsPath}`, { status: 500 })
  const firstPageFailure = await world.call('checks', { number: 5, noCache: true }) as { checks: unknown[]; rollup: string; partial: boolean; partialFailures: string[] }
  expect(firstPageFailure).toEqual({
    number: 5, headSha: head, rollup: 'unknown', checks: [], partial: true, partialFailures: ['jobs_unavailable']
  })

  world.server.requests.length = 0
  world.server.failures.clear()
  world.server.failures.set(`GET ${mergeRequestPath(world)}/pipelines`, { status: 500 })
  const pipelineDiscoveryFailure = await world.call('checks', { number: 5, noCache: true }) as { number: number; headSha: string | null; rollup: string; checks: unknown[]; partial: boolean; partialFailures: string[] }
  expect(pipelineDiscoveryFailure).toEqual({
    number: 5, headSha: head, rollup: 'unknown', checks: [], partial: true, partialFailures: ['pipelines_unavailable']
  })
  expect(world.server.requests.some((request) => request.path === jobsPath)).toBe(false)
  expect(world.server.requests.some((request) => request.method === 'POST')).toBe(false)
})

test('enumeration preserves auth, permission, and rate-limit errors instead of returning partial checks', async () => {
  const world = await boot()
  const head = localHead(world)
  setCurrentPipeline(world, head, 90, 'success', [job(world, 510, 'build', 'success', head)])
  const listing = `${mergeRequestPath(world)}/pipelines`

  world.server.failures.set(`GET ${listing}`, { status: 401 })
  await expect(world.call('checks', { number: 5, noCache: true })).rejects.toMatchObject(reason('auth_required'))

  world.server.failures.clear()
  world.server.requests.length = 0
  world.server.failures.set(`GET ${pipelinePath(world, 90)}`, { status: 403 })
  await expect(world.call('checks', { number: 5, noCache: true })).rejects.toMatchObject(reason('permission_denied'))

  world.server.failures.clear()
  world.server.requests.length = 0
  world.server.failures.set(`GET ${pipelineJobsPath(world, 90)}`, {
    status: 429,
    headers: { 'Retry-After': '60' }
  })
  const rateLimitError = await world.call('checks', { number: 5, noCache: true }).catch((error) => error) as { data?: { reason?: string; retryDisabledUntil?: number } }
  const retryDisabledUntil = rateLimitError.data?.retryDisabledUntil
  expect(rateLimitError.data?.reason).toBe('rate_limited')
  expect(typeof retryDisabledUntil).toBe('number')
  expect((retryDisabledUntil ?? 0) > Date.now()).toBe(true)
  expect(world.glabInvocations()).toEqual([])
})

test('malformed pipeline and job identity data fails as schema drift', async () => {
  const world = await boot()
  const head = localHead(world)
  const valid = pipeline(90, head)
  world.server.mergeRequests = [mergeRequest({ sha: head, diff_refs: { base_sha: 'b'.repeat(40), start_sha: 'c'.repeat(40), head_sha: head } })]

  world.server.mergeRequestPipelines.set('5', [{ ...valid, id: 'not-a-number' }] as unknown as Record<string, any>[])
  await expect(world.call('checks', { number: 5, noCache: true })).rejects.toMatchObject(reason('schema_drift'))

  world.server.requests.length = 0
  world.server.mergeRequestPipelines.set('5', [valid])
  world.server.pipelines = [{ ...valid, sha: undefined }]
  await expect(world.call('checks', { number: 5, noCache: true })).rejects.toMatchObject(reason('schema_drift'))

  world.server.requests.length = 0
  world.server.pipelines = [valid]
  world.server.jobs = [job(world, 901, 'build', 'failed', head, 90, {
    pipeline: { id: 90, project_id: 42, sha: head },
    commit: { short_id: head.slice(0, 8) }
  })]
  await expect(world.call('checks', { number: 5, noCache: true })).rejects.toMatchObject(reason('schema_drift'))
})

test('checks and details reject unsafe IDs, invalid flags, and invalid job names before provider requests', async () => {
  const world = await boot()
  setupDefault(world)

  await expect(world.call('checks', { noCache: true })).rejects.toMatchObject({ message: 'params.number is required' })
  await expect(world.call('checkDetails', { checkRunId: 201 })).rejects.toMatchObject({ message: 'params.number is required' })
  for (const number of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '5', null]) {
    await expectInputRejected(world.call('checks', { number, noCache: true }))
    await expectInputRejected(world.call('checkDetails', { number, checkRunId: 201 }))
  }
  for (const noCache of [null, 1, 'true']) {
    await expectInputRejected(world.call('checks', { number: 5, noCache }))
    await expectInputRejected(world.call('checkDetails', { number: 5, checkRunId: 201, noCache }))
  }
  await expect(world.call('checkDetails', { number: 5 })).rejects.toMatchObject({ message: 'params.checkRunId is required' })
  for (const checkRunId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '201', null]) {
    await expectInputRejected(world.call('checkDetails', { number: 5, checkRunId }))
  }
  for (const workflowRunId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '90', null]) {
    await expectInputRejected(world.call('checkDetails', { number: 5, checkRunId: 201, workflowRunId }))
  }
  for (const jobName of ['', 'x'.repeat(201), 7, null]) {
    await expectInputRejected(world.call('checkDetails', { number: 5, checkRunId: 201, jobName }))
  }
  expect(world.server.requests).toEqual([])
}, 20_000)

test('checks and details reject foreign repository pins before provider requests and accept case-only pins', async () => {
  const world = await boot()
  setupDefault(world)
  const other = { ...world.identity, owner: 'someone/else', repo: 'other' }
  await expect(world.call('checks', { number: 5, prRepo: other })).rejects.toMatchObject(reason('repository_mismatch'))
  await expect(world.call('checkDetails', { number: 5, checkRunId: 201, prRepo: other })).rejects.toMatchObject(reason('repository_mismatch'))
  expect(world.server.requests).toEqual([])
  expect(world.glabInvocations()).toEqual([])

  const matching = {
    host: world.identity.host.toUpperCase(),
    owner: world.identity.owner.toUpperCase(),
    repo: world.identity.repo.toUpperCase()
  }
  expect(await world.call('checks', { number: 5, prRepo: matching, noCache: true })).toMatchObject({ number: 5, headSha: localHead(world) })
  expect(await world.call('checkDetails', { number: 5, checkRunId: 201, prRepo: matching })).toMatchObject({ check: { workflowRunId: 90 } })
})

test('detail pipeline and job-name pins are consistency checks and workflow ID can be derived', async () => {
  const world = await boot()
  setupDefault(world)
  await expect(world.call('checkDetails', { number: 5, checkRunId: 201, workflowRunId: 91, jobName: 'build' })).rejects.toMatchObject(reason('invalid_input'))
  await expect(world.call('checkDetails', { number: 5, checkRunId: 201, workflowRunId: 90, jobName: 'lint' })).rejects.toMatchObject(reason('invalid_input'))
  expect(world.server.requests.some((request) => request.path.endsWith('/trace'))).toBe(false)

  const result = await world.call('checkDetails', { number: 5, checkRunId: 201 }) as { check: { workflowRunId: number }; logTails: Array<{ jobId: number }> }
  expect(result.check.workflowRunId).toBe(90)
  expect(result.logTails.map((tail) => tail.jobId)).toEqual([201])
  expect(world.server.requests.filter((request) => request.path.endsWith('/trace')).map((request) => request.path)).toEqual([tracePath(world, 201)])
})

test('detail refuses foreign project or pipeline jobs and stale commits before reading any trace', async () => {
  const world = await boot()
  const { head } = setupDefault(world)
  const valid = job(world, 201, 'build', 'failed', head)
  const cases = [
    [job(world, 201, 'build', 'failed', head, 90, { pipeline: { ...valid.pipeline, id: 91 } }), 'foreign_target'],
    [job(world, 201, 'build', 'failed', head, 90, { pipeline: { ...valid.pipeline, project_id: 99 } }), 'foreign_target'],
    [job(world, 201, 'build', 'failed', head, 90, { commit: { ...valid.commit, id: 'd'.repeat(40) } }), 'stale_head']
  ] as const
  for (const [selectedJob, expectedReason] of cases) {
    world.server.requests.length = 0
    world.server.jobs = [selectedJob, job(world, 202, 'lint', 'success', head)]
    await expect(world.call('checkDetails', { number: 5, checkRunId: 201, workflowRunId: 90, jobName: 'build' })).rejects.toMatchObject(reason(expectedReason))
    expect(world.server.requests.some((request) => request.path.endsWith('/trace'))).toBe(false)
  }
})

test('detail rejects a verified pipeline from another project or head before trace access', async () => {
  const world = await boot()
  const { head } = setupDefault(world)
  for (const [selectedPipeline, expectedReason] of [
    [pipeline(90, head, { project_id: 99 }), 'foreign_target'],
    [pipeline(90, 'e'.repeat(40)), 'stale_head']
  ] as const) {
    world.server.requests.length = 0
    world.server.pipelines = [selectedPipeline]
    await expect(world.call('checkDetails', { number: 5, checkRunId: 201, workflowRunId: 90 })).rejects.toMatchObject(reason(expectedReason))
    expect(world.server.requests.some((request) => request.path.endsWith('/trace'))).toBe(false)
  }
})

function holdResponse(world: GitLabWorld, method: string, path: string): { arrived: Promise<void>; release(): void } {
  const arrival = Promise.withResolvers<void>()
  const blocked = Promise.withResolvers<void>()
  world.server.responseBarriers.set(`${method} ${path}`, async () => {
    arrival.resolve()
    await blocked.promise
  })
  return { arrived: arrival.promise, release: blocked.resolve }
}

function runGit(world: GitLabWorld, args: string[]): void {
  const result = Bun.spawnSync(['git', ...args], { cwd: world.repoPath, env: process.env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(`git fixture mutation failed: ${new TextDecoder().decode(result.stderr)}`)
}

test('detail rechecks local branch, head, detachment, origin, host allowlist, and saved configuration after a response await', async () => {
  const mutations: Array<[string, (world: GitLabWorld) => Promise<void>]> = [
    ['branch', async (world) => { runGit(world, ['checkout', '-b', 'stale-target-branch']) }],
    ['head', async (world) => { runGit(world, ['commit', '--allow-empty', '-m', 'advance fixture head']) }],
    ['detached worktree', async (world) => { runGit(world, ['checkout', '--detach', 'HEAD']) }],
    ['origin', async (world) => { runGit(world, ['remote', 'set-url', 'origin', `http://${world.identity.host}/other/group/proj.git`]) }],
    ['host allowlist', async (world) => {
      await world.client.callAny('setting.set', { id: 'setting:quirky.hosting/gitlabHosts', value: 'gitlab.com' })
    }],
    ['saved configuration', async (world) => {
      runGit(world, ['remote', 'set-url', 'origin', 'https://github.com/test-owner/test-repo.git'])
      await world.call('configure', { issueSourcePreference: 'upstream' })
      runGit(world, ['remote', 'set-url', 'origin', `http://${world.identity.host}/group/sub/proj.git`])
    }]
  ]
  for (const [label, mutate] of mutations) {
    const world = await boot(label === 'saved configuration' ? { ghSource: 'process.stdout.write("{}")' } : {})
    setupDefault(world)
    const barrier = holdResponse(world, 'GET', jobPath(world, 201))
    const pending = world.call('checkDetails', { number: 5, checkRunId: 201, workflowRunId: 90 }).then(
      value => ({ kind: 'resolved' as const, value }),
      error => ({ kind: 'rejected' as const, error })
    )
    try {
      const requestStarted = await Promise.race([barrier.arrived.then(() => true), pending.then(() => false)])
      expect(requestStarted).toBe(true)
      await mutate(world)
    } finally {
      barrier.release()
    }
    const outcome = await pending
    expect(outcome.kind).toBe('rejected')
    if (outcome.kind === 'rejected') {
      const staleReason = errorReasonValue(outcome.error)
      expect(['stale_head', 'stale_target']).toContain(staleReason)
    }
    expect(world.server.requests.some((request) => request.path.endsWith('/trace'))).toBe(false)
    expect(world.server.requests.some((request) => request.method === 'POST')).toBe(false)
    expect(world.server.requests.every((request) => request.authorization === 'Bearer dummy-gitlab-token')).toBe(true)
    await world.cleanup()
    active = undefined
  }
}, 20_000)

test('detail revalidates target identity after the trace response await', async () => {
  const world = await boot()
  setupDefault(world)
  const barrier = holdResponse(world, 'GET', tracePath(world, 201))
  const pending = world.call('checkDetails', { number: 5, checkRunId: 201, workflowRunId: 90 }).then(
    value => ({ kind: 'resolved' as const, value }),
    error => ({ kind: 'rejected' as const, error })
  )
  try {
    const requestStarted = await Promise.race([barrier.arrived.then(() => true), pending.then(() => false)])
    expect(requestStarted).toBe(true)
    runGit(world, ['commit', '--allow-empty', '-m', 'advance fixture head during trace'])
  } finally {
    barrier.release()
  }

  const outcome = await pending
  expect(outcome.kind).toBe('rejected')
  if (outcome.kind === 'rejected') {
    const staleReason = errorReasonValue(outcome.error)
    expect(['stale_head', 'stale_target']).toContain(staleReason)
  }
  expect(world.server.requests.filter((request) => request.path === tracePath(world, 201))).toHaveLength(1)
  expect(world.server.requests.some((request) => request.method === 'POST')).toBe(false)
}, 20_000)

test('trace streaming removes split terminal controls, active and GitLab tokens, bearer secrets, and URL userinfo', async () => {
  const world = await boot()
  setupDefault(world)
  world.server.traces.set('201', {
    chunks: [
      'before\u001b[3',
      '1mred\u001b[0m\r\n\u001b]0;private title',
      '\u0007Authorization: Bearer fixture-bearer-secret\r',
      `token=${'dummy-gitlab-token'} glpat-Token_123-ABC gldt-Token_234-DEF glrt-Token_345-GHI`,
      '\u0001https://alice:password@example.test/path\tcolumn'
    ]
  })

  const result = await world.call('checkDetails', { number: 5, checkRunId: 201, workflowRunId: 90 }) as { logTails: Array<{ tail: string }> }
  const tail = result.logTails[0]?.tail ?? ''
  expect(tail).toContain('beforered\n')
  expect(tail).toContain('Authorization:')
  expect(tail).toContain('[REDACTED]')
  expect(tail).toContain('https://example.test/path\tcolumn')
  expect(tail).not.toContain('\r')
  expect(tail).not.toContain('\u001b')
  expect(tail).not.toContain('\u0001')
  for (const secret of ['dummy-gitlab-token', 'fixture-bearer-secret', 'glpat-Token_123-ABC', 'gldt-Token_234-DEF', 'glrt-Token_345-GHI', 'alice:password@']) {
    expect(tail).not.toContain(secret)
  }
  expect(result.logTails).toHaveLength(1)
})

test('trace tails retain exactly the last 100 lines and cap UTF-8 output without splitting code points', async () => {
  const world = await boot()
  setupDefault(world)
  world.server.traces.set('201', { chunks: [Array.from({ length: 200 }, (_, index) => `line-${String(index + 1).padStart(3, '0')}`).join('\n')] })
  const lines = await world.call('checkDetails', { number: 5, checkRunId: 201, workflowRunId: 90 }) as { logTails: Array<{ tail: string }>; truncated: boolean }
  const lineTail = lines.logTails[0]?.tail ?? ''
  expect(lineTail.split('\n')).toHaveLength(100)
  expect(lineTail.split('\n')[0]).toBe('line-101')
  expect(lineTail.split('\n').at(-1)).toBe('line-200')
  expect(lines.truncated).toBe(true)

  const exact = 'x'.repeat(16 * 1024)
  world.server.traces.set('201', { chunks: [exact] })
  const exactResult = await world.call('checkDetails', { number: 5, checkRunId: 201, workflowRunId: 90 }) as { logTails: Array<{ tail: string }>; truncated: boolean }
  expect(exactResult.logTails[0]?.tail).toBe(exact)
  expect(exactResult.truncated).toBe(false)

  world.server.traces.set('201', { chunks: ['x'.repeat(16 * 1024 + 1)] })
  const over = await world.call('checkDetails', { number: 5, checkRunId: 201, workflowRunId: 90 }) as { logTails: Array<{ tail: string }>; truncated: boolean }
  expect(Buffer.byteLength(over.logTails[0]?.tail ?? '', 'utf8')).toBe(16 * 1024)
  expect(over.truncated).toBe(true)

  world.server.traces.set('201', { chunks: ['🙂'.repeat(4097)] })
  const multibyte = await world.call('checkDetails', { number: 5, checkRunId: 201, workflowRunId: 90 }) as { logTails: Array<{ tail: string }>; truncated: boolean }
  expect(Buffer.byteLength(multibyte.logTails[0]?.tail ?? '', 'utf8')).toBe(16 * 1024)
  expect(multibyte.logTails[0]?.tail).toBe('🙂'.repeat(4096))
  expect(multibyte.truncated).toBe(true)
}, 20_000)

test('trace stream accepts exactly 4 MiB and reports an honest partial detail above the cap', async () => {
  const world = await boot()
  setupDefault(world)
  const limit = 4 * 1024 * 1024
  const exactBytes = new Uint8Array(limit).fill(0x78)
  world.server.traces.set('201', { chunks: [exactBytes] })
  const exact = await world.call('checkDetails', { number: 5, checkRunId: 201, workflowRunId: 90 }) as { partialFailures: string[]; truncated: boolean; logTails: Array<{ tail: string }> }
  expect(exact.partialFailures).toEqual([])
  expect(exact.logTails[0]?.tail).toHaveLength(16 * 1024)
  expect(exact.truncated).toBe(true)

  world.server.traces.set('201', { chunks: [new Uint8Array(limit + 1).fill(0x78)] })
  const over = await world.call('checkDetails', { number: 5, checkRunId: 201, workflowRunId: 90 }) as { partialFailures: string[]; logTails: Array<{ tail: string }> }
  expect(over.partialFailures.length).toBeGreaterThan(0)
  expect(over.logTails).toEqual([])
}, 20_000)

test('trace redirects are refused and never forward the bearer credential', async () => {
  let redirectedRequests = 0
  const target = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() { redirectedRequests++; return Response.json({ ok: true }) }
  })
  try {
    const world = await boot()
    setupDefault(world)
    world.server.traces.set('201', {
      chunks: [],
      status: 302,
      headers: { Location: target.url.origin }
    })
    const result = await world.call('checkDetails', { number: 5, checkRunId: 201, workflowRunId: 90 }) as { partialFailures: string[]; logTails: unknown[] }
    expect(result.partialFailures.length).toBeGreaterThan(0)
    expect(result.logTails).toEqual([])
    expect(redirectedRequests).toBe(0)
    expect(world.server.requests.every((request) => request.authorization === 'Bearer dummy-gitlab-token')).toBe(true)
    expect(world.glabInvocations()).toEqual([])
  } finally {
    await target.stop(true)
  }
})
test('a removed and recreated worktree instance cannot inherit an in-flight detail target', async () => {
  const world = await boot()
  const original = await world.client.callAny('quirky.worktree/show', { worktree: world.worktree }) as { repoId: string }
  runGit(world, ['branch', 'gitlab-detail-target'])
  const createTarget = async (branch: string) => await world.client.callAny('quirky.worktree/create', {
    repo: original.repoId,
    name: 'gitlab-detail-target',
    branch
  }) as { worktree: { id: string; instanceId: string } }
  const first = await createTarget('gitlab-detail-target')
  const { current, jobs } = setupDefault(world)
  world.server.mergeRequests[0]!.source_branch = 'gitlab-detail-target'
  current.ref = 'gitlab-detail-target'
  for (const selected of jobs) selected.pipeline.ref = 'gitlab-detail-target'
  const barrier = holdResponse(world, 'GET', jobPath(world, 201))
  const pending = world.call('checkDetails', {
    worktree: first.worktree.id,
    number: 5,
    checkRunId: 201,
    workflowRunId: 90
  }).then(
    value => ({ kind: 'resolved' as const, value }),
    error => ({ kind: 'rejected' as const, error })
  )
  try {
    const requestStarted = await Promise.race([barrier.arrived.then(() => true), pending.then(() => false)])
    expect(requestStarted).toBe(true)
    await world.client.callAny('quirky.worktree/remove', { worktree: first.worktree.id, yes: true })
    runGit(world, ['branch', 'gitlab-detail-target-replacement'])
    const replacement = await createTarget('gitlab-detail-target-replacement')
    expect(replacement.worktree.id).toBe(first.worktree.id)
    expect(replacement.worktree.instanceId).not.toBe(first.worktree.instanceId)
  } finally {
    barrier.release()
  }

  const outcome = await pending
  expect(outcome.kind).toBe('rejected')
  if (outcome.kind === 'rejected') {
    const staleReason = errorReasonValue(outcome.error)
    expect(staleReason).toBe('stale_target')
  }
  expect(world.server.requests.some((request) => request.path.endsWith('/trace'))).toBe(false)
  expect(world.server.requests.some((request) => request.method === 'POST')).toBe(false)
}, 20_000)
test('a new read on an already-unlisted GitLab host retains unsupported-provider fallback', async () => {
  const world = await boot({ ghSource: 'process.stdout.write("{}")' })
  await world.client.callAny('setting.set', { id: 'setting:quirky.hosting/gitlabHosts', value: 'gitlab.com' })
  active = world
  for (const [method, params] of [
    ['checks', { number: 5 }],
    ['checkDetails', { number: 5, checkRunId: 201 }]
  ] as const) {
    await expect(world.call(method, params)).rejects.toMatchObject(reason('unsupported_provider'))
  }
  expect(world.server.requests).toEqual([])
  expect(world.glabInvocations()).toEqual([])
})
test('project and merge-request read failures preserve their provider reason', async () => {
  const world = await boot()
  const head = localHead(world)
  setCurrentPipeline(world, head, 90, 'success', [job(world, 510, 'build', 'success', head)])

  world.server.failures.set(`GET ${projectPath(world)}`, { status: 500 })
  await expect(world.call('checks', { number: 5, noCache: true })).rejects.toMatchObject(reason('server_error'))
  expect(world.server.requests.some((request) => request.path === projectPath(world))).toBe(true)

  world.server.failures.clear()
  world.server.requests.length = 0
  world.server.failures.set(`GET ${mergeRequestPath(world)}`, { status: 500 })
  await expect(world.call('checks', { number: 5, noCache: true })).rejects.toMatchObject(reason('server_error'))
  expect(world.server.requests.some((request) => request.path === mergeRequestPath(world))).toBe(true)
  expect(world.server.requests.some((request) => request.path.endsWith('/pipelines'))).toBe(false)
})
test('selected trace 404, 403, and 500 failures preserve details without leaking bodies', async () => {
  const world = await boot()
  setupDefault(world)
  const events: unknown[] = []
  world.client.onEvent((event) => events.push(event))
  await world.client.callAny('events.subscribe', {})

  for (const [status, marker] of [
    [404, 'trace_not_found'],
    [403, 'trace_permission_denied'],
    [500, 'trace_unavailable']
  ] as const) {
    const secret = `fixture-trace-error-${status}-must-not-leak`
    world.server.failures.clear()
    world.server.failures.set(`GET ${tracePath(world, 201)}`, {
      status,
      body: { message: secret, trace: secret, errors: [secret] }
    })

    const result = await world.call('checkDetails', { number: 5, checkRunId: 201, workflowRunId: 90 }) as {
      check: { id: number }
      jobs: unknown[]
      logTails: unknown[]
      partialFailures: string[]
    }
    expect(result.check.id).toBe(201)
    expect(result.jobs).toHaveLength(1)
    expect(result.logTails).toEqual([])
    expect(result.partialFailures).toContain(marker)
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(JSON.stringify(events)).not.toContain(secret)
  }

  expect(world.server.requests.filter((request) => request.path === tracePath(world, 201))).toHaveLength(3)
}, 20_000)

test('an aborted trace transport preserves selected details as a timeout', async () => {
  const fetcher = globalThis.fetch
  const secret = 'fixture-trace-deadline-must-not-leak'
  let traceRequests = 0
  globalThis.fetch = (async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.pathname.endsWith('/jobs/201/trace')) {
      traceRequests += 1
      throw Object.assign(new Error(secret), { name: 'AbortError' })
    }
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') throw new Error('Unexpected fixture host')
    return fetcher(input, init)
  }) as typeof fetch
  try {
    const world = await boot()
    setupDefault(world)
    const events: unknown[] = []
    world.client.onEvent((event) => events.push(event))
    await world.client.callAny('events.subscribe', {})
    const result = await world.call('checkDetails', { number: 5, checkRunId: 201, workflowRunId: 90 }) as {
      check: { id: number }
      jobs: unknown[]
      logTails: unknown[]
      partialFailures: string[]
    }
    expect(result.check.id).toBe(201)
    expect(result.jobs).toHaveLength(1)
    expect(result.logTails).toEqual([])
    expect(result.partialFailures).toEqual(['trace_timeout'])
    expect(traceRequests).toBe(1)
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(JSON.stringify(events)).not.toContain(secret)
  } finally {
    globalThis.fetch = fetcher
  }
}, 20_000)
test('a retry deadline after provider mutation is uncertain and never resends the POST', async () => {
  const fetcher = globalThis.fetch
  globalThis.fetch = (async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') throw new Error('Unexpected fixture host')
    if (url.pathname.endsWith('/jobs/201/retry') && init?.method === 'POST') {
      const response = await fetcher(input, init)
      await response.arrayBuffer()
      throw Object.assign(new Error('simulated retry deadline'), { name: 'AbortError' })
    }
    return fetcher(input, init)
  }) as typeof fetch
  try {
    const world = await boot()
    setupDefault(world)
    const error = await world.call('rerunChecks', { number: 5, failedOnly: true }).catch((value) => value)
    expect(errorReasonValue(error)).toBe('unknown_completion')
    expect(errorDataValue(error, 'uncertain')).toBe(true)
    expect(errorDataValue(error, 'startedCount')).toBe(0)
    expect(errorDataValue(error, 'completedSteps')).toEqual([])
    expect(world.server.requests.filter((request) => request.method === 'POST').map((request) => request.path)).toEqual([
      `${jobPath(world, 201)}/retry`
    ])
    expect(world.server.jobs.some((value) => value.id === 201)).toBe(false)
  } finally {
    globalThis.fetch = fetcher
  }
}, 20_000)

test('project and merge-request numeric identity fields reject malformed provider schemas', async () => {
  const world = await boot()
  const head = localHead(world)
  setCurrentPipeline(world, head, 90, 'failed', [job(world, 901, 'build', 'failed', head)])

  world.server.project = { ...world.server.project, id: '42' }
  await expect(world.call('checks', { number: 5, noCache: true })).rejects.toMatchObject(reason('schema_drift'))

  world.server.project = { ...world.server.project, id: 42 }
  world.server.requests.length = 0
  world.server.mergeRequests = [mergeRequest({
    sha: head,
    iid: '5',
    diff_refs: { base_sha: 'b'.repeat(40), start_sha: 'c'.repeat(40), head_sha: head }
  })]
  await expect(world.call('checks', { number: 5, noCache: true })).rejects.toMatchObject(reason('schema_drift'))

  world.server.requests.length = 0
  world.server.mergeRequests = [mergeRequest({
    sha: head,
    project_id: 42.5,
    diff_refs: { base_sha: 'b'.repeat(40), start_sha: 'c'.repeat(40), head_sha: head }
  })]
  await expect(world.call('checks', { number: 5, noCache: true })).rejects.toMatchObject(reason('schema_drift'))
}, 20_000)

test('explicit failed-only retry starts one verified job, emits changed, and invalidates cached checks', async () => {
  const world = await boot()
  setupDefault(world)
  const events: unknown[] = []
  world.client.onEvent((event) => events.push(event))
  await world.client.callAny('events.subscribe', {})

  const before = await world.call('checks', { number: 5 }) as { checks: Array<{ checkRunId: number | null }> }
  expect(before.checks[0]?.checkRunId).toBe(201)
  const result = await world.call('rerunChecks', {
    number: 5,
    failedOnly: true,
    prRepo: {
      host: world.identity.host.toUpperCase(),
      owner: world.identity.owner.toUpperCase(),
      repo: world.identity.repo.toUpperCase()
    }
  })
  expect(result).toEqual({ started: 1, targetCount: 1, completedSteps: ['check:201'] })
  expect(world.server.requests.filter((request) => request.method === 'POST').map((request) => ({
    path: request.path, body: request.body
  }))).toEqual([{ path: `${jobPath(world, 201)}/retry`, body: null }])
  expect(events).toContainEqual(expect.objectContaining({
    type: 'quirky.hosting/changed',
    data: expect.objectContaining({ worktreeId: world.worktree, number: 5, operation: 'rerunChecks', completedSteps: ['check:201'] })
  }))

  const after = await world.call('checks', { number: 5 }) as {
    checks: Array<{ name: string; checkRunId: number | null; status: string; conclusion: string | null }>
  }
  expect(after.checks).toEqual([
    { kind: 'check_run', name: 'build', status: 'queued', conclusion: null, url: `${world.server.url}/group/sub/proj/-/jobs/203`, checkRunId: 203, workflowRunId: 90, suiteId: null, required: null },
    { kind: 'check_run', name: 'lint', status: 'completed', conclusion: 'success', url: `${world.server.url}/group/sub/proj/-/jobs/202`, checkRunId: 202, workflowRunId: 90, suiteId: null, required: null }
  ])
}, 20_000)
test('all retryable jobs use individual retry endpoints and never play or retry a pipeline', async () => {
  const world = await boot()
  const head = localHead(world)
  const jobs = [
    job(world, 201, 'build', 'failed', head),
    job(world, 202, 'lint', 'success', head),
    job(world, 203, 'package', 'canceled', head),
    job(world, 204, 'skipped', 'skipped', head),
    job(world, 205, 'manual', 'manual', head),
    job(world, 206, 'running', 'running', head)
  ]
  setCurrentPipeline(world, head, 90, 'failed', jobs)

  const result = await world.call('rerunChecks', { number: 5, failedOnly: false })
  expect(result).toEqual({
    started: 3,
    targetCount: 3,
    completedSteps: ['check:201', 'check:202', 'check:203']
  })
  expect(world.server.requests.filter((request) => request.method === 'POST').map((request) => ({
    path: request.path, body: request.body
  }))).toEqual([201, 202, 203].map((id) => ({ path: `${jobPath(world, id)}/retry`, body: null })))
  expect(world.server.requests.some((request) => request.path.includes('/play'))).toBe(false)
  expect(world.server.requests.some((request) => request.path === `${projectPath(world)}/pipelines/90/retry`)).toBe(false)
}, 20_000)

test('failed-only retries allowed failures and canceled jobs but not successful jobs', async () => {
  const world = await boot()
  const head = localHead(world)
  const jobs = [
    job(world, 201, 'allowed-build', 'failed', head, 90, { allow_failure: true }),
    job(world, 202, 'lint', 'success', head),
    job(world, 203, 'package', 'canceled', head),
    job(world, 204, 'skipped', 'skipped', head)
  ]
  setCurrentPipeline(world, head, 90, 'failed', jobs)

  expect(await world.call('rerunChecks', { number: 5, failedOnly: true })).toEqual({
    started: 2,
    targetCount: 2,
    completedSteps: ['check:201', 'check:203']
  })
  expect(world.server.requests.filter((request) => request.method === 'POST').map((request) => request.path)).toEqual([
    `${jobPath(world, 201)}/retry`,
    `${jobPath(world, 203)}/retry`
  ])
}, 20_000)

test('failed-only and all retries refuse when no jobs match their selectors', async () => {
  const world = await boot()
  const head = localHead(world)
  setCurrentPipeline(world, head, 90, 'failed', [
    job(world, 204, 'skipped', 'skipped', head),
    job(world, 205, 'manual', 'manual', head),
    job(world, 206, 'running', 'running', head)
  ])

  await expect(world.call('rerunChecks', { number: 5, failedOnly: true })).rejects.toMatchObject(reason('no_failed_checks'))
  await expect(world.call('rerunChecks', { number: 5, failedOnly: false })).rejects.toMatchObject(reason('no_rerunnable_checks'))
  expect(world.server.requests.some((request) => request.method === 'POST')).toBe(false)
})
test('retry validates numeric IDs, boolean flags, and repository pins before provider requests', async () => {
  const world = await boot()
  setupDefault(world)

  await expectInputRejected(world.call('rerunChecks', { failedOnly: true }))
  for (const number of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '5', null]) {
    await expectInputRejected(world.call('rerunChecks', { number, failedOnly: true }))
  }
  for (const failedOnly of [undefined, null, 1, 'true']) {
    await expectInputRejected(world.call('rerunChecks', {
      number: 5,
      ...(failedOnly === undefined ? {} : { failedOnly })
    }))
  }
  for (const allowPartial of [null, 1, 'true']) {
    await expectInputRejected(world.call('rerunChecks', { number: 5, failedOnly: true, allowPartial }))
  }
  await expect(world.call('rerunChecks', {
    number: 5,
    failedOnly: true,
    prRepo: { ...world.identity, repo: 'other' }
  })).rejects.toMatchObject(reason('repository_mismatch'))
  expect(world.server.requests).toEqual([])
}, 20_000)
test('allowPartial permits only failed-only job-limit truncation, never other incomplete targets', async () => {
  const world = await boot()
  const head = localHead(world)
  const jobs = Array.from({ length: 600 }, (_, index) => job(
    world,
    index === 0 ? 201 : index === 1 ? 202 : 1000 + index,
    `job-${String(index).padStart(3, '0')}`,
    index === 0 ? 'failed' : index === 1 ? 'canceled' : 'success',
    head,
    90,
    index === 0 ? { allow_failure: true } : {}
  ))
  setCurrentPipeline(world, head, 90, 'failed', jobs)

  await expect(world.call('rerunChecks', { number: 5, failedOnly: true })).rejects.toMatchObject(reason('checks_incomplete'))
  await expect(world.call('rerunChecks', { number: 5, failedOnly: false, allowPartial: true })).rejects.toMatchObject(reason('checks_incomplete'))
  expect(world.server.requests.some((request) => request.method === 'POST')).toBe(false)

  const partial = await world.call('rerunChecks', { number: 5, failedOnly: true, allowPartial: true })
  expect(partial).toEqual({
    started: 2,
    targetCount: 2,
    completedSteps: ['check:201', 'check:202'],
    partial: true
  })
  expect(world.server.requests.filter((request) => request.method === 'POST').map((request) => request.path)).toEqual([
    `${jobPath(world, 201)}/retry`,
    `${jobPath(world, 202)}/retry`
  ])

  const current = pipeline(500, head)
  world.server.requests.length = 0
  world.server.mergeRequestPipelines.set('5', Array.from({ length: 600 }, (_, index) => pipeline(index + 1, head)))
  world.server.pipelines = [current]
  world.server.jobs = [job(world, 701, 'build', 'failed', head, 500)]
  await expect(world.call('rerunChecks', { number: 5, failedOnly: true, allowPartial: true })).rejects.toMatchObject(reason('checks_incomplete'))
  expect(world.server.requests.some((request) => request.method === 'POST')).toBe(false)
  world.server.requests.length = 0
  const foreignHead = 'e'.repeat(40)
  const currentForForeignHead = pipeline(90, foreignHead)
  world.server.mergeRequests = [mergeRequest({
    sha: foreignHead,
    diff_refs: { base_sha: 'b'.repeat(40), start_sha: 'c'.repeat(40), head_sha: foreignHead }
  })]
  world.server.mergeRequestPipelines.set('5', [currentForForeignHead])
  world.server.pipelines = [currentForForeignHead]
  world.server.jobs = [job(world, 702, 'build', 'failed', foreignHead, 90)]
  await expect(world.call('rerunChecks', { number: 5, failedOnly: true, allowPartial: true })).rejects.toMatchObject(reason('stale_head'))
  expect(world.server.requests.some((request) => request.method === 'POST')).toBe(false)
}, 30_000)

test('allowPartial does not bypass jobs read failures or malformed pagination', async () => {
  const world = await boot()
  const head = localHead(world)
  const jobs = Array.from({ length: 150 }, (_, index) => job(world, 2000 + index, `job-${index}`, index === 0 ? 'failed' : 'success', head))
  setCurrentPipeline(world, head, 90, 'failed', jobs)
  const jobsPath = pipelineJobsPath(world, 90)

  world.server.failures.set(`GET ${jobsPath}?page=2`, { status: 500 })
  await expect(world.call('rerunChecks', { number: 5, failedOnly: true, allowPartial: true })).rejects.toMatchObject(reason('checks_incomplete'))
  expect(world.server.requests.some((request) => request.method === 'POST')).toBe(false)

  world.server.requests.length = 0
  world.server.failures.clear()
  world.server.nextPages.set(`GET ${jobsPath}?page=1`, 'https://attacker.invalid/api/v4/jobs?page=2')
  const malformed = await world.call('rerunChecks', { number: 5, failedOnly: true, allowPartial: true }).catch((error) => error)
  expect(['checks_incomplete', 'schema_drift']).toContain(errorReasonValue(malformed))
  expect(world.server.requests.some((request) => request.method === 'POST')).toBe(false)
  world.server.requests.length = 0
  world.server.nextPages.clear()
  world.server.jobs = [job(world, 201, 'build', 'failed', head, 90, { commit: { short_id: 'missing-full-sha' } })]
  await expect(world.call('rerunChecks', { number: 5, failedOnly: true, allowPartial: true })).rejects.toMatchObject(reason('schema_drift'))
  expect(world.server.requests.some((request) => request.method === 'POST')).toBe(false)
}, 20_000)
test('the first retry refusal preserves 403 and 429 provider reasons with one attempted POST', async () => {
  for (const [status, expectedReason] of [[403, 'permission_denied'], [429, 'rate_limited']] as const) {
    const world = await boot()
    setupDefault(world)
    world.server.failures.set(`POST ${jobPath(world, 201)}/retry`, {
      status,
      headers: status === 429 ? { 'Retry-After': '60' } : undefined
    })

    const error = await world.call('rerunChecks', { number: 5, failedOnly: false }).catch((value) => value)
    expect(errorReasonValue(error)).toBe(expectedReason)
    if (status === 429) {
      const retryDisabledUntil = errorDataValue(error, 'retryDisabledUntil')
      expect(typeof retryDisabledUntil).toBe('number')
      expect(typeof retryDisabledUntil === 'number' && retryDisabledUntil > Date.now()).toBe(true)
    }
    expect(world.server.requests.filter((request) => request.method === 'POST').map((request) => request.path)).toEqual([
      `${jobPath(world, 201)}/retry`
    ])
    expect(world.server.jobs.some((value) => value.id === 201)).toBe(true)
    await world.cleanup()
    active = undefined
  }
}, 30_000)

test('a second-target refusal reports the exact confirmed partial start for two targets', async () => {
  const world = await boot()
  const head = localHead(world)
  setCurrentPipeline(world, head, 90, 'failed', [
    job(world, 201, 'build', 'failed', head),
    job(world, 202, 'lint', 'failed', head),
  ])
  const events: unknown[] = []
  world.client.onEvent((event) => events.push(event))
  await world.client.callAny('events.subscribe', {})
  world.server.failures.set(`POST ${jobPath(world, 202)}/retry`, { status: 403 })

  const error = await world.call('rerunChecks', { number: 5, failedOnly: false }).catch((value) => value)
  expect(errorReasonValue(error)).toBe('partial_failure')
  expect(errorDataValue(error, 'partial')).toBe(true)
  expect(errorDataValue(error, 'startedCount')).toBe(1)
  expect(errorDataValue(error, 'targetCount')).toBe(2)
  expect(errorDataValue(error, 'completedSteps')).toEqual(['check:201'])
  expect(errorDataValue(error, 'causeReason')).toBe('permission_denied')
  expect(events).toContainEqual(expect.objectContaining({
    type: 'quirky.hosting/changed',
    data: expect.objectContaining({ number: 5, operation: 'rerunChecks', partial: true, completedSteps: ['check:201'] })
  }))
  expect(world.server.requests.filter((request) => request.method === 'POST').map((request) => request.path)).toEqual([
    `${jobPath(world, 201)}/retry`,
    `${jobPath(world, 202)}/retry`
  ])
}, 20_000)

test('a post-mutation drop, server error, output cap, or malformed success is never retried', async () => {
  const modes = ['drop-after-mutation', 'server-error-after-mutation', 'output-limit-after-mutation', 'malformed-after-mutation'] as const
  for (const mode of modes) {
    const world = await boot()
    setupDefault(world)
    const events: unknown[] = []
    world.client.onEvent((event) => events.push(event))
    await world.client.callAny('events.subscribe', {})
    world.server.retryModes.set('201', mode)

    const error = await world.call('rerunChecks', { number: 5, failedOnly: true }).catch((value) => value)
    expect(errorReasonValue(error)).toBe('unknown_completion')
    expect(errorDataValue(error, 'uncertain')).toBe(true)
    expect(errorDataValue(error, 'startedCount')).toBe(0)
    expect(errorDataValue(error, 'completedSteps')).toEqual([])
    expect(world.server.requests.filter((request) => request.method === 'POST').map((request) => request.path)).toEqual([
      `${jobPath(world, 201)}/retry`
    ])
    expect(world.server.jobs.some((value) => value.id === 201)).toBe(false)
    expect(world.server.jobs.some((value) => value.name === 'build' && value.status === 'pending')).toBe(true)
    expect(events).toContainEqual(expect.objectContaining({
      type: 'quirky.hosting/changed',
      data: expect.objectContaining({ number: 5, operation: 'rerunChecks', uncertain: true })
    }))
    await world.cleanup()
    active = undefined
  }
}, 60_000)

test('an uncertain later POST reports only the prior confirmed start and stops before the next job', async () => {
  const world = await boot()
  const head = localHead(world)
  setCurrentPipeline(world, head, 90, 'failed', [
    job(world, 201, 'build', 'failed', head),
    job(world, 202, 'lint', 'failed', head),
    job(world, 203, 'package', 'failed', head)
  ])
  world.server.retryModes.set('202', 'drop-after-mutation')
  const events: unknown[] = []
  world.client.onEvent((event) => events.push(event))
  await world.client.callAny('events.subscribe', {})

  const error = await world.call('rerunChecks', { number: 5, failedOnly: false }).catch((value) => value)
  expect(errorReasonValue(error)).toBe('partial_failure')
  expect(errorDataValue(error, 'partial')).toBe(true)
  expect(errorDataValue(error, 'startedCount')).toBe(1)
  expect(errorDataValue(error, 'targetCount')).toBe(3)
  expect(errorDataValue(error, 'completedSteps')).toEqual(['check:201'])
  expect(errorDataValue(error, 'uncertain')).toBe(true)
  expect(errorDataValue(error, 'causeReason')).toBe('unknown_completion')
  expect(errorDataValue(error, 'unknownTarget')).toBe('check:202')
  expect(events).toContainEqual(expect.objectContaining({
    type: 'quirky.hosting/changed',
    data: expect.objectContaining({ number: 5, operation: 'rerunChecks', partial: true, uncertain: true })
  }))
  expect(world.server.requests.filter((request) => request.method === 'POST').map((request) => request.path)).toEqual([
    `${jobPath(world, 201)}/retry`,
    `${jobPath(world, 202)}/retry`
  ])
}, 20_000)
test('retry refuses local, remote, MR-head, pipeline, host, and saved-config changes before the first POST', async () => {
  const mutations: Array<[string, (world: GitLabWorld, head: string) => Promise<void>]> = [
    ['local head', async (world) => { runGit(world, ['commit', '--allow-empty', '-m', 'advance retry head']) }],
    ['branch', async (world) => { runGit(world, ['checkout', '-b', 'retry-stale-branch']) }],
    ['origin', async (world) => { runGit(world, ['remote', 'set-url', 'origin', `http://${world.identity.host}/other/group/proj.git`]) }],
    ['MR head', async (world) => {
      const changed = 'd'.repeat(40)
      world.server.mergeRequests = [mergeRequest({
        sha: changed,
        diff_refs: { base_sha: 'b'.repeat(40), start_sha: 'c'.repeat(40), head_sha: changed }
      })]
    }],
    ['selected pipeline', async (world, head) => {
      const newer = pipeline(91, head)
      world.server.mergeRequestPipelines.set('5', [pipeline(90, head), newer])
      world.server.pipelines = [pipeline(90, head), newer]
    }],
    ['host allowlist', async (world) => {
      await world.client.callAny('setting.set', { id: 'setting:quirky.hosting/gitlabHosts', value: 'gitlab.com' })
    }],
    ['saved configuration', async (world) => {
      runGit(world, ['remote', 'set-url', 'origin', 'https://github.com/test-owner/test-repo.git'])
      await world.call('configure', { issueSourcePreference: 'upstream' })
      runGit(world, ['remote', 'set-url', 'origin', `http://${world.identity.host}/group/sub/proj.git`])
    }]
  ]

  for (const [label, mutate] of mutations) {
    const world = await boot(label === 'saved configuration' ? { ghSource: 'process.stdout.write("{}")' } : {})
    const head = localHead(world)
    setCurrentPipeline(world, head, 90, 'failed', [
      job(world, 201, 'build', 'failed', head),
      job(world, 202, 'lint', 'failed', head)
    ])
    const barrier = holdResponse(world, 'GET', jobPath(world, 201))
    const pending = world.call('rerunChecks', { number: 5, failedOnly: false }).then(
      value => ({ kind: 'resolved' as const, value }),
      error => ({ kind: 'rejected' as const, error })
    )
    try {
      const requestStarted = await Promise.race([barrier.arrived.then(() => true), pending.then(() => false)])
      expect(requestStarted).toBe(true)
      await mutate(world, head)
    } finally {
      barrier.release()
    }
    const outcome = await pending
    expect(outcome.kind).toBe('rejected')
    if (outcome.kind === 'rejected') {
      expect(['stale_head', 'stale_target']).toContain(errorReasonValue(outcome.error))
    }
    expect(world.server.requests.some((request) => request.method === 'POST')).toBe(false)
    await world.cleanup()
    active = undefined
  }
}, 60_000)

test('a target change between retry POSTs reports one confirmed start and does not retarget job two', async () => {
  const world = await boot()
  const head = localHead(world)
  setCurrentPipeline(world, head, 90, 'failed', [
    job(world, 201, 'build', 'failed', head),
    job(world, 202, 'lint', 'failed', head)
  ])
  const barrier = holdResponse(world, 'GET', jobPath(world, 202))
  const pending = world.call('rerunChecks', { number: 5, failedOnly: false }).then(
    value => ({ kind: 'resolved' as const, value }),
    error => ({ kind: 'rejected' as const, error })
  )
  try {
    const requestStarted = await Promise.race([barrier.arrived.then(() => true), pending.then(() => false)])
    expect(requestStarted).toBe(true)
    const changed = 'e'.repeat(40)
    world.server.mergeRequests = [mergeRequest({
      sha: changed,
      diff_refs: { base_sha: 'b'.repeat(40), start_sha: 'c'.repeat(40), head_sha: changed }
    })]
  } finally {
    barrier.release()
  }

  const outcome = await pending
  expect(outcome.kind).toBe('rejected')
  if (outcome.kind === 'rejected') {
    expect(errorReasonValue(outcome.error)).toBe('partial_failure')
    expect(errorDataValue(outcome.error, 'partial')).toBe(true)
    expect(errorDataValue(outcome.error, 'startedCount')).toBe(1)
    expect(errorDataValue(outcome.error, 'targetCount')).toBe(2)
    expect(errorDataValue(outcome.error, 'completedSteps')).toEqual(['check:201'])
  }
  expect(world.server.requests.filter((request) => request.method === 'POST').map((request) => request.path)).toEqual([
    `${jobPath(world, 201)}/retry`
  ])
}, 20_000)
test('retry refuses a job that stops being retryable before the second POST', async () => {
  const world = await boot()
  const head = localHead(world)
  setCurrentPipeline(world, head, 90, 'failed', [
    job(world, 201, 'build', 'failed', head),
    job(world, 202, 'lint', 'failed', head)
  ])
  const barrier = holdResponse(world, 'GET', jobPath(world, 202))
  const pending = world.call('rerunChecks', { number: 5, failedOnly: false }).then(
    value => ({ kind: 'resolved' as const, value }),
    error => ({ kind: 'rejected' as const, error })
  )
  try {
    const requestStarted = await Promise.race([barrier.arrived.then(() => true), pending.then(() => false)])
    expect(requestStarted).toBe(true)
    world.server.jobs = world.server.jobs.map((value) => value.id === 202 ? { ...value, status: 'manual' } : value)
  } finally {
    barrier.release()
  }

  const outcome = await pending
  expect(outcome.kind).toBe('rejected')
  if (outcome.kind === 'rejected') {
    expect(errorReasonValue(outcome.error)).toBe('partial_failure')
    expect(errorDataValue(outcome.error, 'startedCount')).toBe(1)
    expect(errorDataValue(outcome.error, 'completedSteps')).toEqual(['check:201'])
  }
  expect(world.server.requests.filter((request) => request.method === 'POST').map((request) => request.path)).toEqual([
    `${jobPath(world, 201)}/retry`
  ])
}, 20_000)
test('retry reports a partial start when local head or selected pipeline changes between targets', async () => {
  const mutations: Array<[(world: GitLabWorld, head: string) => void, string]> = [
    [(world) => { runGit(world, ['commit', '--allow-empty', '-m', 'advance head between retry targets']) }, 'stale_head'],
    [(world, head) => {
      const current = pipeline(90, head)
      const replacement = pipeline(91, head)
      world.server.mergeRequestPipelines.set('5', [current, replacement])
      world.server.pipelines = [current, replacement]
    }, 'stale_target']
  ]
  for (const [mutate, staleReason] of mutations) {
    const world = await boot()
    const head = localHead(world)
    setCurrentPipeline(world, head, 90, 'failed', [
      job(world, 201, 'build', 'failed', head),
      job(world, 202, 'lint', 'failed', head)
    ])
    const barrier = holdResponse(world, 'GET', jobPath(world, 202))
    const pending = world.call('rerunChecks', { number: 5, failedOnly: false }).then(
      value => ({ kind: 'resolved' as const, value }),
      error => ({ kind: 'rejected' as const, error })
    )
    try {
      const requestStarted = await Promise.race([barrier.arrived.then(() => true), pending.then(() => false)])
      expect(requestStarted).toBe(true)
      mutate(world, head)
    } finally {
      barrier.release()
    }

    const outcome = await pending
    expect(outcome.kind).toBe('rejected')
    if (outcome.kind === 'rejected') {
      expect(errorReasonValue(outcome.error)).toBe('partial_failure')
      expect(errorDataValue(outcome.error, 'startedCount')).toBe(1)
      expect(errorDataValue(outcome.error, 'completedSteps')).toEqual(['check:201'])
      expect(errorDataValue(outcome.error, 'causeReason')).toBe(staleReason)
    }
    expect(world.server.requests.filter((request) => request.method === 'POST').map((request) => request.path)).toEqual([
      `${jobPath(world, 201)}/retry`
    ])
    await world.cleanup()
    active = undefined
  }
}, 40_000)
test('generated CLI checks, details, and retry return the routed JSON envelopes with exact flags', async () => {
  const world = await boot()
  setupDefault(world)

  const expectedChecks = await world.call('checks', { number: 5, noCache: true })
  const checksCli = await world.cli([
    '--json', 'hosting', 'checks',
    '--worktree', world.worktree,
    '--number', '5',
    '--no-cache'
  ])
  expect(checksCli.code).toBe(0)
  expect(JSON.parse(checksCli.stdout)).toEqual(expectedChecks)

  const expectedDetails = await world.call('checkDetails', { number: 5, checkRunId: 201, workflowRunId: 90 })
  const detailsCli = await world.cli([
    '--json', 'hosting', 'check-details',
    '--worktree', world.worktree,
    '--number', '5',
    '--check-run-id', '201',
    '--workflow-run-id', '90'
  ])
  expect(detailsCli.code).toBe(0)
  expect(JSON.parse(detailsCli.stdout)).toEqual(expectedDetails)

  const retryCli = await world.cli([
    '--json', 'hosting', 'rerun-checks',
    '--worktree', world.worktree,
    '--number', '5',
    '--failed-only'
  ])
  expect(retryCli.code).toBe(0)
  expect(JSON.parse(retryCli.stdout)).toEqual({
    started: 1,
    targetCount: 1,
    completedSteps: ['check:201']
  })
  expect(world.server.requests.filter((request) => request.method === 'POST').map((request) => ({
    path: request.path, body: request.body
  }))).toEqual([{ path: `${jobPath(world, 201)}/retry`, body: null }])
  expect(world.glabInvocations()).toEqual([])
  expect(world.invocations()).toEqual([])
}, 30_000)
test('retry refuses a removed and recreated worktree instance before its first POST', async () => {
  const world = await boot()
  const original = await world.client.callAny('quirky.worktree/show', { worktree: world.worktree }) as { repoId: string }
  runGit(world, ['branch', 'retry-instance-target'])
  const createTarget = async (branch: string) => await world.client.callAny('quirky.worktree/create', {
    repo: original.repoId,
    name: 'retry-instance-target',
    branch
  }) as { worktree: { id: string; instanceId: string } }
  const first = await createTarget('retry-instance-target')
  const head = localHead(world)
  const branch = 'retry-instance-target'
  const current = pipeline(90, head, { ref: branch })
  world.server.mergeRequests = [mergeRequest({
    sha: head,
    source_branch: branch,
    diff_refs: { base_sha: 'b'.repeat(40), start_sha: 'c'.repeat(40), head_sha: head },
    head_pipeline: { ...current }
  })]
  world.server.mergeRequestPipelines.set('5', [current])
  world.server.pipelines = [current]
  world.server.jobs = [job(world, 201, 'build', 'failed', head, 90, {
    pipeline: { id: 90, project_id: 42, ref: branch, sha: head, status: 'failed' }
  })]
  const barrier = holdResponse(world, 'GET', jobPath(world, 201))
  const pending = world.call('rerunChecks', {
    worktree: first.worktree.id,
    number: 5,
    failedOnly: true
  }).then(
    value => ({ kind: 'resolved' as const, value }),
    error => ({ kind: 'rejected' as const, error })
  )
  try {
    const requestStarted = await Promise.race([barrier.arrived.then(() => true), pending.then(() => false)])
    expect(requestStarted).toBe(true)
    await world.client.callAny('quirky.worktree/remove', { worktree: first.worktree.id, yes: true })
    runGit(world, ['branch', 'retry-instance-replacement'])
    const replacement = await createTarget('retry-instance-replacement')
    expect(replacement.worktree.id).toBe(first.worktree.id)
    expect(replacement.worktree.instanceId).not.toBe(first.worktree.instanceId)
  } finally {
    barrier.release()
  }

  const outcome = await pending
  expect(outcome.kind).toBe('rejected')
  if (outcome.kind === 'rejected') {
    expect(errorReasonValue(outcome.error)).toBe('stale_target')
  }
  expect(world.server.requests.some((request) => request.method === 'POST')).toBe(false)
}, 20_000)

test('advancing pagination jumps cannot skip jobs or authorize a partial retry', async () => {
  const world = await boot()
  const head = localHead(world)
  const jobs = Array.from({ length: 150 }, (_, index) => job(world, 5000 + index, `job-${index}`, index === 0 ? 'failed' : 'success', head))
  setCurrentPipeline(world, head, 90, 'failed', jobs)
  const complete = await world.call('checks', { number: 5, noCache: true }) as { checks: unknown[]; partial: boolean }
  expect(complete.partial).toBe(false)
  expect(complete.checks).toHaveLength(150)

  world.server.requests.length = 0
  world.server.nextPages.set(`GET ${pipelineJobsPath(world, 90)}?page=1`, '3')
  const incomplete = await world.call('checks', { number: 5, noCache: true }) as { checks: unknown[]; partial: boolean }
  expect(incomplete.partial).toBe(true)
  expect(incomplete.checks).toHaveLength(100)
  expect(world.server.requests.filter((request) => request.path === pipelineJobsPath(world, 90)).map((request) => request.query.page)).toEqual(['1'])
  await expect(world.call('rerunChecks', { number: 5, failedOnly: true, allowPartial: true })).rejects.toMatchObject(reason('checks_incomplete'))
  expect(world.server.requests.some((request) => request.method === 'POST')).toBe(false)
}, 20_000)
