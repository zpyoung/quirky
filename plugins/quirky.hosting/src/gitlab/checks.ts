import type { PluginCaller, Worktree } from '@quirky/protocol'
import type { CheckRecord } from '../check-details'
import { isRecord } from '../data'
import type { HostingEnv, HostingConfiguration } from '../env'
import { gitlabError, type GitLabClient, type GitLabResponse } from './api'
import { parseGitLabHosts, parseGitLabRemote } from './identity'
import type { GitLabHandlers, GitLabScope } from './types'

type Rollup = 'neutral' | 'pending' | 'success' | 'failure' | 'unknown'
type Job = {
  id: number
  name: string
  status: string
  allowFailure: boolean
  startedAt: string | null
  completedAt: string | null
  pipelineId: number
  projectId: number
  sha: string
  commitSha: string
  ref: string
}
type Pipeline = { id: number; projectId: number; sha: string; ref: string; status: string }
type Project = { id: number }
type MergeRequest = { headSha: string; sourceBranch: string }
type Target = {
  projectId: number
  mergeRequestIid: number
  headSha: string
  sourceBranch: string
  pipeline: Pipeline | null
  partialFailures: string[]
  incomplete: boolean
}
type Enumerated<T> = { items: T[]; truncated: boolean; unavailable: boolean; malformedPagination: boolean }
type JobList = {
  jobs: Job[]
  partialFailures: string[]
  truncated: boolean
  unavailable: boolean
  malformedPagination: boolean
}
type LocalFence = {
  worktree: { id: string; instanceId: string; repoId: string; path: string }
  branch: string
  headSha: string
  remotes: { origin: string | null; upstream: string | null }
  configuration: HostingConfiguration
  hostSetting: string
}

const MAX_PAGES = 5
const PAGE_SIZE = 100
const MAX_TRACE_LINES = 100
const MAX_TRACE_BYTES = 16 * 1024
const SCHEMA_DRIFT_MESSAGE = 'GitLab returned an unsupported API response.'
const HARD_READ_REASONS: Record<string, true> = {
  auth_required: true,
  permission_denied: true,
  rate_limited: true,
  schema_drift: true,
  invalid_input: true,
  repository_mismatch: true,
  unsupported_provider: true,
  checks_incomplete: true,
  stale_head: true,
  stale_target: true,
  foreign_target: true
}
const KNOWN_RETRY_REFUSALS: Record<string, true> = {
  auth_required: true,
  permission_denied: true,
  rate_limited: true,
  validation_error: true,
  not_found: true,
  already_exists: true
}

export function createGitLabCheckMethods(env: HostingEnv, client: GitLabClient): GitLabHandlers {
  return {
    checks: async (scope, params) => {
      const number = requiredPositive(env, params.number, 'A positive merge request number is required.')
      const noCache = readNoCache(env, params)
      const target = await loadTarget(env, client, scope, number)
      const partialFailures = [...target.partialFailures]
      if (target.pipeline === null) {
        return makeChecksResult(number, target.headSha, [], partialFailures,
          target.incomplete ? 'unknown' : 'neutral')
      }

      const key = env.cacheKey(scope, `gitlab-check-jobs:${number}:${target.pipeline.id}:${target.headSha}`)
      const jobs = noCache
        ? await loadJobs(env, client, scope, target)
        : await env.cache(key, 60_000, () => loadJobs(env, client, scope, target))
      partialFailures.push(...jobs.partialFailures)
      const checks = jobs.jobs.map((job) => mapCheck(scope, target.pipeline!.id, job))
      const rollup = rollupFor(target.pipeline.status, jobs.jobs, partialFailures.length > 0)
      return makeChecksResult(number, target.headSha, checks, partialFailures, rollup)
    },
    checkDetails: async (scope, params, caller) => {
      const number = requiredPositive(env, params.number, 'A positive merge request number is required.')
      const checkRunId = requiredPositive(env, params.checkRunId, 'A positive check run ID is required.')
      const workflowRunId = optionalPositive(env, params.workflowRunId, 'The workflow run ID must be a positive integer.')
      const jobName = optionalJobName(env, params.jobName)
      readNoCache(env, params)
      if (caller === undefined) throw env.invalid('invalid_input', 'A caller is required to verify this worktree.')

      const local = await readLocalFence(env, scope, caller)
      const afterProviderRead = () => assertLocalFence(env, scope, caller, local)
      const target = await loadTarget(env, client, scope, number, afterProviderRead, true)
      requireCompleteTarget(env, target)
      if (target.pipeline === null) throw env.invalid('not_found', 'No current merge request pipeline contains this check.')
      assertLocalMatchesTarget(env, local, target)
      if (workflowRunId !== undefined && workflowRunId !== target.pipeline.id) {
        throw env.invalid('invalid_input', 'The workflow run ID does not match the selected current pipeline.')
      }
      await afterProviderRead()

      const jobResponse = await client.request(scope, {
        method: 'GET', path: `${projectPath(scope)}/jobs/${checkRunId}`
      })
      await afterProviderRead()
      const job = parseDetailJob(env, jobResponse.json, checkRunId, target)
      if (jobName !== undefined && jobName !== job.name) {
        throw env.invalid('invalid_input', 'The check job name does not match the selected job.')
      }
      assertLocalMatchesTarget(env, local, target)

      await assertCurrentTarget(env, client, scope, number, target, caller, local)
      const credentials = await client.token(scope)
      if (credentials.token === null) throw gitlabError(env, 'auth_required', 'GitLab authentication is unavailable.')
      await assertCurrentTarget(env, client, scope, number, target, caller, local)

      let traceText: string | null = null
      let traceFailed = false
      let traceError: unknown
      try {
        traceText = await client.trace(scope, checkRunId, credentials.token)
      } catch (error) {
        traceFailed = true
        traceError = error
      }
      await assertCurrentTarget(env, client, scope, number, target, caller, local)

      const mapped = mapJob(job)
      const canonicalUrl = jobUrl(scope, checkRunId)
      const partialFailures: string[] = []
      const logTails: { jobId: number; jobName: string; tail: string }[] = []
      let truncated = false
      if (traceFailed) {
        const reason = errorReason(traceError)
        if (reason === 'trace_output_limit') truncated = true
        partialFailures.push(traceFailureMarker(reason))
      } else {
        const tail = sanitizeTrace(traceText ?? '', credentials.token)
        logTails.push({ jobId: job.id, jobName: job.name, tail: tail.text })
        truncated = tail.truncated
      }

      return {
        check: {
          id: job.id,
          name: job.name,
          status: mapped.status,
          conclusion: mapped.conclusion,
          headSha: target.headSha,
          detailsUrl: canonicalUrl,
          workflowRunId: target.pipeline.id
        },
        annotations: [],
        jobs: [{
          id: job.id,
          name: job.name,
          status: mapped.status,
          conclusion: mapped.conclusion,
          startedAt: job.startedAt,
          completedAt: job.completedAt,
          htmlUrl: canonicalUrl,
          checkRunUrl: null
        }],
        logTails,
        partialFailures,
        truncated
      }
    },
    rerunChecks: (scope, params, caller) => rerunChecks(env, client, scope, params, caller),
  }
}

async function loadTarget(
  env: HostingEnv,
  client: GitLabClient,
  scope: GitLabScope,
  number: number,
  afterProviderRead?: () => Promise<void>,
  forDetails = false
): Promise<Target> {
  const projectResponse = await client.request(scope, { method: 'GET', path: projectPath(scope) })
  await afterProviderRead?.()
  const project = parseProject(env, projectResponse.json, scope)

  const mergeRequestResponse = await client.request(scope, {
    method: 'GET', path: `${projectPath(scope)}/merge_requests/${number}`
  })
  await afterProviderRead?.()
  const mergeRequest = parseMergeRequest(env, mergeRequestResponse.json, number, project.id)

  const pipelines = await enumeratePages(env, client, scope,
    `${projectPath(scope)}/merge_requests/${number}/pipelines`, { per_page: PAGE_SIZE },
    (value) => parsePipelineEntry(env, value, project.id), afterProviderRead)
  const partialFailures: string[] = []
  if (pipelines.unavailable) partialFailures.push('pipelines_unavailable')
  if (pipelines.truncated) partialFailures.push('pipelines_truncated')
  if (pipelines.unavailable) {
    return {
      projectId: project.id,
      mergeRequestIid: number,
      headSha: mergeRequest.headSha,
      sourceBranch: mergeRequest.sourceBranch,
      pipeline: null,
      partialFailures,
      incomplete: true
    }
  }

  const byId = new Map<number, Pipeline>()
  for (const pipeline of pipelines.items) {
    const previous = byId.get(pipeline.id)
    if (previous !== undefined && !samePipelineIdentity(previous, pipeline)) schemaDrift(env)
    byId.set(pipeline.id, previous ?? pipeline)
  }
  let selected: Pipeline | null = null
  for (const pipeline of byId.values()) {
    if (sameSha(pipeline.sha, mergeRequest.headSha) && (selected === null || pipeline.id > selected.id)) selected = pipeline
  }

  if (selected === null) {
    return {
      projectId: project.id,
      mergeRequestIid: number,
      headSha: mergeRequest.headSha,
      sourceBranch: mergeRequest.sourceBranch,
      pipeline: null,
      partialFailures,
      incomplete: pipelines.unavailable || pipelines.truncated
    }
  }

  let verified: Pipeline
  try {
    const response = await client.request(scope, {
      method: 'GET', path: `${projectPath(scope)}/pipelines/${selected.id}`
    })
    await afterProviderRead?.()
    verified = parsePipeline(env, response.json)
  } catch (error) {
    if (isHardReadError(error)) throw error
    partialFailures.push('pipelines_unavailable')
    return {
      projectId: project.id,
      mergeRequestIid: number,
      headSha: mergeRequest.headSha,
      sourceBranch: mergeRequest.sourceBranch,
      pipeline: null,
      partialFailures,
      incomplete: true
    }
  }
  if (verified.id !== selected.id) schemaDrift(env)
  if (verified.projectId !== project.id) {
    if (forDetails) throw gitlabError(env, 'foreign_target', 'The verified pipeline belongs to another GitLab project.')
    schemaDrift(env)
  }
  if (!sameSha(verified.sha, mergeRequest.headSha)) {
    if (forDetails) throw gitlabError(env, 'stale_head', 'The verified pipeline belongs to a different merge request head.')
    schemaDrift(env)
  }
  if (!isCurrentMergeRequestRef(verified.ref, number, mergeRequest.sourceBranch)) {
    if (forDetails) throw gitlabError(env, 'foreign_target', 'The verified pipeline does not match the merge request branch.')
    schemaDrift(env)
  }

  return {
    projectId: project.id,
    mergeRequestIid: number,
    headSha: mergeRequest.headSha,
    sourceBranch: mergeRequest.sourceBranch,
    pipeline: verified,
    partialFailures,
    incomplete: pipelines.unavailable || pipelines.truncated
  }
}

async function enumeratePages<T>(
  env: HostingEnv,
  client: GitLabClient,
  scope: GitLabScope,
  path: string,
  query: Record<string, string | number | boolean>,
  parseItem: (value: unknown) => T,
  afterProviderRead?: () => Promise<void>
): Promise<Enumerated<T>> {
  const items: T[] = []
  let page = 1
  let truncated = false
  let malformedPagination = false
  for (let index = 0; index < MAX_PAGES; index += 1) {
    let response: GitLabResponse
    try {
      response = await client.request(scope, {
        method: 'GET', path, query: { ...query, page }
      })
      await afterProviderRead?.()
    } catch (error) {
      if (isHardReadError(error)) throw error
      return { items, truncated, unavailable: true, malformedPagination }
    }
    if (!Array.isArray(response.json) || response.json.length > PAGE_SIZE) schemaDrift(env)
    for (const value of response.json) items.push(parseItem(value))

    if (response.nextPageInvalid) {
      truncated = true
      malformedPagination = true
      break
    }
    const nextPage = response.nextPage
    if (nextPage === null) break
    if (nextPage !== page + 1) {
      truncated = true
      malformedPagination = true
      break
    }
    if (index === MAX_PAGES - 1) {
      truncated = true
      break
    }
    page = nextPage
  }
  return { items, truncated, unavailable: false, malformedPagination }
}

async function loadJobs(
  env: HostingEnv,
  client: GitLabClient,
  scope: GitLabScope,
  target: Target,
  afterProviderRead?: () => Promise<void>
): Promise<JobList> {
  const pipeline = target.pipeline
  if (pipeline === null) {
    return { jobs: [], partialFailures: [], truncated: false, unavailable: false, malformedPagination: false }
  }
  const rows = new Map<number, Job>()
  const enumeration = await enumeratePages(env, client, scope,
    `${projectPath(scope)}/pipelines/${pipeline.id}/jobs`,
    { per_page: PAGE_SIZE, include_retried: false },
    (value) => parseListedJob(env, value, target, pipeline.id), afterProviderRead)
  for (const job of enumeration.items) {
    const previous = rows.get(job.id)
    if (previous !== undefined && !sameJobIdentity(previous, job)) schemaDrift(env)
    if (previous === undefined) rows.set(job.id, job)
  }
  const partialFailures: string[] = []
  if (enumeration.unavailable) partialFailures.push('jobs_unavailable')
  if (enumeration.truncated) partialFailures.push('jobs_truncated')
  return {
    jobs: [...rows.values()],
    partialFailures,
    truncated: enumeration.truncated,
    unavailable: enumeration.unavailable,
    malformedPagination: enumeration.malformedPagination
  }
}
async function rerunChecks(
  env: HostingEnv,
  client: GitLabClient,
  scope: GitLabScope,
  params: Record<string, unknown>,
  caller?: PluginCaller
): Promise<Record<string, unknown>> {
  const number = requiredPositive(env, params.number, 'A positive merge request number is required.')
  if (typeof params.failedOnly !== 'boolean') {
    throw env.invalid('invalid_input', 'failedOnly must be a boolean.')
  }
  if (params.allowPartial !== undefined && typeof params.allowPartial !== 'boolean') {
    throw env.invalid('invalid_input', 'allowPartial must be a boolean.')
  }
  if (caller === undefined) throw env.invalid('invalid_input', 'A caller is required to verify this worktree.')
  const failedOnly = params.failedOnly
  const allowPartial = params.allowPartial === true
  const local = await readLocalFence(env, scope, caller)
  const afterProviderRead = () => assertLocalFence(env, scope, caller, local)
  const target = await loadTarget(env, client, scope, number, afterProviderRead, true)
  requireCompleteTarget(env, target)
  assertLocalMatchesTarget(env, local, target)
  if (target.pipeline === null) {
    await assertNoCurrentPipeline(env, client, scope, number, target, caller, local)
    throw noRetryTargets(env, failedOnly)
  }

  const jobs = await loadJobs(env, client, scope, target, afterProviderRead)
  if (jobs.unavailable || jobs.malformedPagination
    || (jobs.truncated && !(failedOnly && allowPartial))) {
    throw incompleteChecks(env)
  }
  const partial = jobs.truncated
  const targets = jobs.jobs
    .filter((job) => isRetryableJob(job, failedOnly))
    .sort((left, right) => left.id - right.id)
  if (targets.length === 0) {
    await assertCurrentTarget(env, client, scope, number, target, caller, local)
    throw noRetryTargets(env, failedOnly)
  }

  const targetCount = targets.length
  const completedSteps: string[] = []
  const retriedJobIds = new Set(jobs.jobs.map((job) => job.id))
  for (const selectedJob of targets) {
    let currentJob: Job
    try {
      currentJob = await prepareRetryJob(env, client, scope, number, target, selectedJob, failedOnly, caller, local)
      await assertLocalFence(env, scope, caller, local)
    } catch (error) {
      if (completedSteps.length === 0) throw error
      return throwRetryPartial(env, scope, number, targetCount, completedSteps,
        errorReason(error) ?? 'checks_incomplete')
    }

    let retriedJob: Job
    try {
      const response = await client.request(scope, {
        method: 'POST', path: `${projectPath(scope)}/jobs/${currentJob.id}/retry`
      })
      retriedJob = parseRetriedJob(env, response.json, currentJob, target)
      if (retriedJobIds.has(retriedJob.id)) schemaDrift(env)
    } catch (error) {
      if (isKnownRetryRefusal(error)) {
        if (completedSteps.length === 0) throw error
        return throwRetryPartial(env, scope, number, targetCount, completedSteps,
          errorReason(error) ?? 'server_error')
      }
      return throwUnknownRetry(env, scope, number, targetCount, completedSteps, currentJob.id)
    }
    retriedJobIds.add(retriedJob.id)
    completedSteps.push(`check:${currentJob.id}`)
  }

  env.changed(scope, {
    number,
    operation: 'rerunChecks',
    completedSteps,
    ...(partial ? { partial: true, targetCount } : {})
  })
  return {
    started: completedSteps.length,
    targetCount,
    completedSteps,
    ...(partial ? { partial: true } : {})
  }
}
async function assertNoCurrentPipeline(
  env: HostingEnv,
  client: GitLabClient,
  scope: GitLabScope,
  number: number,
  expected: Target,
  caller: PluginCaller,
  local: LocalFence
): Promise<void> {
  await assertLocalFence(env, scope, caller, local)
  const current = await loadTarget(env, client, scope, number, () => assertLocalFence(env, scope, caller, local), true)
  if (current.headSha !== expected.headSha || current.sourceBranch !== expected.sourceBranch) {
    throw gitlabError(env, 'stale_head', 'The merge request changed while its retry targets were loading.')
  }
  requireCompleteTarget(env, current)
  if (current.projectId !== expected.projectId || current.pipeline !== null) {
    throw gitlabError(env, 'stale_target', 'The current merge request pipeline changed while its retry targets were loading.')
  }
  await assertLocalFence(env, scope, caller, local)
  assertLocalMatchesTarget(env, local, current)
}


async function prepareRetryJob(
  env: HostingEnv,
  client: GitLabClient,
  scope: GitLabScope,
  number: number,
  target: Target,
  selectedJob: Job,
  failedOnly: boolean,
  caller: PluginCaller,
  local: LocalFence
): Promise<Job> {
  await assertCurrentTarget(env, client, scope, number, target, caller, local)
  const response = await client.request(scope, {
    method: 'GET', path: `${projectPath(scope)}/jobs/${selectedJob.id}`
  })
  await assertLocalFence(env, scope, caller, local)
  const current = parseDetailJob(env, response.json, selectedJob.id, target)
  if (!sameJobIdentity(selectedJob, current) || !isRetryableJob(current, failedOnly)) {
    throw gitlabError(env, 'stale_target', 'The GitLab job is no longer a retryable member of the selected pipeline.')
  }
  await assertCurrentTarget(env, client, scope, number, target, caller, local)
  return current
}

function parseRetriedJob(env: HostingEnv, value: unknown, selectedJob: Job, target: Target): Job {
  if (!isRecord(value)) schemaDrift(env)
  const retried = parseJobIdentity(env, value)
  if (target.pipeline === null || retried.id === selectedJob.id || retried.name !== selectedJob.name
    || retried.pipelineId !== target.pipeline.id || retried.projectId !== target.projectId
    || !sameSha(retried.sha, target.headSha) || !sameSha(retried.commitSha, target.headSha)
    || !isCurrentMergeRequestRef(retried.ref, target.mergeRequestIid, target.sourceBranch)) schemaDrift(env)
  return retried
}

function isRetryableJob(job: Job, failedOnly: boolean): boolean {
  if (job.status === 'failed' || job.status === 'canceled') return true
  return !failedOnly && job.status === 'success'
}

function noRetryTargets(env: HostingEnv, failedOnly: boolean): Error {
  return env.invalid(
    failedOnly ? 'no_failed_checks' : 'no_rerunnable_checks',
    failedOnly ? 'No failed or canceled GitLab jobs are available to retry.' : 'No GitLab jobs are available to retry.'
  )
}

function incompleteChecks(env: HostingEnv): Error {
  return gitlabError(env, 'checks_incomplete', 'GitLab job retry targets could not be completely verified.')
}

function throwRetryPartial(
  env: HostingEnv,
  scope: GitLabScope,
  number: number,
  targetCount: number,
  completedSteps: string[],
  causeReason: string
): never {
  const data = {
    partial: true,
    startedCount: completedSteps.length,
    targetCount,
    completedSteps,
    causeReason
  }
  env.changed(scope, { number, operation: 'rerunChecks', ...data })
  throw gitlabError(env, 'partial_failure', 'Some GitLab jobs were retried. Refresh checks before retrying.', data)
}

function throwUnknownRetry(
  env: HostingEnv,
  scope: GitLabScope,
  number: number,
  targetCount: number,
  completedSteps: string[],
  jobId: number
): never {
  const unknownTarget = `check:${jobId}`
  if (completedSteps.length === 0) {
    const data = {
      uncertain: true,
      startedCount: 0,
      targetCount,
      completedSteps
    }
    env.changed(scope, { number, operation: 'rerunChecks', ...data, unknownTarget })
    throw gitlabError(env, 'unknown_completion', 'GitLab may have retried this job. Refresh checks before retrying.', data)
  }
  const data = {
    partial: true,
    startedCount: completedSteps.length,
    targetCount,
    completedSteps,
    uncertain: true,
    causeReason: 'unknown_completion',
    unknownTarget
  }
  env.changed(scope, { number, operation: 'rerunChecks', ...data })
  throw gitlabError(env, 'partial_failure', 'Some GitLab jobs were retried; the latest job result is unknown. Refresh checks before retrying.', data)
}

function isKnownRetryRefusal(error: unknown): boolean {
  const reason = errorReason(error)
  return reason !== null && KNOWN_RETRY_REFUSALS[reason] === true
}


function parseProject(env: HostingEnv, value: unknown, scope: GitLabScope): Project {
  if (!isRecord(value) || !positive(value.id)
    || typeof value.path_with_namespace !== 'string'
    || value.path_with_namespace.toLowerCase() !== `${scope.repository.owner}/${scope.repository.repo}`.toLowerCase()) {
    schemaDrift(env)
  }
  return { id: value.id }
}

function parseMergeRequest(env: HostingEnv, value: unknown, number: number, projectId: number): MergeRequest {
  if (!isRecord(value) || !positive(value.id) || value.iid !== number || value.project_id !== projectId
    || typeof value.source_branch !== 'string' || value.source_branch.length === 0) schemaDrift(env)
  const diffRefs = isRecord(value.diff_refs) ? value.diff_refs : null
  const headSha = shaValue(diffRefs?.head_sha)
  if (headSha === null) schemaDrift(env)
  if (value.sha !== undefined && value.sha !== null && (!shaValue(value.sha) || !sameSha(value.sha, headSha))) schemaDrift(env)
  return { headSha, sourceBranch: value.source_branch }
}
function isCurrentMergeRequestRef(ref: string, mergeRequestIid: number, sourceBranch: string): boolean {
  return ref === sourceBranch || ref === `refs/merge-requests/${mergeRequestIid}/head`
}

function parsePipelineEntry(env: HostingEnv, value: unknown, projectId: number): Pipeline {
  if (!isRecord(value) || !positive(value.id) || value.project_id !== projectId
    || typeof value.ref !== 'string' || value.ref.length === 0) schemaDrift(env)
  const sha = shaValue(value.sha)
  if (sha === null) schemaDrift(env)
  const status = typeof value.status === 'string' ? value.status.toLowerCase() : 'unknown'
  return { id: value.id, projectId, sha, ref: value.ref, status }
}

function parsePipeline(env: HostingEnv, value: unknown): Pipeline {
  if (!isRecord(value) || !positive(value.id) || !positive(value.project_id)
    || typeof value.ref !== 'string' || value.ref.length === 0
    || typeof value.status !== 'string' || value.status.length === 0) schemaDrift(env)
  const sha = shaValue(value.sha)
  if (sha === null) schemaDrift(env)
  return { id: value.id, projectId: value.project_id, sha, ref: value.ref, status: value.status.toLowerCase() }
}

function parseListedJob(env: HostingEnv, value: unknown, target: Target, pipelineId: number): Job {
  if (!isRecord(value)) schemaDrift(env)
  const identity = parseJobIdentity(env, value)
  if (identity.id <= 0 || identity.pipelineId !== pipelineId || identity.projectId !== target.projectId
    || !sameSha(identity.sha, target.headSha) || !sameSha(identity.commitSha, target.headSha)
    || !isCurrentMergeRequestRef(identity.ref, target.mergeRequestIid, target.sourceBranch)) schemaDrift(env)
  if (isRecord(value) && value.project_id !== undefined && value.project_id !== target.projectId) schemaDrift(env)
  return identity
}

function parseDetailJob(env: HostingEnv, value: unknown, requestedId: number, target: Target): Job {
  if (!isRecord(value)) schemaDrift(env)
  const identity = parseJobIdentity(env, value)
  if (identity.id !== requestedId || identity.pipelineId !== target.pipeline?.id
    || identity.projectId !== target.projectId
    || (isRecord(value) && value.project_id !== undefined && value.project_id !== target.projectId)) {
    throw gitlabError(env, 'foreign_target', 'The GitLab job does not belong to the selected merge request pipeline.')
  }
  if (!sameSha(identity.sha, target.headSha) || !sameSha(identity.commitSha, target.headSha)) {
    throw gitlabError(env, 'stale_head', 'The GitLab job belongs to a different merge request head.')
  }
  if (!isCurrentMergeRequestRef(identity.ref, target.mergeRequestIid, target.sourceBranch)) {
    throw gitlabError(env, 'foreign_target', 'The GitLab job does not belong to the selected merge request pipeline.')
  }
  return identity
}

function parseJobIdentity(env: HostingEnv, value: Record<string, unknown>): Job {
  const pipeline = isRecord(value.pipeline) ? value.pipeline : null
  const commit = isRecord(value.commit) ? value.commit : null
  if (!positive(value.id) || typeof value.name !== 'string' || value.name.length === 0
    || typeof value.status !== 'string' || value.status.length === 0
    || typeof value.allow_failure !== 'boolean'
    || pipeline === null || !positive(pipeline.id) || !positive(pipeline.project_id)
    || typeof pipeline.ref !== 'string' || pipeline.ref.length === 0
    || commit === null) schemaDrift(env)
  const sha = shaValue(pipeline.sha)
  const commitSha = shaValue(commit.id)
  if (sha === null || commitSha === null) schemaDrift(env)
  return {
    id: value.id,
    name: value.name,
    status: value.status.toLowerCase(),
    allowFailure: value.allow_failure,
    startedAt: typeof value.started_at === 'string' ? value.started_at : null,
    completedAt: typeof value.finished_at === 'string' ? value.finished_at : null,
    pipelineId: pipeline.id,
    projectId: pipeline.project_id,
    sha,
    commitSha,
    ref: pipeline.ref
  }
}

function mapCheck(scope: GitLabScope, pipelineId: number, job: Job): CheckRecord {
  const mapped = mapJob(job)
  return {
    kind: 'check_run',
    name: job.name,
    status: mapped.status,
    conclusion: mapped.conclusion,
    url: jobUrl(scope, job.id),
    checkRunId: job.id,
    workflowRunId: pipelineId,
    suiteId: null,
    required: null
  }
}

function mapJob(job: Job): { status: string; conclusion: string | null } {
  switch (job.status) {
    case 'created':
    case 'waiting_for_resource':
    case 'preparing':
    case 'pending':
    case 'scheduled':
      return { status: 'queued', conclusion: null }
    case 'running':
      return { status: 'in_progress', conclusion: null }
    case 'success':
      return { status: 'completed', conclusion: 'success' }
    case 'failed':
      return { status: 'completed', conclusion: job.allowFailure ? 'neutral' : 'failure' }
    case 'canceled':
      return { status: 'completed', conclusion: 'cancelled' }
    case 'skipped':
      return { status: 'completed', conclusion: 'neutral' }
    case 'manual':
      return { status: 'action_required', conclusion: null }
    default:
      return { status: 'unknown', conclusion: null }
  }
}

function rollupFor(pipelineStatus: string, jobs: Job[], incomplete: boolean): Rollup {
  const verdicts: Rollup[] = [pipelineVerdict(pipelineStatus), ...jobs.map(jobVerdict)]
  if (verdicts.includes('failure')) return 'failure'
  if (verdicts.includes('pending')) return 'pending'
  if (verdicts.includes('unknown') || incomplete) return 'unknown'
  if (verdicts.includes('success')) return 'success'
  return 'neutral'
}

function pipelineVerdict(status: string): Rollup {
  switch (status) {
    case 'success': return 'success'
    case 'failed': return 'failure'
    case 'created':
    case 'waiting_for_resource':
    case 'preparing':
    case 'pending':
    case 'running':
    case 'scheduled': return 'pending'
    case 'canceled':
    case 'skipped':
    case 'manual': return 'neutral'
    default: return 'unknown'
  }
}

function jobVerdict(job: Job): Rollup {
  if (job.status === 'manual') return 'pending'
  const mapped = mapJob(job)
  if (mapped.conclusion === 'failure' || mapped.conclusion === 'cancelled') return 'failure'
  if (mapped.status === 'queued' || mapped.status === 'in_progress' || mapped.status === 'action_required') return 'pending'
  if (mapped.conclusion === 'success') return 'success'
  if (mapped.conclusion === 'neutral') return 'neutral'
  return 'unknown'
}

function makeChecksResult(
  number: number,
  headSha: string,
  checks: CheckRecord[],
  partialFailures: string[],
  rollup: Rollup
): Record<string, unknown> {
  checks.sort((left, right) => left.name.localeCompare(right.name)
    || (left.checkRunId ?? 0) - (right.checkRunId ?? 0))
  return { number, headSha, rollup, partial: partialFailures.length > 0, partialFailures, checks }
}

function readNoCache(env: HostingEnv, params: Record<string, unknown>): boolean {
  if (params.noCache === undefined) return false
  if (typeof params.noCache !== 'boolean') throw env.invalid('invalid_input', 'noCache must be a boolean.')
  return params.noCache
}

function requiredPositive(env: HostingEnv, value: unknown, message: string): number {
  if (!positive(value)) throw env.invalid('invalid_input', message)
  return value
}

function optionalPositive(env: HostingEnv, value: unknown, message: string): number | undefined {
  if (value === undefined) return undefined
  if (!positive(value)) throw env.invalid('invalid_input', message)
  return value
}

function optionalJobName(env: HostingEnv, value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) {
    throw env.invalid('invalid_input', 'The check job name must be a non-empty string of at most 200 characters.')
  }
  return value
}

async function readLocalFence(env: HostingEnv, scope: GitLabScope, caller: PluginCaller): Promise<LocalFence> {
  let worktree: Worktree
  try {
    worktree = await env.resolveWorktree(scope.worktree.id, caller)
  } catch {
    throw gitlabError(env, 'stale_target', 'The selected worktree changed while GitLab checks were loading.')
  }
  if (worktree.kind !== 'git' || worktree.id !== scope.worktree.id
    || worktree.instanceId !== scope.worktree.instanceId || worktree.repoId !== scope.worktree.repoId
    || worktree.path !== scope.worktree.path) {
    throw gitlabError(env, 'stale_target', 'The selected worktree changed while GitLab checks were loading.')
  }

  let branchText: string
  let headText: string
  let remotes: { origin: string | null; upstream: string | null }
  try {
    [branchText, headText, remotes] = await Promise.all([
      env.gitWorktree(worktree, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => ''),
      env.gitWorktree(worktree, ['rev-parse', '--verify', 'HEAD']).catch(() => ''),
      env.remoteUrls(worktree)
    ])
  } catch {
    throw gitlabError(env, 'stale_target', 'The selected worktree identity is unavailable.')
  }
  const branch = branchText.trim()
  const headSha = shaValue(headText.trim())
  if (branch.length === 0 || /[\u0000-\u001f\u007f]/u.test(branch) || headSha === null) {
    throw gitlabError(env, 'stale_head', 'The selected worktree is detached or its head changed.')
  }

  let rawHostSetting: unknown
  let configuration: HostingConfiguration
  try {
    rawHostSetting = env.context.getSetting('gitlabHosts') ?? 'gitlab.com'
    configuration = env.configuration(worktree)
  } catch {
    throw gitlabError(env, 'stale_target', 'The selected GitLab configuration changed while checks were loading.')
  }
  const hostSetting = settingStamp(rawHostSetting)
  const remoteIdentity = remotes.origin === null ? null : parseGitLabRemote(remotes.origin)
  if (remoteIdentity === null || !parseGitLabHosts(rawHostSetting).includes(remoteIdentity.host)
    || !sameIdentity(remoteIdentity, scope.repository)) {
    throw gitlabError(env, 'stale_target', 'The selected GitLab repository changed while checks were loading.')
  }
  return {
    worktree: { id: worktree.id, instanceId: worktree.instanceId, repoId: worktree.repoId, path: worktree.path },
    branch,
    headSha,
    remotes,
    configuration,
    hostSetting
  }
}

async function assertLocalFence(
  env: HostingEnv,
  scope: GitLabScope,
  caller: PluginCaller,
  expected: LocalFence
): Promise<void> {
  const current = await readLocalFence(env, scope, caller)
  if (current.worktree.id !== expected.worktree.id || current.worktree.instanceId !== expected.worktree.instanceId
    || current.worktree.repoId !== expected.worktree.repoId || current.worktree.path !== expected.worktree.path
    || current.remotes.origin !== expected.remotes.origin || current.remotes.upstream !== expected.remotes.upstream
    || current.hostSetting !== expected.hostSetting
    || configurationStamp(current.configuration) !== configurationStamp(expected.configuration)) {
    throw gitlabError(env, 'stale_target', 'The selected worktree identity changed while GitLab checks were loading.')
  }
  if (current.branch !== expected.branch || !sameSha(current.headSha, expected.headSha)) {
    throw gitlabError(env, 'stale_head', 'The selected worktree head changed while GitLab checks were loading.')
  }
}

function assertLocalMatchesTarget(env: HostingEnv, local: LocalFence, target: Target): void {
  if (local.branch !== target.sourceBranch || !sameSha(local.headSha, target.headSha)) {
    throw gitlabError(env, 'stale_head', 'The merge request no longer matches the selected worktree head.')
  }
}

async function assertCurrentTarget(
  env: HostingEnv,
  client: GitLabClient,
  scope: GitLabScope,
  number: number,
  expected: Target,
  caller: PluginCaller,
  local: LocalFence
): Promise<void> {
  await assertLocalFence(env, scope, caller, local)
  const current = await loadTarget(env, client, scope, number, () => assertLocalFence(env, scope, caller, local), true)
  if (current.headSha !== expected.headSha) {
    throw gitlabError(env, 'stale_head', 'The merge request head changed while its check details were loading.')
  }
  if (current.sourceBranch !== expected.sourceBranch) {
    throw gitlabError(env, 'stale_head', 'The merge request branch changed while its check details were loading.')
  }
  requireCompleteTarget(env, current)
  if (current.pipeline === null || expected.pipeline === null
    || current.projectId !== expected.projectId || current.pipeline.id !== expected.pipeline.id) {
    throw gitlabError(env, 'stale_target', 'The current merge request pipeline changed while its check details were loading.')
  }
  await assertLocalFence(env, scope, caller, local)
  assertLocalMatchesTarget(env, local, current)
}

function requireCompleteTarget(env: HostingEnv, target: Target): void {
  if (target.incomplete) {
    throw gitlabError(env, 'checks_incomplete', 'The current merge request pipelines could not be completely verified.')
  }
}


function traceFailureMarker(reason: string | null): string {
  switch (reason) {
    case 'trace_not_found': return 'trace_not_found'
    case 'trace_permission_denied': return 'trace_permission_denied'
    case 'trace_timeout': return 'trace_timeout'
    case 'trace_output_limit': return 'trace_output_limit'
    default: return 'trace_unavailable'
  }
}

function sanitizeTrace(value: string, token: string): { text: string; truncated: boolean } {
  let clean = stripTraceControlsAndTerminalSequences(value)
  if (token.length > 0) clean = replaceTraceToken(clean, token)
  clean = clean.replace(/\r\n?/gu, '\n')
    .replace(/\bBearer\s+[^\s"'<>]+/giu, 'Bearer [REDACTED]')
  clean = redactTraceUserinfo(clean)
  clean = redactTraceGitLabCredentials(clean)

  const hadTrailingNewline = clean.endsWith('\n')
  let lines = clean.length === 0 ? [] : clean.split('\n')
  if (hadTrailingNewline) lines = lines.slice(0, -1)
  let truncated = lines.length > MAX_TRACE_LINES
  lines = lines.slice(-MAX_TRACE_LINES)
  let text = lines.join('\n') + (hadTrailingNewline && lines.length > 0 ? '\n' : '')
  const bytes = new TextEncoder().encode(text)
  if (bytes.byteLength > MAX_TRACE_BYTES) {
    truncated = true
    let start = bytes.byteLength - MAX_TRACE_BYTES
    while (start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) start += 1
    text = new TextDecoder('utf-8').decode(bytes.subarray(start))
  }
  return { text, truncated }
}

function stripTraceControlsAndTerminalSequences(value: string): string {
  const output = new Uint16Array(value.length)
  let outputLength = 0
  for (let index = 0; index < value.length;) {
    const code = value.charCodeAt(index)
    let sequenceEnd: number | null = null
    if (code === 0x1b && value.charCodeAt(index + 1) === 0x5b) {
      sequenceEnd = skipTraceCsi(value, index + 2)
    } else if (code === 0x9b) {
      sequenceEnd = skipTraceCsi(value, index + 1)
    } else if (code === 0x1b && value.charCodeAt(index + 1) === 0x5d) {
      sequenceEnd = skipTraceOsc(value, index + 2)
    } else if (code === 0x9d) {
      sequenceEnd = skipTraceOsc(value, index + 1)
    }
    if (sequenceEnd !== null) {
      index = sequenceEnd
      continue
    }
    if (code <= 0x08 || code === 0x0b || code === 0x0c
      || (code >= 0x0e && code <= 0x1f) || (code >= 0x7f && code <= 0x9f)) {
      index += 1
      continue
    }
    output[outputLength++] = code
    index += 1
  }
  return traceStringFromCodeUnits(output, outputLength)
}

function traceStringFromCodeUnits(value: Uint16Array, length: number): string {
  const chunks: string[] = []
  const chunkSize = 8192
  for (let start = 0; start < length; start += chunkSize) {
    chunks.push(String.fromCharCode(...value.subarray(start, Math.min(start + chunkSize, length))))
  }
  return chunks.join('')
}

function skipTraceCsi(value: string, start: number): number {
  for (let index = start; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0x40 && code <= 0x7e) return index + 1
    if (code >= 0x20 && code <= 0x3f) continue
    return start
  }
  return value.length
}

function skipTraceOsc(value: string, start: number): number {
  for (let index = start; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code === 0x07 || code === 0x9c) return index + 1
    if (code === 0x1b && value.charCodeAt(index + 1) === 0x5c) return index + 2
  }
  return value.length
}

function redactTraceUserinfo(value: string): string {
  const parts: string[] = []
  let copyFrom = 0
  let searchFrom = 0
  while (true) {
    const separator = value.indexOf('://', searchFrom)
    if (separator < 0) break

    const userinfoStart = separator + 3
    let userinfoEnd = userinfoStart
    while (userinfoEnd < value.length) {
      const code = value.charCodeAt(userinfoEnd)
      if (code === 0x2f || code === 0x40 || code === 0x3f || code === 0x23 || isTraceWhitespace(code)) break
      userinfoEnd += 1
    }
    if (userinfoEnd > userinfoStart && value.charCodeAt(userinfoEnd) === 0x40) {
      parts.push(value.slice(copyFrom, separator + 3))
      copyFrom = userinfoEnd + 1
      searchFrom = copyFrom
    } else {
      searchFrom = separator + 3
    }
  }
  if (copyFrom === 0) return value
  parts.push(value.slice(copyFrom))
  return parts.join('')
}


function isTraceWhitespace(code: number): boolean {
  return (code >= 0x09 && code <= 0x0d) || code === 0x20 || code === 0x00a0
    || code === 0x1680 || (code >= 0x2000 && code <= 0x200a)
    || code === 0x2028 || code === 0x2029 || code === 0x202f
    || code === 0x205f || code === 0x3000 || code === 0xfeff
}

function replaceTraceToken(value: string, token: string): string {
  const firstMatch = value.indexOf(token)
  if (firstMatch < 0) return value
  const parts: string[] = []
  let copyFrom = 0
  let match = firstMatch
  while (match >= 0) {
    parts.push(value.slice(copyFrom, match), '[REDACTED]')
    copyFrom = match + token.length
    match = value.indexOf(token, copyFrom)
  }
  parts.push(value.slice(copyFrom))
  return parts.join('')
}
function redactTraceGitLabCredentials(value: string): string {
  return value.replace(/(?:glpat-|gldt-|glrt-)[A-Za-z0-9_-]+/gu, (credential: string, offset: number, whole: string) => {
    const end = offset + credential.length
    if (!whole.startsWith('://', end)) return '[REDACTED]'
    const scheme = credential.slice(-5)
    if (scheme.toLowerCase() === 'https') return `[REDACTED]${scheme}`
    const shortScheme = credential.slice(-4)
    return shortScheme.toLowerCase() === 'http' ? `[REDACTED]${shortScheme}` : '[REDACTED]'
  })
}

function jobUrl(scope: GitLabScope, jobId: number): string {
  const base = new URL(scope.apiBase)
  const path = [...scope.repository.owner.split('/'), scope.repository.repo]
    .map((segment) => encodeURIComponent(segment)).join('/')
  return `${base.origin}/${path}/-/jobs/${jobId}`
}

function projectPath(scope: GitLabScope): string {
  return `/projects/${scope.projectId}`
}

function samePipelineIdentity(left: Pipeline, right: Pipeline): boolean {
  return left.id === right.id && left.projectId === right.projectId
    && sameSha(left.sha, right.sha) && left.ref === right.ref
}

function sameJobIdentity(left: Job, right: Job): boolean {
  return left.id === right.id && left.name === right.name && left.pipelineId === right.pipelineId
    && left.projectId === right.projectId && sameSha(left.sha, right.sha)
    && sameSha(left.commitSha, right.commitSha) && left.ref === right.ref
}

function sameIdentity(left: { host: string; owner: string; repo: string }, right: { host: string; owner: string; repo: string }): boolean {
  return left.host.toLowerCase() === right.host.toLowerCase()
    && left.owner.toLowerCase() === right.owner.toLowerCase()
    && left.repo.toLowerCase() === right.repo.toLowerCase()
}

function sameSha(left: unknown, right: unknown): boolean {
  return typeof left === 'string' && typeof right === 'string' && left.toLowerCase() === right.toLowerCase()
}

function shaValue(value: unknown): string | null {
  return typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu.test(value) ? value : null
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function settingStamp(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function configurationStamp(value: HostingConfiguration): string {
  return JSON.stringify({ issueSourcePreference: value.issueSourcePreference, account: value.account })
}


function schemaDrift(env: HostingEnv): never {
  throw gitlabError(env, 'schema_drift', SCHEMA_DRIFT_MESSAGE)
}

function errorReason(error: unknown): string | null {
  if (!isRecord(error) || !isRecord(error.data) || typeof error.data.reason !== 'string') return null
  return error.data.reason
}

function isHardReadError(error: unknown): boolean {
  const reason = errorReason(error)
  return reason !== null && HARD_READ_REASONS[reason] === true
}

