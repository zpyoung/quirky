import type { Handler, HostingEnv, RunOptions } from './env';
import {
  asArray,
  asRecord,
  detailError,
  errorReason,
  uncertainMutation,
  graphqlHasErrors,
  positiveInteger,
  readNoCache,
  resolveDetailContext,
  shaValue,
  type DetailContext,
  type DetailRecord,
} from './detail-common';

export type CheckRecord = {
  kind: 'check_run' | 'status' | 'approval';
  name: string;
  status: string;
  conclusion: string | null;
  url: string | null;
  checkRunId: number | null;
  workflowRunId: number | null;
  suiteId: number | null;
};

type ChecksResult = {
  number: number;
  headSha: string | null;
  rollup: 'neutral' | 'pending' | 'success' | 'failure' | 'unknown';
  checks: CheckRecord[];
  partial: boolean;
  partialFailures: string[];
};

type CheckDetailResult = {
  check: DetailRecord;
  annotations: DetailRecord[];
  jobs: DetailRecord[];
  logTails: { jobId: number; jobName: string; tail: string }[];
  partialFailures: string[];
  truncated: boolean;
};

type RerunTarget = { kind: 'workflow' | 'check'; id: number };

const CHECKS_QUERY = `query HostingChecksRollup($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      headRefOid
      commits(last: 1) {
        nodes { commit { statusCheckRollup {
          contexts(first: 100) {
            nodes {
              __typename
              ... on CheckRun { databaseId name status conclusion detailsUrl }
              ... on StatusContext { context state targetUrl }
            }
            pageInfo { hasNextPage }
          }
          checkSuites(first: 100) {
            nodes { databaseId conclusion app { name } checkRuns(first: 100) { totalCount } }
            pageInfo { hasNextPage }
          }
        } } }
      }
    }
  }
}`;

export function checkMethods(env: HostingEnv): Record<string, Handler> {
  return {
    checks: async (params, caller) => {
      const context = await resolveDetailContext(env, params, caller);
      const noCache = readNoCache(env, params);
      return noCache
        ? loadChecks(env, context)
        : env.cache(`${context.cachePrefix}:checks`, 60_000, () => loadChecks(env, context));
    },
    checkDetails: async (params, caller) => {
      const context = await resolveDetailContext(env, params, caller);
      const checkRunId = params.checkRunId;
      if (!positiveInteger(checkRunId)) {
        throw env.invalid('invalid_input', 'A positive check run ID is required.');
      }
      const workflowRunId = params.workflowRunId;
      if (workflowRunId !== undefined && !positiveInteger(workflowRunId)) {
        throw env.invalid('invalid_input', 'The workflow run ID must be a positive integer.');
      }
      const jobName = params.jobName;
      if (jobName !== undefined && (typeof jobName !== 'string' || jobName.length === 0 || jobName.length > 200)) {
        throw env.invalid('invalid_input', 'The check job name must be a non-empty string of at most 200 characters.');
      }
      const noCache = readNoCache(env, params);
      const key = `${context.cachePrefix}:check-detail:${checkRunId}:${workflowRunId ?? ''}:${jobName ?? ''}`;
      return noCache
        ? loadCheckDetails(env, context, checkRunId, workflowRunId, jobName)
        : env.cache(key, 60_000, () => loadCheckDetails(env, context, checkRunId, workflowRunId, jobName));
    },
    rerunChecks: async (params, caller) => {
      const context = await resolveDetailContext(env, params, caller);
      const failedOnly = params.failedOnly;
      if (typeof failedOnly !== 'boolean') {
        throw env.invalid('invalid_input', 'failedOnly must be a boolean.');
      }
      return rerunChecks(env, context, failedOnly);
    },
  };
}

async function loadChecks(env: HostingEnv, context: DetailContext): Promise<ChecksResult> {
  const partialFailures: string[] = [];
  try {
    const response = await env.graphql(envScope(context), CHECKS_QUERY, {
      ...graphqlRepoVars(context),
      number: context.number,
    }, { idempotent: true });
    const parsed = parseGraphChecks(response, context.number);
    if (parsed !== null) return parsed;
    partialFailures.push('GraphQL check rollup was unavailable.');
  } catch {
    partialFailures.push('GraphQL check rollup was unavailable.');
  }

  let headSha: string | null = null;
  try {
    const pull = asRecord(await env.rest(envScope(context), `${context.base}/pulls/${context.number}`, 'GET', undefined, { idempotent: true }));
    headSha = shaValue(asRecord(pull?.head)?.sha);
    if (headSha === null) partialFailures.push('Pull request head SHA was unavailable for REST check lookup.');
  } catch {
    partialFailures.push('Pull request head SHA was unavailable for REST check lookup.');
  }

  if (headSha !== null) {
    const base = `repos/${context.identity.owner}/${context.identity.repo}/commits/${headSha}`;
    const paths = [
      `${base}/check-runs?per_page=100`,
      `${base}/status?per_page=100`,
      `${base}/check-suites?per_page=100`,
    ];
    const responses = await Promise.allSettled(paths.map((path) => env.rest(envScope(context), path, 'GET', undefined, { idempotent: true })));
    const records: CheckRecord[] = [];
    const suites: DetailRecord[] = [];
    let successfulSources = 0;
    for (let index = 0; index < responses.length; index += 1) {
      const response = responses[index];
      if (response.status === 'rejected') {
        partialFailures.push(`REST ${['check runs', 'statuses', 'check suites'][index]} were unavailable.`);
        continue;
      }
      const body = asRecord(response.value);
      const key = index === 0 ? 'check_runs' : index === 1 ? 'statuses' : 'check_suites';
      const resource = index === 0 ? 'check runs' : index === 1 ? 'statuses' : 'check suites';
      const rawValues = body?.[key];
      if (body === null || !Array.isArray(rawValues)) {
        partialFailures.push(`REST ${resource} were unavailable.`);
        continue;
      }
      successfulSources += 1;
      const values = asArray(rawValues);
      const total = body.total_count;
      if ((nonnegativeInteger(total) && total > values.length)
        || (values.length >= 100 && !nonnegativeInteger(total))) {
        partialFailures.push(`REST ${resource} were truncated at the 100-entry source limit.`);
      }
      if (index === 0) {
        for (const value of values) {
          const mapped = mapCheckRun(value);
          if (mapped !== null) records.push(mapped);
        }
      } else if (index === 1) {
        for (const value of values) {
          const mapped = mapStatus(value);
          if (mapped !== null) records.push(mapped);
        }
      } else {
        for (const value of values) {
          const suite = asRecord(value);
          if (suite !== null) suites.push(suite);
        }
      }
    }
    if (successfulSources > 0) {
      appendApprovalSuites(records, suites);
      deduplicateStatuses(records);
      return makeChecksResult(context.number, headSha, records, partialFailures);
    }
  }

  try {
    const response = await env.json(envScope(context), [
      'pr', 'checks', String(context.number), '--json', 'name,state,link',
      '--repo', `${context.identity.owner}/${context.identity.repo}`,
    ], { idempotent: true });
    const records = asArray(response).flatMap((value) => {
      const item = asRecord(value);
      const mapped = item === null ? null : mapPorcelainCheck(item);
      return mapped === null ? [] : [mapped];
    });
    return makeChecksResult(context.number, headSha, records, partialFailures);
  } catch (error) {
    if (errorReason(error) === 'no_checks_reported' || errorText(error).includes('no checks reported')) {
      return makeChecksResult(context.number, headSha, [], partialFailures);
    }
    throw detailError(env, 'checks_unavailable', 'Could not load pull request checks.', {
      partialFailures,
    });
  }
}

function parseGraphChecks(value: unknown, number: number): ChecksResult | null {
  if (graphqlHasErrors(value)) return null;
  const data = asRecord(asRecord(value)?.data);
  const repository = asRecord(data?.repository);
  const pull = asRecord(repository?.pullRequest);
  if (pull === null) return null;
  const headSha = shaValue(pull.headRefOid);
  const commits = asRecord(pull.commits);
  const commitNode = asRecord(asArray(commits?.nodes)[0]);
  const commit = asRecord(commitNode?.commit);
  const rollup = asRecord(commit?.statusCheckRollup);
  const contexts = asRecord(rollup?.contexts);
  const checks: CheckRecord[] = [];
  for (const context of asArray(contexts?.nodes)) {
    const item = asRecord(context);
    if (item === null) continue;
    if (item.__typename === 'CheckRun') {
      const mapped = mapCheckRun(item);
      if (mapped !== null) checks.push(mapped);
    } else {
      const mapped = mapStatus(item);
      if (mapped !== null) checks.push(mapped);
    }
  }
  deduplicateStatuses(checks);
  const suiteConnection = asRecord(rollup?.checkSuites);
  appendApprovalSuites(checks, asArray(suiteConnection?.nodes).flatMap((item) => {
    const suite = asRecord(item);
    return suite === null ? [] : [suite];
  }));
  const partialFailures: string[] = [];
  if (asRecord(contexts?.pageInfo)?.hasNextPage === true || asRecord(suiteConnection?.pageInfo)?.hasNextPage === true) {
    partialFailures.push('Check rollup was truncated at the 100-entry source limit.');
  }
  return makeChecksResult(number, headSha, checks, partialFailures);
}

function mapCheckRun(value: unknown): CheckRecord | null {
  const item = asRecord(value);
  if (item === null) return null;
  const name = nonempty(item.name) ?? nonempty(item.context) ?? 'Unnamed check';
  const url = nonempty(item.detailsUrl) ?? nonempty(item.details_url) ?? nonempty(item.html_url) ?? nonempty(item.url);
  const runId = positiveOrNull(item.workflowRunId) ?? positiveOrNull(item.run_id) ?? workflowId(url);
  return {
    kind: 'check_run',
    name,
    status: normalizeStatus(item.status),
    conclusion: normalizeConclusion(item.conclusion),
    url,
    checkRunId: positiveOrNull(item.databaseId) ?? positiveOrNull(item.checkRunId) ?? positiveOrNull(item.id),
    workflowRunId: runId,
    suiteId: positiveOrNull(asRecord(item.check_suite)?.id) ?? positiveOrNull(item.checkSuiteId),
  };
}

function mapStatus(value: unknown): CheckRecord | null {
  const item = asRecord(value);
  if (item === null) return null;
  const name = nonempty(item.context) ?? nonempty(item.name);
  if (name === null) return null;
  const state = normalizeStatus(item.state ?? item.status);
  return {
    kind: 'status',
    name,
    status: state,
    conclusion: state === 'success' || state === 'failure' || state === 'error' ? state : null,
    url: nonempty(item.targetUrl) ?? nonempty(item.target_url) ?? nonempty(item.url),
    checkRunId: null,
    workflowRunId: null,
    suiteId: null,
  };
}

function mapPorcelainCheck(value: DetailRecord): CheckRecord | null {
  const name = nonempty(value.name);
  if (name === null) return null;
  const status = normalizeStatus(value.state);
  return {
    kind: 'status',
    name,
    status,
    conclusion: status === 'success' || status === 'failure' || status === 'error' ? status : null,
    url: nonempty(value.link),
    checkRunId: null,
    workflowRunId: null,
    suiteId: null,
  };
}

function appendApprovalSuites(checks: CheckRecord[], suites: DetailRecord[]): void {
  const knownSuiteIds = new Set(checks.flatMap((check) => check.suiteId === null ? [] : [check.suiteId]));
  for (const suite of suites) {
    const conclusion = normalizeConclusion(suite.conclusion);
    const suiteId = positiveOrNull(suite.databaseId) ?? positiveOrNull(suite.id);
    const count = asRecord(suite.checkRuns)?.totalCount;
    if (conclusion !== 'action_required' || suiteId === null || knownSuiteIds.has(suiteId)) continue;
    if (count !== 0 && count !== undefined) continue;
    const appName = nonempty(asRecord(suite.app)?.name) ?? 'Approval';
    checks.push({
      kind: 'approval',
      name: `${appName} #${suiteId}`,
      status: 'action_required',
      conclusion: 'action_required',
      url: null,
      checkRunId: null,
      workflowRunId: null,
      suiteId,
    });
  }
}

function deduplicateStatuses(checks: CheckRecord[]): void {
  const checkNames = new Set(checks.filter((check) => check.kind === 'check_run').map((check) => check.name.toLowerCase()));
  const seenStatuses = new Set<string>();
  for (let index = checks.length - 1; index >= 0; index -= 1) {
    const check = checks[index];
    if (check.kind !== 'status') continue;
    const key = check.name.toLowerCase();
    if (checkNames.has(key) || seenStatuses.has(key)) checks.splice(index, 1);
    else seenStatuses.add(key);
  }
}

function makeChecksResult(number: number, headSha: string | null, checks: CheckRecord[], partialFailures: string[]): ChecksResult {
  const ordered = [...checks].sort((left, right) => left.name.localeCompare(right.name) || left.kind.localeCompare(right.kind));
  const verdicts = ordered.map(checkVerdict);
  let rollup: ChecksResult['rollup'] = 'neutral';
  if (verdicts.length > 0) {
    if (verdicts.includes('failure')) rollup = 'failure';
    else if (verdicts.includes('pending')) rollup = 'pending';
    else if (verdicts.includes('success')) rollup = 'success';
    else if (verdicts.includes('unknown')) rollup = 'unknown';
  }
  return { number, headSha, rollup, checks: ordered, partial: partialFailures.length > 0, partialFailures };
}

function checkVerdict(check: CheckRecord): 'failure' | 'pending' | 'success' | 'neutral' | 'unknown' {
  const conclusion = check.conclusion;
  if (conclusion !== null && ['failure', 'error', 'startup_failure', 'timed_out', 'cancelled'].includes(conclusion)) return 'failure';
  if (conclusion === 'action_required') return 'pending';
  if (conclusion === 'success' || conclusion === 'skipped') return 'success';
  if (['pending', 'queued', 'in_progress', 'action_required', 'expected', 'requested', 'waiting'].includes(check.status)) return 'pending';
  if (check.status === 'success') return 'success';
  if (check.status === 'failure' || check.status === 'error') return 'failure';
  if (check.status === 'neutral' || check.status === 'completed') return 'neutral';
  return 'unknown';
}

function normalizeStatus(value: unknown): string {
  if (typeof value !== 'string') return 'unknown';
  const status = value.toLowerCase();
  if (['queued', 'in_progress', 'completed', 'pending', 'success', 'failure', 'error', 'expected', 'action_required', 'requested', 'waiting', 'neutral'].includes(status)) return status;
  return 'unknown';
}

function normalizeConclusion(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') return 'unknown';
  const conclusion = value.toLowerCase();
  if (['success', 'failure', 'neutral', 'cancelled', 'skipped', 'timed_out', 'action_required', 'stale', 'startup_failure', 'error'].includes(conclusion)) return conclusion;
  return 'unknown';
}

async function loadCheckDetails(
  env: HostingEnv,
  context: DetailContext,
  checkRunId: number,
  requestedWorkflowRunId: number | undefined,
  requestedJobName: string | undefined,
): Promise<CheckDetailResult> {
  const abort = AbortSignal.timeout(25_000);
  const options: RunOptions = { idempotent: true, timeoutMs: 25_000, maxBytes: 10 * 1024 * 1024, signal: abort };
  const pull = asRecord(await env.rest(envScope(context), `${context.base}/pulls/${context.number}`, 'GET', undefined, options));
  const headSha = shaValue(asRecord(pull?.head)?.sha);
  if (headSha === null) throw env.invalid('unavailable', 'Could not load check details.');

  const check = asRecord(await env.rest(envScope(context), `${context.base}/check-runs/${checkRunId}`, 'GET', undefined, options));
  if (check === null || positiveOrNull(check.id) !== checkRunId) {
    throw env.invalid('not_found', 'Could not load check details.');
  }
  const checkHead = shaValue(check.head_sha);
  if (checkHead !== null && checkHead !== headSha) {
    throw env.invalid('stale_check', 'The check run does not belong to the current pull request head.');
  }
  const runId = positiveOrNull(requestedWorkflowRunId)
    ?? positiveOrNull(check.run_id)
    ?? workflowId(nonempty(check.details_url));
  if (requestedWorkflowRunId !== undefined && runId !== requestedWorkflowRunId) {
    throw env.invalid('invalid_input', 'The workflow run ID does not match the selected check run.');
  }

  const partialFailures: string[] = [];
  let annotationValues: unknown[] = [];
  try {
    const annotations = await env.rest(envScope(context), `${context.base}/check-runs/${checkRunId}/annotations?per_page=20`, 'GET', undefined, options);
    if (Array.isArray(annotations)) annotationValues = annotations;
    else partialFailures.push('Check annotations were unavailable.');
  } catch {
    partialFailures.push('Check annotations were unavailable.');
  }
  const annotations = annotationValues.flatMap((value) => {
    const item = asRecord(value);
    return item === null ? [] : [mapAnnotation(item)];
  });

  let jobs: DetailRecord[] = [];
  if (runId !== null) {
    try {
      const response = asRecord(await env.rest(envScope(context), `${context.base}/actions/runs/${runId}/jobs?per_page=100`, 'GET', undefined, options));
      const values = asArray(response?.jobs);
      jobs = values.flatMap((value) => {
        const item = asRecord(value);
        if (item === null || !positiveInteger(item.id) || nonempty(item.name) === null) return [];
        return [mapJob(item)];
      });
      if (requestedJobName !== undefined) {
        jobs = jobs.filter((job) => job.name === requestedJobName);
      } else {
        const candidateName = nonempty(check.name);
        if (candidateName !== null) {
          const matching = jobs.filter((job) => job.name === candidateName);
          if (matching.length > 0) jobs = matching;
        }
      }
    } catch {
      partialFailures.push('Check jobs were unavailable.');
    }
  } else {
    partialFailures.push('The workflow run ID for this check was unavailable.');
  }

  const logTails: CheckDetailResult['logTails'] = [];
  const failedJobs = jobs.filter((job) => job.conclusion === 'failure'
    || job.conclusion === 'cancelled'
    || job.conclusion === 'timed_out');
  let logsTruncated = failedJobs.length > 5;
  for (const job of failedJobs.slice(0, 5)) {
    const jobId = job.id;
    const jobName = job.name;
    if (!positiveInteger(jobId) || typeof jobName !== 'string') continue;
    try {
      let log: string;
      try {
        log = await env.run(envScope(context), [
          'api', `${context.base}/actions/jobs/${jobId}/logs`, '--allow-escape-sequences',
        ], { idempotent: true, timeoutMs: 25_000, maxBytes: 64 * 1024 * 1024, signal: abort });
      } catch (error) {
        if (!errorText(error).toLowerCase().includes('unknown flag')) throw error;
        log = await env.run(envScope(context), [
          'api', `${context.base}/actions/jobs/${jobId}/logs`,
        ], { idempotent: true, timeoutMs: 25_000, maxBytes: 64 * 1024 * 1024, signal: abort });
      }
      const tail = sliceLogTail(log);
      logsTruncated ||= tail.truncated;
      logTails.push({ jobId, jobName, tail: tail.text });
    } catch {
      partialFailures.push(`The failed log for job ${jobId} was unavailable.`);
    }
  }

  return {
    check: mapCheckDetail(check),
    annotations,
    jobs,
    logTails,
    partialFailures,
    truncated: logsTruncated,
  };
}

function mapAnnotation(value: DetailRecord): DetailRecord {
  return {
    path: nonempty(value.path),
    startLine: positiveOrNull(value.start_line),
    endLine: positiveOrNull(value.end_line),
    level: nonempty(value.annotation_level) ?? 'unknown',
    message: nonempty(value.message) ?? '',
    title: nonempty(value.title),
    rawDetails: nonempty(value.raw_details),
  };
}

function mapJob(value: DetailRecord): DetailRecord {
  return {
    id: value.id,
    name: value.name,
    status: normalizeStatus(value.status),
    conclusion: normalizeConclusion(value.conclusion),
    startedAt: nonempty(value.started_at),
    completedAt: nonempty(value.completed_at),
    htmlUrl: nonempty(value.html_url),
    checkRunUrl: nonempty(value.check_run_url),
  };
}

function mapCheckDetail(value: DetailRecord): DetailRecord {
  return {
    id: value.id,
    name: nonempty(value.name) ?? 'Unnamed check',
    status: normalizeStatus(value.status),
    conclusion: normalizeConclusion(value.conclusion),
    headSha: shaValue(value.head_sha),
    detailsUrl: nonempty(value.details_url),
    workflowRunId: positiveOrNull(value.run_id),
  };
}

function sliceLogTail(value: string): { text: string; truncated: boolean } {
  const clean = value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\r/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/(gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, '[REDACTED]');
  const lines = clean.split('\n');
  const tailStart = Math.max(0, lines.length - 100);
  const earlier = new Set<number>();
  for (let index = 0; index < tailStart; index += 1) {
    if (!/(?:##\[error\]|::error|error:|FAILED|exit code|ENOENT|EACCES|panic:|AssertionError)/i.test(lines[index])) continue;
    for (let context = Math.max(0, index - 2); context <= Math.min(tailStart - 1, index + 2); context += 1) earlier.add(context);
  }
  const earlierLines = [...earlier].sort((left, right) => left - right).slice(-30).map((index) => lines[index]);
  const sections: string[] = [];
  if (earlierLines.length > 0) sections.push('… earlier errors …', ...earlierLines);
  sections.push(...lines.slice(tailStart));
  let result = sections.join('\n');
  const encoder = new TextEncoder();
  let truncated = tailStart > 0;
  while (encoder.encode(result).byteLength > 16 * 1024) {
    truncated = true;
    const linesToTrim = result.split('\n');
    if (linesToTrim.length <= 1) {
      const bytes = encoder.encode(result);
      let start = Math.max(0, bytes.byteLength - 16 * 1024);
      while (start < bytes.byteLength && (bytes[start] & 0xc0) === 0x80) start += 1;
      result = new TextDecoder().decode(bytes.subarray(start));
      break;
    }
    const markerIndex = linesToTrim.indexOf('… earlier errors …');
    if (markerIndex >= 0 && markerIndex < linesToTrim.length - 100) {
      linesToTrim.splice(markerIndex, 2);
    } else {
      linesToTrim.shift();
    }
    result = linesToTrim.join('\n');
  }
  return { text: result, truncated };
}
async function rerunChecks(env: HostingEnv, context: DetailContext, failedOnly: boolean): Promise<unknown> {
  const checks = await loadChecks(env, context);
  if (checks.partialFailures.some((failure) => failure.toLowerCase().includes('truncated'))) {
    throw env.invalid('checks_incomplete', 'The check list is incomplete; refresh before rerunning checks.');
  }
  const selected = checks.checks.filter((check) => !failedOnly || isFailed(check));
  const targets = new Map<string, RerunTarget>();
  for (const check of selected) {
    if (check.kind !== 'check_run') continue;
    if (check.workflowRunId !== null) targets.set(`workflow:${check.workflowRunId}`, { kind: 'workflow', id: check.workflowRunId });
    else if (check.checkRunId !== null) targets.set(`check:${check.checkRunId}`, { kind: 'check', id: check.checkRunId });
  }
  if (targets.size === 0) {
    if (selected.some((check) => check.kind === 'status')) {
      throw env.invalid('legacy_status_only', 'Legacy commit statuses have no rerunnable check or workflow ID; rerun the originating workflow instead.');
    }
    throw env.invalid(failedOnly ? 'no_failed_checks' : 'no_rerunnable_checks', failedOnly
      ? 'No failed GitHub Actions checks to rerun.'
      : 'No rerunnable checks found.');
  }

  const targetList = [...targets.values()];
  let started = 0;
  const completedSteps: string[] = [];
  for (const target of targetList) {
    const path = target.kind === 'workflow'
      ? `${context.base}/actions/runs/${target.id}/${failedOnly ? 'rerun-failed-jobs' : 'rerun'}`
      : `${context.base}/check-runs/${target.id}/rerequest`;
    try {
      await env.rest(envScope(context), path, 'POST', undefined, { idempotent: false, timeoutMs: 30_000 });
      started += 1;
      completedSteps.push(`${target.kind}:${target.id}`);
      env.changed(context.scope, { number: context.number, operation: 'rerunChecks', completedSteps: [...completedSteps] });
    } catch (error) {
      if (started > 0) {
        env.changed(context.scope, { number: context.number, operation: 'rerunChecks', partial: true, completedSteps: [...completedSteps] });
        throw detailError(env, 'partial_failure', `Rerun failed after ${started} rerun${started === 1 ? '' : 's'} already started.`, {
          partial: true,
          startedCount: started,
          completedSteps,
        });
      }
      if (uncertainMutation(error)) {
        env.changed(context.scope, { number: context.number, operation: 'rerunChecks', uncertain: true });
      }
      throw env.invalid('rerun_failed', 'Could not start the requested check rerun.');
    }
  }
  return { started, targetCount: targetList.length, completedSteps };
}

function isFailed(check: CheckRecord): boolean {
  return check.conclusion === 'failure'
    || check.conclusion === 'cancelled'
    || check.conclusion === 'timed_out'
    || check.conclusion === 'startup_failure'
    || check.status === 'failure'
    || check.status === 'error';
}


function positiveOrNull(value: unknown): number | null {
  if (positiveInteger(value)) return value;
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) {
    const parsed = Number(value);
    return positiveInteger(parsed) ? parsed : null;
  }
  return null;
}

function workflowId(value: string | null): number | null {
  if (value === null) return null;
  const match = value.match(/\/actions\/runs\/(\d+)(?:\/|$)/i);
  return match === null ? null : positiveOrNull(match[1]);
}


function nonempty(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function errorText(error: unknown): string {
  const record = asRecord(error);
  return typeof record?.message === 'string' ? record.message.toLowerCase() : '';
}

function envScope(context: DetailContext) {
  return context.scope;
}

function graphqlRepoVars(context: DetailContext): { owner: string; name: string } {
  return { owner: context.identity.owner, name: context.identity.repo };
}
