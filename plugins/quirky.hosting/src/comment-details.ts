import type { Handler, HostingEnv, Scope } from './env';
import {
  asArray,
  asRecord,
  detailError,
  graphqlHasErrors,
  invalidateUncertainMutation,
  nonnegativeInteger,
  nonemptyString,
  positiveInteger,
  readNoCache,
  resolveDetailContext,
  stringValue,
  validateFilePath,
  type DetailContext,
  type DetailRecord,
} from './detail-common';
import { loadChangedFiles, requireChangedFile } from './detail-files';

export type CommentReaction = { content: string; count: number; viewerHasReacted: boolean };

export type DetailComment = {
  kind: 'issue_comment' | 'review' | 'review_comment';
  id: number | string;
  author: string | null;
  body: string;
  createdAt: string | null;
  state: string | null;
  path: string | null;
  line: number | null;
  startLine: number | null;
  threadId: string | null;
  isResolved: boolean | null;
  isOutdated: boolean | null;
  reactionSubjectId: string | null;
  reactions: CommentReaction[];
};

type CommentSource = {
  issueComments: DetailComment[];
  reviews: DetailComment[];
  threadComments: DetailComment[];
  paginationIncomplete: boolean;
};

const COMMENTS_QUERY = `query HostingComments($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      comments(first: 100) {
        nodes { id databaseId body createdAt url author { login } reactionGroups { content users { totalCount viewerHasReacted } } }
        pageInfo { hasNextPage }
      }
      reviews(first: 100) {
        nodes { id databaseId body submittedAt url state author { login } reactionGroups { content users { totalCount viewerHasReacted } } }
        pageInfo { hasNextPage }
      }
      reviewThreads(first: 100) {
        nodes {
          id isResolved path line originalLine startLine originalStartLine
          comments(first: 100) {
            nodes { id databaseId body createdAt url path line originalLine startLine originalStartLine author { login } reactionGroups { content users { totalCount viewerHasReacted } } }
            pageInfo { hasNextPage }
          }
        }
        pageInfo { hasNextPage }
      }
    }
  }
}`;
export function commentMethods(env: HostingEnv): Record<string, Handler> {
  return {
    comments: async (params, caller) => {
      const context = await resolveDetailContext(env, params, caller);
      const noCache = readNoCache(env, params);
      const load = () => loadComments(env, context);
      return noCache ? load() : env.cache(`${context.cachePrefix}:comments`, 60_000, load);
    },
    reviewComment: async (params, caller) => reviewComment(env, params, caller),
    reaction: async (params, caller) => reaction(env, params, caller),
    resolveThread: async (params, caller) => resolveThread(env, params, caller),
  };
}

async function loadComments(env: HostingEnv, context: DetailContext): Promise<unknown> {
  const sources = await Promise.allSettled([
    env.rest(envScope(context), `${context.base}/issues/${context.number}/comments?per_page=100`, 'GET', undefined, { idempotent: true }),
    env.rest(envScope(context), `${context.base}/pulls/${context.number}/reviews?per_page=100`, 'GET', undefined, { idempotent: true }),
    env.graphql(envScope(context), COMMENTS_QUERY, {
      owner: context.identity.owner,
      name: context.identity.repo,
      number: context.number,
    }, { idempotent: true }),
  ]);
  const partialFailures: string[] = [];
  const issueResponse = sources[0].status === 'fulfilled' ? sources[0].value : null;
  const reviewResponse = sources[1].status === 'fulfilled' ? sources[1].value : null;
  const restIssues = asArray(issueResponse).flatMap((value) => {
    const item = asRecord(value);
    const mapped = item === null ? null : mapRestIssueComment(item);
    return mapped === null ? [] : [mapped];
  });
  const restReviews = asArray(reviewResponse).flatMap((value) => {
    const item = asRecord(value);
    const mapped = item === null ? null : mapRestReview(item);
    return mapped === null ? [] : [mapped];
  });
  if (sources[0].status === 'rejected' || !Array.isArray(issueResponse)) {
    partialFailures.push('Conversation comments were unavailable.');
  }
  if (sources[1].status === 'rejected' || !Array.isArray(reviewResponse)) {
    partialFailures.push('Pull request reviews were unavailable.');
  }
  const graph = sources[2].status === 'fulfilled' ? parseGraphComments(sources[2].value) : null;
  if (graph === null) {
    partialFailures.push('Review threads and GraphQL comments were unavailable.');
  } else if (graph.paginationIncomplete) {
    partialFailures.push('Review conversation pagination was truncated at the 100-record source limit.');
  }
  if (asArray(issueResponse).length >= 100 && (graph === null || graph.issueComments.length === 0)) {
    partialFailures.push('Conversation comments may be truncated at the 100-record source limit.');
  }
  if (asArray(reviewResponse).length >= 100 && (graph === null || graph.reviews.length === 0)) {
    partialFailures.push('Pull request reviews may be truncated at the 100-record source limit.');
  }
  if (!Array.isArray(issueResponse) && !Array.isArray(reviewResponse) && graph === null) {
    throw detailError(env, 'comments_unavailable', 'Could not load pull request comments.', { partialFailures });
  }

  const issues = graph !== null && graph.issueComments.length > 0 ? graph.issueComments : restIssues;
  const reviews = graph !== null && graph.reviews.length > 0 ? graph.reviews : restReviews;
  const threads = graph?.threadComments ?? [];
  const comments = deduplicateComments([...issues, ...reviews, ...threads]);
  comments.sort(compareComments);
  return {
    number: context.number,
    comments,
    partial: partialFailures.length > 0,
    partialFailures,
  };
}
function parseGraphComments(value: unknown): CommentSource | null {
  if (graphqlHasErrors(value)) return null;
  const pull = asRecord(asRecord(asRecord(asRecord(value)?.data)?.repository)?.pullRequest);
  if (pull === null) return null;
  const issueConnection = asRecord(pull.comments);
  const reviewConnection = asRecord(pull.reviews);
  const threadConnection = asRecord(pull.reviewThreads);
  let paginationIncomplete = pageHasMore(issueConnection)
    || pageHasMore(reviewConnection)
    || pageHasMore(threadConnection);
  const issueComments = asArray(issueConnection?.nodes).flatMap((value) => {
    const item = asRecord(value);
    const mapped = item === null ? null : mapGraphComment(item, 'issue_comment');
    return mapped === null ? [] : [mapped];
  });
  const reviews = asArray(reviewConnection?.nodes).flatMap((value) => {
    const item = asRecord(value);
    const mapped = item === null ? null : mapGraphReview(item);
    return mapped === null ? [] : [mapped];
  });
  const threadComments: DetailComment[] = [];
  for (const threadValue of asArray(threadConnection?.nodes)) {
    const thread = asRecord(threadValue);
    if (thread === null) continue;
    const threadId = nonemptyString(thread.id);
    const resolved = typeof thread.isResolved === 'boolean' ? thread.isResolved : null;
    const isOutdated = thread.line === null ? true : thread.line === undefined ? null : false;
    const threadLine = positiveOrNull(thread.line) ?? positiveOrNull(thread.originalLine);
    const threadStart = positiveOrNull(thread.startLine) ?? positiveOrNull(thread.originalStartLine);
    const commentsConnection = asRecord(thread.comments);
    if (pageHasMore(commentsConnection)) paginationIncomplete = true;
    for (const commentValue of asArray(commentsConnection?.nodes)) {
      const comment = asRecord(commentValue);
      if (comment === null) continue;
      const mapped = mapThreadComment(comment, {
        threadId,
        isResolved: resolved,
        isOutdated,
        path: nonemptyString(comment.path) ?? nonemptyString(thread.path),
        line: positiveOrNull(comment.line) ?? positiveOrNull(comment.originalLine) ?? threadLine,
        startLine: positiveOrNull(comment.startLine) ?? positiveOrNull(comment.originalStartLine) ?? threadStart,
      });
      if (mapped !== null) threadComments.push(mapped);
    }
  }
  return { issueComments, reviews, threadComments, paginationIncomplete };
}
function pageHasMore(value: unknown): boolean {
  return asRecord(asRecord(value)?.pageInfo)?.hasNextPage === true;
}

function mapGraphComment(value: DetailRecord, kind: 'issue_comment' | 'review_comment'): DetailComment | null {
  const id = commentId(value);
  if (id === null) return null;
  return {
    kind,
    id,
    author: nonemptyString(asRecord(value.author)?.login),
    body: stringValue(value.body) ?? '',
    createdAt: nonemptyString(value.createdAt),
    state: null,
    path: nonemptyString(value.path),
    line: positiveOrNull(value.line) ?? positiveOrNull(value.originalLine),
    startLine: positiveOrNull(value.startLine) ?? positiveOrNull(value.originalStartLine),
    threadId: null,
    isResolved: null,
    isOutdated: null,
    reactionSubjectId: nonemptyString(value.id),
    reactions: mapReactionGroups(value.reactionGroups),
  };
}

function mapThreadComment(value: DetailRecord, thread: {
  threadId: string | null;
  isResolved: boolean | null;
  isOutdated: boolean | null;
  path: string | null;
  line: number | null;
  startLine: number | null;
}): DetailComment | null {
  const comment = mapGraphComment(value, 'review_comment');
  return comment === null ? null : {
    ...comment,
    path: thread.path,
    line: thread.line,
    startLine: thread.startLine,
    threadId: thread.threadId,
    isResolved: thread.isResolved,
    isOutdated: thread.isOutdated,
  };
}

function mapGraphReview(value: DetailRecord): DetailComment | null {
  const body = stringValue(value.body) ?? '';
  const id = commentId(value);
  if (body.length === 0 || id === null) return null;
  return {
    kind: 'review',
    id,
    author: nonemptyString(asRecord(value.author)?.login),
    body,
    createdAt: nonemptyString(value.submittedAt),
    state: nonemptyString(value.state),
    path: null,
    line: null,
    startLine: null,
    threadId: null,
    isResolved: null,
    isOutdated: null,
    reactionSubjectId: nonemptyString(value.id),
    reactions: mapReactionGroups(value.reactionGroups),
  };
}

function mapRestIssueComment(value: DetailRecord): DetailComment | null {
  const id = commentId(value);
  if (id === null) return null;
  return {
    kind: 'issue_comment',
    id,
    author: nonemptyString(asRecord(value.user)?.login),
    body: stringValue(value.body) ?? '',
    createdAt: nonemptyString(value.created_at),
    state: null,
    path: null,
    line: null,
    startLine: null,
    threadId: null,
    isResolved: null,
    isOutdated: null,
    reactionSubjectId: nonemptyString(value.node_id),
    reactions: [],
  };
}

function mapRestReview(value: DetailRecord): DetailComment | null {
  const body = stringValue(value.body) ?? '';
  if (body.length === 0) return null;
  return {
    kind: 'review',
    id: commentId(value),
    author: nonemptyString(asRecord(value.user)?.login),
    body,
    createdAt: nonemptyString(value.submitted_at),
    state: nonemptyString(value.state),
    path: null,
    line: null,
    startLine: null,
    threadId: null,
    isResolved: null,
    isOutdated: null,
    reactionSubjectId: nonemptyString(value.node_id),
    reactions: [],
  };
}

function mapReactionGroups(value: unknown): CommentReaction[] {
  return asArray(value).flatMap((groupValue) => {
    const group = asRecord(groupValue);
    if (group === null) return [];
    const users = asRecord(group.users);
    const count = nonnegativeInteger(users?.totalCount) ? users.totalCount : 0;
    return [{
      content: nonemptyString(group.content) ?? 'UNKNOWN',
      count,
      viewerHasReacted: users?.viewerHasReacted === true,
    }];
  });
}

function deduplicateComments(comments: DetailComment[]): DetailComment[] {
  const seen = new Set<string>();
  return comments.filter((comment) => {
    const key = `${comment.kind}:${String(comment.id)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function compareComments(left: DetailComment, right: DetailComment): number {
  const leftTime = left.createdAt === null ? Number.POSITIVE_INFINITY : Date.parse(left.createdAt);
  const rightTime = right.createdAt === null ? Number.POSITIVE_INFINITY : Date.parse(right.createdAt);
  const timeDelta = (Number.isNaN(leftTime) ? Number.POSITIVE_INFINITY : leftTime)
    - (Number.isNaN(rightTime) ? Number.POSITIVE_INFINITY : rightTime);
  return Number.isNaN(timeDelta) || timeDelta === 0 ? String(left.id).localeCompare(String(right.id)) : timeDelta;
}

async function reviewComment(
  env: HostingEnv,
  params: Record<string, unknown>,
  caller: Parameters<Handler>[1],
): Promise<unknown> {
  const context = await resolveDetailContext(env, params, caller);
  const action = params.action;
  if (action !== 'inline' && action !== 'reply') {
    throw env.invalid('invalid_input', 'Review comment action must be inline or reply.');
  }
  const body = params.body;
  if (typeof body !== 'string' || body.trim().length === 0 || new TextEncoder().encode(body).byteLength > 65_536) {
    throw env.invalid('invalid_input', 'A non-empty review comment body of at most 64 KiB is required.');
  }
  if (action === 'reply') return addReply(env, context, params, body);
  return addInlineComment(env, context, params, body);
}

async function addInlineComment(
  env: HostingEnv,
  context: DetailContext,
  params: Record<string, unknown>,
  body: string,
): Promise<unknown> {
  const headSha = params.headSha;
  if (typeof headSha !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(headSha)) {
    throw env.invalid('invalid_input', 'Inline comments require a valid expected head SHA.');
  }
  const path = validateFilePath(env, params.path);
  const line = params.line;
  const startLine = params.startLine;
  if (!positiveInteger(line) || startLine !== undefined && !positiveInteger(startLine)) {
    throw env.invalid('invalid_input', 'Inline comments require positive line coordinates.');
  }
  if (startLine !== undefined && startLine > line) {
    throw env.invalid('invalid_input', 'The range start line cannot follow its end line.');
  }

  const pull = asRecord(await env.rest(context.scope, `${context.base}/pulls/${context.number}`, 'GET', undefined, { idempotent: true }));
  const currentHead = shaValue(asRecord(pull?.head)?.sha);
  if (currentHead === null || currentHead.toLowerCase() !== headSha.toLowerCase()) {
    throw env.invalid('stale_head', 'The pull request head changed; refresh before commenting.');
  }
  const files = await loadChangedFiles(env, context);
  const file = requireChangedFile(env, files, path);
  const rightLines = new Set(file.coordinates.filter((coordinate) => coordinate.side === 'RIGHT').map((coordinate) => coordinate.line));
  const firstLine = startLine ?? line;
  if (line - firstLine + 1 > rightLines.size) {
    throw env.invalid('invalid_coordinates', 'The comment range does not match the pull request diff.');
  }
  for (let coordinate = firstLine; coordinate <= line; coordinate += 1) {
    if (!rightLines.has(coordinate)) {
      throw env.invalid('invalid_coordinates', 'The comment range does not match the pull request diff.');
    }
  }

  const fields: Record<string, unknown> = {
    body,
    commit_id: headSha,
    path,
    line,
    side: 'RIGHT',
  };
  if (startLine !== undefined) {
    fields.start_line = startLine;
    fields.start_side = 'RIGHT';
  }
  const response = asRecord(await runMutation(env, context, 'reviewComment', () => env.rest(context.scope, `${context.base}/pulls/${context.number}/comments`, 'POST', fields, { idempotent: false })));
  const id = positiveOrNull(response?.id);
  if (id === null) {
    env.changed(context.scope, { number: context.number, operation: 'reviewComment', uncertain: true });
    throw env.invalid('unknown_completion', 'GitHub did not confirm the review comment.');
  }
  const returnedPath = nonemptyString(response?.path);
  if (returnedPath !== null && returnedPath !== path) {
    env.changed(context.scope, { number: context.number, operation: 'reviewComment', uncertain: true });
    throw env.invalid('unknown_completion', 'GitHub returned a different review comment target.');
  }
  env.changed(context.scope, { number: context.number, operation: 'reviewComment', completedSteps: ['inline_comment'] });
  return {
    number: context.number,
    action: 'inline',
    comment: {
      id,
      path,
      line: positiveOrNull(response?.line) ?? line,
      startLine: positiveOrNull(response?.start_line) ?? startLine ?? null,
      body: stringValue(response?.body) ?? body,
    },
  };
}

async function addReply(
  env: HostingEnv,
  context: DetailContext,
  params: Record<string, unknown>,
  body: string,
): Promise<unknown> {
  const replyToId = params.replyToId;
  if (!positiveInteger(replyToId)) throw env.invalid('invalid_input', 'A positive review comment ID is required for a reply.');
  const target = asRecord(await env.rest(context.scope, `${context.base}/pulls/comments/${replyToId}`, 'GET', undefined, { idempotent: true }));
  if (target === null || positiveOrNull(target.id) !== replyToId || !pullRequestUrlMatches(target.pull_request_url, context)) {
    throw env.invalid('foreign_target', 'The reply target does not belong to the selected pull request.');
  }
  const response = asRecord(await runMutation(env, context, 'reviewComment', () => env.rest(context.scope, `${context.base}/pulls/${context.number}/comments/${replyToId}/replies`, 'POST', { body }, { idempotent: false })));
  const id = positiveOrNull(response?.id);
  if (id === null || response?.in_reply_to_id !== undefined && positiveOrNull(response.in_reply_to_id) !== replyToId) {
    env.changed(context.scope, { number: context.number, operation: 'reviewComment', uncertain: true });
    throw env.invalid('unknown_completion', 'GitHub did not confirm the review reply.');
  }
  env.changed(context.scope, { number: context.number, operation: 'reviewComment', completedSteps: ['reply'] });
  return {
    number: context.number,
    action: 'reply',
    comment: {
      id,
      path: nonemptyString(response?.path),
      line: positiveOrNull(response?.line),
      startLine: positiveOrNull(response?.start_line),
      body: stringValue(response?.body) ?? body,
    },
  };
}

async function reaction(
  env: HostingEnv,
  params: Record<string, unknown>,
  caller: Parameters<Handler>[1],
): Promise<unknown> {
  const context = await resolveDetailContext(env, params, caller);
  const action = params.action;
  const content = params.content;
  const contentValue = typeof content === 'string' ? content : null;
  const subjectId = nonemptyString(params.subjectId);
  const reactionType = contentValue !== null && Object.prototype.hasOwnProperty.call(REACTIONS, contentValue)
    ? REACTIONS[contentValue]
    : undefined;
  if ((action !== 'add' && action !== 'remove') || subjectId === null || subjectId.length > 1024 || reactionType === undefined) {
    throw env.invalid('invalid_input', 'Reaction action, target ID, or content is invalid.');
  }

  const target = await env.graphql(context.scope, REACTION_TARGET_QUERY, {
    owner: context.identity.owner,
    name: context.identity.repo,
    number: context.number,
    subjectId,
  }, { idempotent: true });
  if (graphqlHasErrors(target)) throw env.invalid('target_unavailable', 'Could not verify the reaction target.');
  const pull = graphqlPull(target);
  const selectedPrId = nonemptyString(pull?.id);
  const targetData = asRecord(asRecord(target)?.data);
  const node = asRecord(targetData?.node);
  if (selectedPrId === null || node === null || reactionParentId(node) !== selectedPrId) {
    throw env.invalid('foreign_target', 'The reaction target does not belong to the selected pull request.');
  }

  const field = action === 'add' ? 'addReaction' : 'removeReaction';
  const mutation = `mutation HostingReactionMutation($subjectId: ID!, $content: ReactionContent!) {
    ${field}(input: { subjectId: $subjectId, content: $content }) { subject { id } reaction { content } }
  }`;
  const response = await runMutation(env, context, 'reaction', () => env.graphql(context.scope, mutation, { subjectId, content: reactionType }, { idempotent: false }));
  if (graphqlHasErrors(response)) {
    env.changed(context.scope, { number: context.number, operation: 'reaction', uncertain: true });
    throw env.invalid('unknown_completion', 'GitHub did not confirm the reaction.');
  }
  const payload = asRecord(asRecord(asRecord(response)?.data)?.[field]);
  if (nonemptyString(asRecord(payload?.subject)?.id) !== subjectId) {
    env.changed(context.scope, { number: context.number, operation: 'reaction', uncertain: true });
    throw env.invalid('unknown_completion', 'GitHub did not confirm the reaction target.');
  }
  env.changed(context.scope, { number: context.number, operation: 'reaction', completedSteps: [action] });
  return { subjectId, action, content: contentValue, changed: true };
}
async function resolveThread(
  env: HostingEnv,
  params: Record<string, unknown>,
  caller: Parameters<Handler>[1],
): Promise<unknown> {
  const context = await resolveDetailContext(env, params, caller);
  const action = params.action;
  const threadId = nonemptyString(params.threadId);
  if ((action !== 'resolve' && action !== 'unresolve') || threadId === null || threadId.length > 1024) {
    throw env.invalid('invalid_input', 'Thread action or ID is invalid.');
  }
  const response = await env.graphql(context.scope, THREAD_TARGET_QUERY, {
    owner: context.identity.owner,
    name: context.identity.repo,
    number: context.number,
  }, { idempotent: true });
  if (graphqlHasErrors(response)) throw env.invalid('target_unavailable', 'Could not verify the review thread.');
  const pull = graphqlPull(response);
  const threadIds = asArray(asRecord(pull?.reviewThreads)?.nodes).flatMap((value) => {
    const item = asRecord(value);
    const id = nonemptyString(item?.id);
    return id === null ? [] : [id];
  });
  if (nonemptyString(pull?.id) === null || !threadIds.includes(threadId)) {
    throw env.invalid('foreign_target', 'The review thread does not belong to the selected pull request.');
  }
  const field = action === 'resolve' ? 'resolveReviewThread' : 'unresolveReviewThread';
  const mutation = `mutation HostingThreadMutation($threadId: ID!) {
    ${field}(input: { threadId: $threadId }) { thread { id isResolved } }
  }`;
  const result = await runMutation(env, context, 'resolveThread', () => env.graphql(context.scope, mutation, { threadId }, { idempotent: false }));
  if (graphqlHasErrors(result)) {
    env.changed(context.scope, { number: context.number, operation: 'resolveThread', uncertain: true });
    throw env.invalid('unknown_completion', 'GitHub did not confirm the review thread state.');
  }
  const thread = asRecord(asRecord(asRecord(asRecord(result)?.data)?.[field])?.thread);
  const resolved = action === 'resolve';
  if (nonemptyString(thread?.id) !== threadId || thread?.isResolved !== resolved) {
    env.changed(context.scope, { number: context.number, operation: 'resolveThread', uncertain: true });
    throw env.invalid('unknown_completion', 'GitHub did not confirm the review thread state.');
  }
  env.changed(context.scope, { number: context.number, operation: 'resolveThread', completedSteps: [action] });
  return { threadId, action, resolved };
}

export const REACTION_TARGET_QUERY = `query HostingReactionTarget($owner: String!, $name: String!, $number: Int!, $subjectId: ID!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { id } }
  node(id: $subjectId) {
    __typename
    ... on PullRequest { id }
    ... on IssueComment { issue { __typename id ... on PullRequest { id } } }
    ... on PullRequestReviewComment { pullRequest { id } }
    ... on PullRequestReview { pullRequest { id } }
  }
}`;

const THREAD_TARGET_QUERY = `query HostingThreadTarget($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { id reviewThreads(first: 100) { nodes { id } } }
  }
}`;

const REACTIONS: Record<string, string> = {
  '+1': 'THUMBS_UP',
  '-1': 'THUMBS_DOWN',
  laugh: 'LAUGH',
  confused: 'CONFUSED',
  heart: 'HEART',
  hooray: 'HOORAY',
  rocket: 'ROCKET',
  eyes: 'EYES',
};

function graphqlPull(value: unknown): DetailRecord | null {
  const data = asRecord(asRecord(value)?.data);
  const repository = asRecord(data?.repository);
  return asRecord(repository?.pullRequest);
}

function reactionParentId(node: DetailRecord): string | null {
  const typename = node.__typename;
  if (typename === 'PullRequest') return nonemptyString(node.id);
  if (typename === 'IssueComment') {
    const issue = asRecord(node.issue);
    return issue?.__typename === 'PullRequest' ? nonemptyString(issue.id) : null;
  }
  if (typename === 'PullRequestReviewComment' || typename === 'PullRequestReview') {
    return nonemptyString(asRecord(node.pullRequest)?.id);
  }
  return null;
}

function commentId(value: DetailRecord): number | string | null {
  if (positiveInteger(value.databaseId)) return value.databaseId;
  if (positiveInteger(value.id)) return value.id;
  return nonemptyString(value.id);
}

function positiveOrNull(value: unknown): number | null {
  if (positiveInteger(value)) return value;
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) {
    const parsed = Number(value);
    return positiveInteger(parsed) ? parsed : null;
  }
  return null;
}

function pullRequestUrlMatches(value: unknown, context: DetailContext): boolean {
  if (typeof value !== 'string') return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const host = url.host.toLowerCase();
  const expectedHost = context.identity.host.toLowerCase() === 'github.com'
    ? 'api.github.com'
    : context.identity.host.toLowerCase();
  const path = url.pathname.replace(/\/$/, '').toLowerCase();
  const expectedPath = `/repos/${context.identity.owner}/${context.identity.repo}/pulls/${context.number}`.toLowerCase();
  return host === expectedHost && (path === expectedPath || path.endsWith(expectedPath));
}

function envScope(context: DetailContext): Scope {
  return context.scope;
}
async function runMutation<T>(
  env: HostingEnv,
  context: DetailContext,
  operation: string,
  request: () => Promise<T>,
): Promise<T> {
  try {
    return await request();
  } catch (error) {
    invalidateUncertainMutation(env, context, operation, error);
    throw error;
  }
}
