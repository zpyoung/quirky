import { describe, expect, test } from 'bun:test';
import { bootHosting, type HostingTest } from './helpers';

const fixtureGh = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const stateFile = path.join(process.env.QUIRKY_TEST_FIXTURE_DIR, 'state.json');
let state = {};
try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
if (!state.counts) state.counts = {};
function persist() { fs.writeFileSync(stateFile, JSON.stringify(state)); }
function respond(value) {
  if (typeof value === 'string') process.stdout.write(value);
  else process.stdout.write(JSON.stringify(value));
}
function take(key, value) {
  const index = Number(state.counts[key] || 0);
  state.counts[key] = index + 1;
  persist();
  if (value && typeof value === 'object' && Array.isArray(value.__sequence)) {
    const sequence = value.__sequence;
    return sequence[Math.min(index, sequence.length - 1)];
  }
  return value;
}
function fail(key) {
  const failure = state.failures && state.failures[key];
  if (!failure) return false;
  process.stderr.write(String(failure));
  process.exitCode = 1;
  return true;
}
function applyTransition(key) {
  const configured = state.transitions && state.transitions[key];
  const transitionIndexKey = 'transition ' + key;
  const transitionIndex = Number(state.counts[transitionIndexKey] || 0);
  let transition = configured;
  if (Array.isArray(configured)) {
    state.counts[transitionIndexKey] = transitionIndex + 1;
    transition = configured[Math.min(transitionIndex, configured.length - 1)];
  }
  if (!transition || typeof transition !== 'object') return;
  if (transition.responses && typeof transition.responses === 'object') {
    state.responses = Object.assign(state.responses || {}, transition.responses);
  }
  if (transition.graphqlResponses && typeof transition.graphqlResponses === 'object') {
    state.graphqlResponses = Object.assign(state.graphqlResponses || {}, transition.graphqlResponses);
  }
  persist();
}
if (args[0] === 'auth' && args[1] === 'status') {
  respond('Logged in to github.com account fixture-user (keyring)\nActive account: true\n');
} else if (args[0] === 'auth' && args[1] === 'token') {
  respond('fixture-token\n');
} else if (args[0] === 'pr' && args[1] === 'checks') {
  const key = 'porcelain';
  if (!fail(key)) respond(take(key, state.porcelainChecks || []));
} else if (args[0] === 'api' && args[1] === 'graphql') {
  let request = {};
  try { request = JSON.parse(process.env.QUIRKY_TEST_GH_INPUT || '{}'); } catch {}
  let query = typeof request.query === 'string' ? request.query : '';
  if (!query) {
    const queryArg = args.find((arg) => arg.startsWith('query='));
    if (queryArg) query = queryArg.slice('query='.length);
  }
  const operation = (query.match(/(?:query|mutation)\s+([A-Za-z_][A-Za-z0-9_]*)/) || [])[1] || 'anonymous';
  const key = 'graphql ' + operation;
  if (!fail(key)) {
    const configured = (state.graphqlResponses || {})[operation];
    const result = configured === undefined ? { data: { repository: { pullRequest: null }, node: null } } : take(key, configured);
    respond(result);
    if (/^\s*mutation\b/.test(query)) applyTransition('GRAPHQL ' + operation);
  }
} else if (args[0] === 'api') {
  const route = args.find((arg) => arg.startsWith('repos/') || arg === 'rate_limit' || arg === 'user') || '';
  const verbIndex = args.findIndex((arg) => arg === '-X' || arg === '--method');
  const method = verbIndex >= 0 ? String(args[verbIndex + 1] || 'GET').toUpperCase() : 'GET';
  const key = method + ' ' + route;
  const routeKey = method + ' ' + route.split('?')[0];
  const raw = (state.rawContents || []).find((entry) => route.includes(entry.match));
  const responseTable = state.responses || {};
  const response = Object.prototype.hasOwnProperty.call(responseTable, key)
    ? responseTable[key]
    : responseTable[routeKey];
  if (!fail(key) && !fail(routeKey)) {
    if (raw) {
      const value = raw.value === '__LARGE__' ? 'x'.repeat(8 * 1024 * 1024 + 1) : raw.value;
      respond(value);
    } else if (Object.prototype.hasOwnProperty.call(responseTable, key)) {
      respond(take(key, response));
    } else if (Object.prototype.hasOwnProperty.call(responseTable, routeKey)) {
      respond(take(routeKey, response));
    } else if (route.endsWith('/rate_limit') || route === 'rate_limit') {
      respond({ resources: { core: { limit: 5000, remaining: 5000, reset: 2000000000 }, search: { limit: 30, remaining: 30, reset: 2000000000 }, graphql: { limit: 5000, remaining: 5000, reset: 2000000000 } } });
    } else {
      respond(null);
    }
    if (method === 'POST') applyTransition(key);
  }
} else {
  respond(null);
}
`;

type TestAction = (host: HostingTest) => Promise<void>;

async function withHosting(state: unknown, action: TestAction): Promise<void> {
  const host = await bootHosting(fixtureGh);
  try {
    host.writeState(state);
    await action(host);
  } finally {
    await host.cleanup();
  }
}


function invocations(host: HostingTest): string[] {
  return host.invocations().map((entry) => entry.args.join(' '));
}

function graphRollup(contexts: unknown[], suites: unknown[] = [], headSha = 'a'.repeat(40)): unknown {
  return {
    data: {
      repository: {
        pullRequest: {
          headRefOid: headSha,
          commits: {
            nodes: [{
              commit: {
                statusCheckRollup: {
                  contexts: { nodes: contexts },
                  checkSuites: { nodes: suites },
                },
              },
            }],
          },
        },
      },
    },
  };
}

function checkRun(id: number, name: string, conclusion: string, workflowRunId?: number): unknown {
  const url = workflowRunId === undefined
    ? 'https://github.com/test-owner/test-repo/checks/check-' + id
    : 'https://github.com/test-owner/test-repo/actions/runs/' + workflowRunId;
  return {
    __typename: 'CheckRun',
    databaseId: id,
    name,
    status: 'COMPLETED',
    conclusion,
    detailsUrl: url,
    checkRunId: id,
    workflowRunId: workflowRunId ?? null,
  };
}

function changedFilesPage(page: number, count: number): unknown[] {
  return Array.from({ length: count }, (_, index) => {
    const fileNumber = (page - 1) * 100 + index;
    return {
      filename: 'src/file-' + fileNumber + '.ts',
      status: 'modified',
      additions: 1,
      deletions: 1,
      changes: 2,
      patch: fileNumber === 0 ? '@@ -4,1 +4,2 @@\n-old\n+new\n+second' : undefined,
    };
  });
}

describe('hosting detail API', () => {
  test('rolls up check runs, legacy statuses and approval suites without conflating them', async () => {
    const response = graphRollup(
      [
        checkRun(10, 'build', 'SUCCESS', 41),
        { __typename: 'StatusContext', context: 'lint', state: 'PENDING', targetUrl: 'https://checks.test/lint' },
        { __typename: 'StatusContext', context: 'build', state: 'FAILURE', targetUrl: 'https://checks.test/duplicate' },
      ],
      [{ databaseId: 7, conclusion: 'ACTION_REQUIRED', app: { name: 'Review approval' }, checkRuns: { totalCount: 0 } }],
    );
    await withHosting({ graphqlResponses: { HostingChecksRollup: response } }, async (host) => {
      const result = await host.call('checks', { number: 1 });
      expect(result).toMatchObject({
        rollup: 'pending',
        headSha: 'a'.repeat(40),
        checks: expect.arrayContaining([
          { kind: 'check_run' },
          { kind: 'status' },
          { kind: 'approval', name: 'Review approval #7' },
        ]),
        partial: false,
      });
      expect(result).toHaveProperty('checks.length', 3);
    });
  });

  test('combines REST checks and falls back to porcelain without treating empty checks as failure', async () => {
    const sha = 'a'.repeat(40);
    await withHosting({
      failures: { 'graphql HostingChecksRollup': 'GraphQL unavailable' },
      responses: {
        'GET repos/test-owner/test-repo/pulls/1': { head: { sha } },
        ['GET repos/test-owner/test-repo/commits/' + sha + '/check-runs?per_page=100']: {
          check_runs: [{ id: 10, name: 'build', status: 'completed', conclusion: 'success', details_url: 'https://github.com/test-owner/test-repo/actions/runs/41', check_suite: { id: 3 } }],
        },
        ['GET repos/test-owner/test-repo/commits/' + sha + '/status?per_page=100']: {
          statuses: [{ context: 'legacy', state: 'error', target_url: 'https://checks.test/legacy' }],
        },
        ['GET repos/test-owner/test-repo/commits/' + sha + '/check-suites?per_page=100']: {
          check_suites: [{ databaseId: 7, conclusion: 'action_required', app: { name: 'Review approval' }, checkRuns: { totalCount: 0 } }],
        },
      },
    }, async (host) => {
      const result = await host.call('checks', { number: 1 });
      expect(result).toMatchObject({
        rollup: 'failure',
        partial: true,
        checks: expect.arrayContaining([
          expect.objectContaining({ kind: 'check_run', workflowRunId: 41 }),
          expect.objectContaining({ kind: 'status', name: 'legacy' }),
          expect.objectContaining({ kind: 'approval', suiteId: 7 }),
        ]),
      });
      expect(result).toHaveProperty('checks.length', 3);
    });

    await withHosting({
      failures: {
        'graphql HostingChecksRollup': 'GraphQL unavailable',
        'GET repos/test-owner/test-repo/commits/' + sha + '/check-runs?per_page=100': 'REST unavailable',
        'GET repos/test-owner/test-repo/commits/' + sha + '/status?per_page=100': 'REST unavailable',
        'GET repos/test-owner/test-repo/commits/' + sha + '/check-suites?per_page=100': 'REST unavailable',
      },
      responses: { 'GET repos/test-owner/test-repo/pulls/1': { head: { sha } } },
      porcelainChecks: [],
    }, async (host) => {
      const result = await host.call('checks', { number: 1 });
      expect(result).toMatchObject({ rollup: 'neutral', checks: [], partial: true });
      expect(invocations(host).some((args) => args.includes('pr checks'))).toBe(true);
    });

    await withHosting({
      graphqlResponses: { HostingChecksRollup: graphRollup([{ __typename: 'UnknownContext', name: 'opaque', state: 'UNKNOWN' }]) },
    }, async (host) => {
      const result = await host.call('checks', { number: 1 });
      expect(result).toHaveProperty('rollup', 'unknown');
    });
  });

  test('loads annotations and matching jobs with at most five bounded failed log tails', async () => {
    const failedJobs = Array.from({ length: 6 }, (_, index) => ({
      id: 200 + index,
      name: 'unit-' + index,
      conclusion: 'failure',
      status: 'completed',
      completed_at: '2026-10-27T00:00:00Z',
    }));
    const logs = Array.from({ length: 180 }, (_, index) => 'line ' + index).join('\n') + '\n::error file=x.ts,line=1::failed';
    await withHosting({
      responses: {
        'GET repos/test-owner/test-repo/pulls/1': { head: { sha: 'a'.repeat(40) } },
        'GET repos/test-owner/test-repo/check-runs/101': { id: 101, name: 'test', run_id: 41, status: 'completed', conclusion: 'failure', head_sha: 'a'.repeat(40) },
        'GET repos/test-owner/test-repo/check-runs/101/annotations?per_page=20': [{ path: 'src/a.ts', start_line: 5, end_line: 5, annotation_level: 'failure', message: 'failed' }],
        'GET repos/test-owner/test-repo/actions/runs/41/jobs?per_page=100': { total_count: 6, jobs: failedJobs },
      },
      rawContents: failedJobs.map((job) => ({ match: '/actions/jobs/' + String(job.id) + '/logs', value: logs })),
    }, async (host) => {
      const result = await host.call('checkDetails', { number: 1, checkRunId: 101, workflowRunId: 41 });
      expect(result).toMatchObject({
        annotations: expect.arrayContaining([expect.any(Object)]),
        jobs: expect.arrayContaining([expect.any(Object)]),
        logTails: Array.from({ length: 5 }, () => expect.objectContaining({
          tail: expect.stringMatching(/^[\s\S]{0,16384}$/),
        })),
      });
      expect(result).toHaveProperty('annotations.length', 1);
      expect(result).toHaveProperty('jobs.length', 6);
      expect(result).toHaveProperty('logTails.length', 5);
      expect(invocations(host).filter((args) => args.includes('/actions/jobs/')).length).toBe(5);
    });
  });

  test('groups failed reruns and reports confirmed partial starts while invalidating checks', async () => {
    const initial = graphRollup([
      checkRun(10, 'build-linux', 'FAILURE', 41),
      checkRun(11, 'build-macos', 'TIMED_OUT', 41),
      checkRun(12, 'lint', 'FAILURE'),
    ]);
    const refreshed = graphRollup([checkRun(10, 'build-linux', 'SUCCESS', 41)]);
    const failureKey = 'POST repos/test-owner/test-repo/check-runs/12/rerequest';
    await withHosting({
      graphqlResponses: { HostingChecksRollup: initial },
      transitions: {
        'POST repos/test-owner/test-repo/actions/runs/41/rerun-failed-jobs': {
          graphqlResponses: { HostingChecksRollup: refreshed },
        },
      },
      failures: { [failureKey]: 'fixture refused second rerun' },
    }, async (host) => {
      const first = await host.call('checks', { number: 1 });
      expect(first).toHaveProperty('rollup', 'failure');
      const error = await host.call('rerunChecks', { number: 1, failedOnly: true }).then(() => null, (caught: unknown) => caught);
      expect(error).not.toBeNull();
      expect(error).toMatchObject({
        data: {
          startedCount: 1,
          completedSteps: expect.arrayContaining([expect.any(String)]),
        },
      });
      expect(error).toHaveProperty('data.completedSteps.length', 1);
      const calls = invocations(host);
      expect(calls.filter((args) => args.includes('/actions/runs/41/rerun-failed-jobs'))).toHaveLength(1);
      expect(calls.filter((args) => args.includes('/check-runs/12/rerequest'))).toHaveLength(1);
      const after = await host.call('checks', { number: 1 });
      expect(after).toHaveProperty('rollup', 'success');
    });
  });

  test('reruns all check runs with the all-runs action and deduplicates workflow targets', async () => {
    const initial = graphRollup([
      checkRun(20, 'build-linux', 'SUCCESS', 51),
      checkRun(21, 'build-macos', 'FAILURE', 51),
      checkRun(22, 'legacy-workflow', 'SUCCESS'),
    ]);
    const refreshed = graphRollup([
      checkRun(20, 'build-linux', 'SUCCESS', 51),
      checkRun(21, 'build-macos', 'SUCCESS', 51),
      checkRun(22, 'legacy-workflow', 'SUCCESS'),
    ]);
    await withHosting({
      graphqlResponses: { HostingChecksRollup: initial },
      transitions: {
        'POST repos/test-owner/test-repo/actions/runs/51/rerun': {
          graphqlResponses: { HostingChecksRollup: refreshed },
        },
        'POST repos/test-owner/test-repo/check-runs/22/rerequest': {
          graphqlResponses: { HostingChecksRollup: refreshed },
        },
      },
    }, async (host) => {
      const result = await host.call('rerunChecks', { number: 1, failedOnly: false });
      expect(result).toMatchObject({ started: 2, targetCount: 2 });
      const calls = invocations(host);
      expect(calls.filter((args) => args.includes('/actions/runs/51/rerun'))).toHaveLength(1);
      expect(calls.filter((args) => args.includes('/check-runs/22/rerequest'))).toHaveLength(1);
      expect(calls.some((args) => args.includes('rerun-failed-jobs'))).toBe(false);
      const after = await host.call('checks', { number: 1 });
      expect(after).toHaveProperty('rollup', 'success');
    });
  });

  test('rejects failed legacy statuses as non-rerunnable instead of silently succeeding', async () => {
    await withHosting({
      graphqlResponses: {
        HostingChecksRollup: graphRollup([{ __typename: 'StatusContext', context: 'legacy-ci', state: 'FAILURE' }]),
      },
    }, async (host) => {
      const error = await host.call('rerunChecks', { number: 1, failedOnly: true }).then(() => null, (caught: unknown) => caught);
      expect(error).not.toBeNull();
      expect(error).toMatchObject({ data: { reason: 'legacy_status_only' } });
      expect(error instanceof Error ? error.message : String(error)).toMatch(/status|workflow/i);
      expect(invocations(host).some((args) => args.includes(' -X POST '))).toBe(false);
    });
  });

  test('returns sorted typed conversation, reviews and threads with source-specific partial failures', async () => {
    const graph = {
      data: {
        repository: {
          pullRequest: {
            id: 'PR_NODE',
            reviewThreads: {
              nodes: [{
                id: 'THREAD_NODE',
                isResolved: true,
                path: 'src/a.ts',
                line: null,
                originalLine: 8,
                startLine: null,
                originalStartLine: 7,
                comments: { nodes: [{ id: 'THREAD_COMMENT', databaseId: 30, body: 'thread note', createdAt: '2026-10-27T03:00:00Z', author: { login: 'reviewer' }, url: 'https://github.com/test-owner/test-repo/pull/1#discussion_r30', reactions: { nodes: [{ content: 'THUMBS_UP', user: { login: 'me' } }] } }] },
              }],
            },
            comments: { nodes: [{ id: 'ISSUE_COMMENT', databaseId: 20, body: 'conversation', createdAt: '2026-10-27T01:00:00Z', author: { login: 'author' }, url: 'https://github.com/test-owner/test-repo/pull/1#issuecomment-20', reactions: { nodes: [] } }] },
            reviews: { nodes: [{ id: 'REVIEW_NODE', databaseId: 40, body: 'Looks good', submittedAt: '2026-10-27T02:00:00Z', author: { login: 'reviewer' }, state: 'APPROVED' }] },
          },
        },
      },
    };
    await withHosting({
      graphqlResponses: { HostingComments: graph },
      responses: {
        'GET repos/test-owner/test-repo/issues/1/comments?per_page=100': [],
        'GET repos/test-owner/test-repo/pulls/1/reviews?per_page=100': [{ id: 40, body: 'Looks good', state: 'APPROVED', submitted_at: '2026-10-27T02:00:00Z', user: { login: 'reviewer' } }],
      },
      failures: { 'GET repos/test-owner/test-repo/issues/1/comments?per_page=100': 'conversation source unavailable' },
    }, async (host) => {
      const result = await host.call('comments', { number: 1 });
      expect(result).toMatchObject({
        partial: true,
        partialFailures: expect.arrayContaining([expect.any(String)]),
        comments: [
          expect.objectContaining({ kind: 'issue_comment', createdAt: '2026-10-27T01:00:00Z' }),
          expect.objectContaining({ kind: 'review', createdAt: '2026-10-27T02:00:00Z' }),
          expect.objectContaining({
            kind: 'review_comment',
            createdAt: '2026-10-27T03:00:00Z',
            threadId: 'THREAD_NODE',
            isResolved: true,
            isOutdated: true,
            line: 8,
            startLine: 7,
          }),
        ],
      });
    });
  });

  test('guards inline and range comments by current head, changed file and patch coordinates', async () => {
    const pull = { number: 1, node_id: 'REST_PR', head: { sha: 'a'.repeat(40) }, base: { sha: 'b'.repeat(40) } };
    const files = [{ filename: 'src/a.ts', status: 'modified', additions: 2, deletions: 1, changes: 3, patch: '@@ -4,1 +4,2 @@\n context\n-old\n+new\n+second' }];
    const commentsAfter = {
      data: { repository: { pullRequest: {
        comments: { nodes: [{ id: 'INLINE_NODE', databaseId: 501, body: 'range note', createdAt: '2026-10-27T04:00:00Z', author: { login: 'fixture-user' } }], pageInfo: { hasNextPage: false } },
        reviews: { nodes: [], pageInfo: { hasNextPage: false } },
        reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } },
      } } },
    };
    await withHosting({
      responses: {
        'GET repos/test-owner/test-repo/pulls/1': pull,
        'GET repos/test-owner/test-repo/pulls/1/files?per_page=100&page=1': files,
        'GET repos/test-owner/test-repo/issues/1/comments?per_page=100': [],
        'GET repos/test-owner/test-repo/pulls/1/reviews?per_page=100': [],
        'POST repos/test-owner/test-repo/pulls/1/comments': { id: 501, body: 'range note', path: 'src/a.ts', line: 5, start_line: 4 },
      },
      transitions: {
        'POST repos/test-owner/test-repo/pulls/1/comments': {
          graphqlResponses: { HostingComments: commentsAfter },
        },
      },
    }, async (host) => {
      const mismatch = await host.call('reviewComment', { number: 1, action: 'inline', body: 'stale', headSha: 'c'.repeat(40), path: 'src/a.ts', line: 5 }).then(() => null, (caught: unknown) => caught);
      expect(mismatch).not.toBeNull();
      const invalidCoordinate = await host.call('reviewComment', { number: 1, action: 'inline', body: 'outside diff', headSha: 'a'.repeat(40), path: 'src/a.ts', line: 99 }).then(() => null, (caught: unknown) => caught);
      expect(invalidCoordinate).not.toBeNull();
      const valid = await host.call('reviewComment', { number: 1, action: 'inline', body: 'range note', headSha: 'a'.repeat(40), path: 'src/a.ts', startLine: 4, line: 5 });
      expect(valid).toMatchObject({ action: 'inline', comment: { id: 501 } });
      const comments = await host.call('comments', { number: 1 });
      expect(comments).toMatchObject({
        comments: [expect.objectContaining({ kind: 'issue_comment', body: 'range note' })],
      });
      const posts = invocations(host).filter((args) => args.includes('pulls/1/comments'));
      expect(posts.filter((args) => args.includes('-X POST'))).toHaveLength(1);
      const input = host.invocations().find((entry) => entry.args.join(' ').includes('-X POST') && entry.args.join(' ').includes('pulls/1/comments'))?.input;
      expect(input).toContain('commit_id');
      expect(input).toContain('start_line');
    });
  });

  test('validates reply targets and reads the persisted reply from the selected PR', async () => {
    const commentsAfter = {
      data: { repository: { pullRequest: {
        comments: { nodes: [], pageInfo: { hasNextPage: false } },
        reviews: { nodes: [], pageInfo: { hasNextPage: false } },
        reviewThreads: { nodes: [{
          id: 'THREAD_NODE',
          isResolved: false,
          path: 'src/a.ts',
          line: 5,
          comments: {
            nodes: [{ id: 'REPLY_NODE', databaseId: 501, body: 'reply', createdAt: '2026-10-27T05:00:00Z', path: 'src/a.ts', line: 5, author: { login: 'fixture-user' } }],
            pageInfo: { hasNextPage: false },
          },
        }], pageInfo: { hasNextPage: false } },
      } } },
    };
    await withHosting({
      responses: {
        'GET repos/test-owner/test-repo/pulls/comments/99': { id: 99, pull_request_url: 'https://api.github.com/repos/test-owner/test-repo/pulls/1' },
        'POST repos/test-owner/test-repo/pulls/1/comments/99/replies': { id: 501, body: 'reply', in_reply_to_id: 99 },
        'GET repos/test-owner/test-repo/issues/1/comments?per_page=100': [],
        'GET repos/test-owner/test-repo/pulls/1/reviews?per_page=100': [],
      },
      transitions: {
        'POST repos/test-owner/test-repo/pulls/1/comments/99/replies': {
          graphqlResponses: { HostingComments: commentsAfter },
        },
      },
    }, async (host) => {
      const result = await host.call('reviewComment', { number: 1, action: 'reply', body: 'reply', replyToId: 99 });
      expect(result).toMatchObject({ action: 'reply', comment: { id: 501 } });
      const comments = await host.call('comments', { number: 1 });
      expect(comments).toMatchObject({
        comments: [expect.objectContaining({ kind: 'review_comment', body: 'reply', threadId: 'THREAD_NODE' })],
      });
      const invalid = await host.call('reviewComment', { number: 1, action: 'reply', body: 'wrong PR', replyToId: 100 }).then(() => null, (caught: unknown) => caught);
      expect(invalid).not.toBeNull();
      expect(invocations(host).filter((args) => args.includes('-X POST'))).toHaveLength(1);
    });
  });

  test('validates reaction and thread IDs and reads add/remove and resolve/unresolve transitions', async () => {
    const ownedTarget = { data: {
      repository: { pullRequest: { id: 'PR_NODE' } },
      node: { __typename: 'IssueComment', issue: { __typename: 'PullRequest', id: 'PR_NODE', number: 1 } },
    } };
    const commentsState = (reactionGroups: unknown[], isResolved: boolean) => ({
      data: { repository: { pullRequest: {
        comments: { nodes: [{
          id: 'SUBJECT_NODE',
          databaseId: 70,
          body: 'conversation',
          createdAt: '2026-10-27T01:00:00Z',
          author: { login: 'fixture-user' },
          reactionGroups,
        }], pageInfo: { hasNextPage: false } },
        reviews: { nodes: [], pageInfo: { hasNextPage: false } },
        reviewThreads: { nodes: [{
          id: 'THREAD_NODE',
          isResolved,
          path: 'src/a.ts',
          line: 5,
          comments: {
            nodes: [{
              id: 'THREAD_COMMENT',
              databaseId: 71,
              body: 'inline note',
              createdAt: '2026-10-27T02:00:00Z',
              path: 'src/a.ts',
              line: 5,
              author: { login: 'reviewer' },
              reactionGroups: [],
            }],
            pageInfo: { hasNextPage: false },
          },
        }], pageInfo: { hasNextPage: false } },
      } } },
    });
    const noReaction = commentsState([], false);
    await withHosting({
      responses: {
        'GET repos/test-owner/test-repo/issues/1/comments?per_page=100': [],
        'GET repos/test-owner/test-repo/pulls/1/reviews?per_page=100': [],
      },
      graphqlResponses: {
        HostingReactionTarget: { __sequence: [
          ownedTarget,
          ownedTarget,
          { data: {
            repository: { pullRequest: { id: 'PR_NODE' } },
            node: { __typename: 'IssueComment', issue: { __typename: 'PullRequest', id: 'OTHER_PR', number: 2 } },
          } },
        ] },
        HostingReactionMutation: { __sequence: [
          { data: { addReaction: { subject: { id: 'SUBJECT_NODE' }, reaction: { content: 'THUMBS_UP' } } } },
          { data: { removeReaction: { subject: { id: 'SUBJECT_NODE' }, reaction: { content: 'HEART' } } } },
        ] },
        HostingThreadTarget: { data: { repository: { pullRequest: { id: 'PR_NODE', reviewThreads: { nodes: [{ id: 'THREAD_NODE' }] } } } } },
        HostingThreadMutation: { __sequence: [
          { data: { resolveReviewThread: { thread: { id: 'THREAD_NODE', isResolved: true } } } },
          { data: { unresolveReviewThread: { thread: { id: 'THREAD_NODE', isResolved: false } } } },
        ] },
      },
      transitions: {
        'GRAPHQL HostingReactionMutation': [
          { graphqlResponses: { HostingComments: commentsState([{ content: 'THUMBS_UP', users: { totalCount: 1, viewerHasReacted: true } }], false) } },
          { graphqlResponses: { HostingComments: noReaction } },
        ],
        'GRAPHQL HostingThreadMutation': [
          { graphqlResponses: { HostingComments: commentsState([], true) } },
          { graphqlResponses: { HostingComments: noReaction } },
        ],
      },
    }, async (host) => {
      const reaction = await host.call('reaction', { number: 1, subjectId: 'SUBJECT_NODE', action: 'add', content: '+1' });
      expect(reaction).toMatchObject({ changed: true, subjectId: 'SUBJECT_NODE', action: 'add' });
      const afterAdd = await host.call('comments', { number: 1 });
      expect(afterAdd).toMatchObject({
        comments: expect.arrayContaining([
          expect.objectContaining({ kind: 'issue_comment', reactions: [{ content: 'THUMBS_UP', count: 1, viewerHasReacted: true }] }),
        ]),
      });

      const removed = await host.call('reaction', { number: 1, subjectId: 'SUBJECT_NODE', action: 'remove', content: 'heart' });
      expect(removed).toMatchObject({ changed: true, subjectId: 'SUBJECT_NODE', action: 'remove' });
      const afterRemove = await host.call('comments', { number: 1 });
      expect(afterRemove).toMatchObject({
        comments: expect.arrayContaining([expect.objectContaining({ kind: 'issue_comment', reactions: [] })]),
      });

      const resolved = await host.call('resolveThread', { number: 1, threadId: 'THREAD_NODE', action: 'resolve' });
      expect(resolved).toMatchObject({ threadId: 'THREAD_NODE', resolved: true });
      const afterResolve = await host.call('comments', { number: 1 });
      expect(afterResolve).toMatchObject({
        comments: expect.arrayContaining([expect.objectContaining({ kind: 'review_comment', isResolved: true })]),
      });

      const unresolved = await host.call('resolveThread', { number: 1, threadId: 'THREAD_NODE', action: 'unresolve' });
      expect(unresolved).toMatchObject({ threadId: 'THREAD_NODE', resolved: false });
      const afterUnresolve = await host.call('comments', { number: 1 });
      expect(afterUnresolve).toMatchObject({
        comments: expect.arrayContaining([expect.objectContaining({ kind: 'review_comment', isResolved: false })]),
      });

      const foreignThread = await host.call('resolveThread', { number: 1, threadId: 'FOREIGN_THREAD', action: 'resolve' }).then(() => null, (caught: unknown) => caught);
      expect(foreignThread).not.toBeNull();
      const foreign = await host.call('reaction', { number: 1, subjectId: 'FOREIGN_NODE', action: 'add', content: 'heart' }).then(() => null, (caught: unknown) => caught);
      expect(foreign).not.toBeNull();
      const mutations = host.invocations().filter((entry) => {
        const request = entry.args.join(' ') + entry.input;
        return request.includes('HostingReactionMutation') || request.includes('HostingThreadMutation');
      });
      expect(mutations).toHaveLength(4);
    });
  });

  test('returns a capped changed-file page with viewed flags, binary markers and patch coordinates', async () => {
    const graphqlPages = Array.from({ length: 3 }, (_, index) => ({
      data: { repository: { pullRequest: { id: 'PR_NODE', files: {
        nodes: Array.from({ length: 100 }, (__, fileIndex) => ({
          path: 'src/file-' + (index * 100 + fileIndex) + '.ts',
          viewerViewedState: fileIndex === 0 && index === 0 ? 'VIEWED' : 'UNVIEWED',
        })),
        pageInfo: { hasNextPage: true, endCursor: 'cursor-' + index },
        totalCount: 301,
      } } } } },
    }));
    await withHosting({
      responses: {
        'GET repos/test-owner/test-repo/pulls/1/files?per_page=100&page=1': changedFilesPage(1, 100),
        'GET repos/test-owner/test-repo/pulls/1/files?per_page=100&page=2': changedFilesPage(2, 100),
        'GET repos/test-owner/test-repo/pulls/1/files?per_page=100&page=3': changedFilesPage(3, 100),
      },
      graphqlResponses: { HostingFileViews: { __sequence: graphqlPages } },
    }, async (host) => {
      const result = await host.call('files', { number: 1 });
      expect(result).toMatchObject({
        files: expect.arrayContaining([
          expect.objectContaining({
            path: 'src/file-0.ts',
            viewed: true,
            coordinates: [{ line: 4, side: 'RIGHT' }, { line: 5, side: 'RIGHT' }],
          }),
          expect.objectContaining({ path: 'src/file-1.ts', isBinary: true }),
        ]),
        totalCount: 301,
        truncated: true,
        filesUnavailable: false,
      });
      expect(result).toHaveProperty('files.length', 300);
      expect(invocations(host).filter((args) => args.includes('/files?per_page=100&page=')).length).toBe(3);
    });
  });

  test('distinguishes an empty pull request file list from an unavailable files endpoint', async () => {
    await withHosting({
      responses: {
        'GET repos/test-owner/test-repo/pulls/1/files?per_page=100&page=1': [],
      },
      graphqlResponses: {
        HostingFileViews: { data: { repository: { pullRequest: { id: 'PR_NODE', files: {
          nodes: [],
          totalCount: 0,
          pageInfo: { hasNextPage: false, endCursor: null },
        } } } } },
      },
    }, async (host) => {
      const result = await host.call('files', { number: 1 });
      expect(result).toMatchObject({ files: [], totalCount: 0, filesUnavailable: false, truncated: false });
    });

    await withHosting({
      failures: { 'GET repos/test-owner/test-repo/pulls/1/files?per_page=100&page=1': 'files unavailable' },
    }, async (host) => {
      const result = await host.call('files', { number: 1 });
      expect(result).toMatchObject({
        files: [],
        totalCount: null,
        filesUnavailable: true,
        truncated: false,
        partialFailures: expect.arrayContaining([expect.any(String)]),
      });
    });
  });

  test('marks and unmarks changed files and reads each upstream viewed-state transition', async () => {
    const fileViews = (viewedState: string) => ({
      data: { repository: { pullRequest: { id: 'PR_NODE', files: {
        nodes: [{ path: 'src/a.ts', viewerViewedState: viewedState }],
        totalCount: 1,
        pageInfo: { hasNextPage: false, endCursor: null },
      } } } },
    });
    await withHosting({
      responses: {
        'GET repos/test-owner/test-repo/pulls/1/files?per_page=100&page=1': [
          { filename: 'src/a.ts', status: 'modified', additions: 1, deletions: 0, changes: 1, patch: '@@ -0,0 +1 @@\n+hello' },
        ],
      },
      graphqlResponses: {
        HostingFileViews: fileViews('UNVIEWED'),
        HostingMarkFileViewed: { data: { markFileAsViewed: { pullRequest: { id: 'PR_NODE' } } } },
        HostingUnmarkFileViewed: { data: { unmarkFileAsViewed: { pullRequest: { id: 'PR_NODE' } } } },
      },
      transitions: {
        'GRAPHQL HostingMarkFileViewed': { graphqlResponses: { HostingFileViews: fileViews('VIEWED') } },
        'GRAPHQL HostingUnmarkFileViewed': { graphqlResponses: { HostingFileViews: fileViews('UNVIEWED') } },
      },
    }, async (host) => {
      const viewed = await host.call('fileViewed', { number: 1, path: 'src/a.ts', viewed: true });
      expect(viewed).toMatchObject({ number: 1, path: 'src/a.ts', viewed: true });
      const afterView = await host.call('files', { number: 1 });
      expect(afterView).toHaveProperty('files.0.viewed', true);

      const unviewed = await host.call('fileViewed', { number: 1, path: 'src/a.ts', viewed: false });
      expect(unviewed).toMatchObject({ number: 1, path: 'src/a.ts', viewed: false });
      const afterUnview = await host.call('files', { number: 1 });
      expect(afterUnview).toHaveProperty('files.0.viewed', false);

      const foreign = await host.call('fileViewed', { number: 1, path: 'README.md', viewed: true }).then(() => null, (caught: unknown) => caught);
      expect(foreign).not.toBeNull();
      const mutations = host.invocations().filter((entry) => {
        const request = entry.args.join(' ') + entry.input;
        return request.includes('HostingMarkFileViewed') || request.includes('HostingUnmarkFileViewed');
      });
      expect(mutations).toHaveLength(2);
    });
  });

  test('reads guarded base/head contents and distinguishes binary and over-limit responses', async () => {
    const pull = { number: 1, head: { sha: 'a'.repeat(40) }, base: { sha: 'b'.repeat(40) } };
    const files = [
      { filename: 'src/a.txt', status: 'modified', additions: 1, deletions: 0, changes: 1, patch: '@@ -0,0 +1 @@\n+hello' },
      { filename: 'src/binary.dat', status: 'modified', additions: 1, deletions: 0, changes: 1, patch: undefined },
      { filename: 'src/large.bin', status: 'modified', additions: 1, deletions: 0, changes: 1, patch: undefined },
    ];
    const setup = {
      responses: {
        'GET repos/test-owner/test-repo/pulls/1': pull,
        'GET repos/test-owner/test-repo/pulls/1/files?per_page=100&page=1': files,
      },
      rawContents: [
        { match: 'contents/src/a.txt?ref=' + 'b'.repeat(40), value: 'base text\n' },
        { match: 'contents/src/a.txt?ref=' + 'a'.repeat(40), value: 'head text\n' },
        { match: 'contents/src/binary.dat?ref=' + 'a'.repeat(40), value: 'prefix\u0000binary' },
        { match: 'contents/src/large.bin?ref=' + 'a'.repeat(40), value: '__LARGE__' },
      ],
    };
    await withHosting(setup, async (host) => {
      const base = await host.call('fileContents', { number: 1, path: 'src/a.txt', side: 'base' });
      const head = await host.call('fileContents', { number: 1, path: 'src/a.txt', side: 'head' });
      expect(base).toMatchObject({ sha: 'b'.repeat(40), content: 'base text\n' });
      expect(head).toMatchObject({ sha: 'a'.repeat(40), content: 'head text\n' });
      const binary = await host.call('fileContents', { number: 1, path: 'src/binary.dat', side: 'head' });
      expect(binary).toMatchObject({ binary: true, content: null });
      const large = await host.call('fileContents', { number: 1, path: 'src/large.bin', side: 'head' });
      expect(large).toMatchObject({ tooLarge: true, content: null });
      const foreign = await host.call('fileContents', { number: 1, path: 'README.md', side: 'head' }).then(() => null, (caught: unknown) => caught);
      expect(foreign).not.toBeNull();
    });
  });
});
