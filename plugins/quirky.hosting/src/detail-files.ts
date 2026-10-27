import type { Handler, HostingEnv } from './env';
import {
  asArray,
  asRecord,
  encodeFilePath,
  errorReason,
  graphqlHasErrors,
  invalidateUncertainMutation,
  nonemptyString,
  nonnegativeInteger,
  readNoCache,
  resolveDetailContext,
  shaValue,
  validateFilePath,
  type DetailContext,
  type DetailRecord,
} from './detail-common';

export type PatchCoordinate = { line: number; side: 'LEFT' | 'RIGHT' };

export type ChangedFile = {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch: string | null;
  isBinary: boolean;
  patchUnavailable: boolean;
  viewed: boolean | null;
  coordinates: PatchCoordinate[];
};

export type ChangedFilesResult = {
  number: number;
  files: ChangedFile[];
  totalCount: number | null;
  truncated: boolean;
  filesUnavailable: boolean;
  partialFailures: string[];
  pullRequestId: string | null;
};

const FILE_VIEWS_QUERY = `query HostingFileViews($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id
      files(first: 100, after: $after) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes { path viewerViewedState }
      }
    }
  }
}`;

export function fileMethods(env: HostingEnv): Record<string, Handler> {
  return {
    fileViewed: async (params, caller) => fileViewed(env, params, caller),
    files: async (params, caller) => {
      const context = await resolveDetailContext(env, params, caller);
      const noCache = readNoCache(env, params);
      const load = () => loadChangedFiles(env, context);
      const result = noCache ? await load() : await env.cache(`${context.cachePrefix}:files`, 60_000, load);
      return {
        number: result.number,
        files: result.files,
        totalCount: result.totalCount,
        truncated: result.truncated,
        filesUnavailable: result.filesUnavailable,
        partialFailures: result.partialFailures,
      };
    },
    fileContents: async (params, caller) => fileContents(env, params, caller),
  };
}

export async function loadChangedFiles(
  env: HostingEnv,
  context: DetailContext,
): Promise<ChangedFilesResult> {
  const partialFailures: string[] = [];
  const files: ChangedFile[] = [];
  let restAvailable = true;
  let reachedCap = false;
  let restHasMore = false;
  let restIncomplete = false;
  for (let page = 1; page <= 3; page += 1) {
    let response: unknown;
    try {
      response = await env.rest(context.scope, `${context.base}/pulls/${context.number}/files?per_page=100&page=${page}`, 'GET', undefined, { idempotent: true });
    } catch {
      partialFailures.push(`Changed files page ${page} was unavailable.`);
      restAvailable = false;
      restHasMore = true;
      restIncomplete = true;
      break;
    }
    if (!Array.isArray(response)) {
      partialFailures.push(`Changed files page ${page} was unavailable.`);
      restAvailable = false;
      restHasMore = true;
      restIncomplete = true;
      break;
    }
    const pageValues = asArray(response);
    const pageFiles = pageValues.flatMap((value) => {
      const item = asRecord(value);
      const mapped = item === null ? null : mapChangedFile(item);
      return mapped === null ? [] : [mapped];
    });
    files.push(...pageFiles);
    if (pageValues.length < 100) break;
    if (page === 3) {
      reachedCap = true;
      restHasMore = true;
    }
  }

  if (!restAvailable && files.length === 0) {
    return {
      number: context.number,
      files: [],
      totalCount: null,
      truncated: false,
      filesUnavailable: true,
      partialFailures,
      pullRequestId: null,
    };
  }

  const views = new Map<string, boolean>();
  let pullRequestId: string | null = null;
  let totalCount: number | null = null;
  let graphHasMore = false;
  let graphAvailable = true;
  let cursor: string | null = null;
  const seenCursors = new Set<string>();
  for (let page = 0; page < 3; page += 1) {
    try {
      const response = await env.graphql(context.scope, FILE_VIEWS_QUERY, {
        owner: context.identity.owner,
        name: context.identity.repo,
        number: context.number,
        after: cursor,
      }, { idempotent: true });
      if (graphqlHasErrors(response)) throw new Error('GraphQL error');
      const pull = asRecord(asRecord(asRecord(asRecord(response)?.data)?.repository)?.pullRequest);
      const connection = asRecord(pull?.files);
      if (pull === null || connection === null) throw new Error('Missing file view data');
      pullRequestId = nonemptyString(pull.id);
      if (nonnegativeInteger(connection.totalCount)) totalCount = connection.totalCount;
      for (const value of asArray(connection.nodes)) {
        const item = asRecord(value);
        const path = nonemptyString(item?.path);
        if (path === null) continue;
        if (item?.viewerViewedState === 'VIEWED') views.set(path, true);
        else if (item?.viewerViewedState === 'UNVIEWED') views.set(path, false);
      }
      const pageInfo = asRecord(connection.pageInfo);
      graphHasMore = pageInfo?.hasNextPage === true;
      if (!graphHasMore) break;
      const nextCursor = nonemptyString(pageInfo?.endCursor);
      if (nextCursor === null || seenCursors.has(nextCursor)) {
        partialFailures.push('Changed file viewed-state pagination was incomplete.');
        graphHasMore = true;
        break;
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
      if (page === 2) graphHasMore = true;
    } catch {
      partialFailures.push('Changed file viewed states were unavailable.');
      graphAvailable = false;
      break;
    }
  }

  const merged = files.map((file) => ({ ...file, viewed: views.get(file.path) ?? null }));
  const atCap = reachedCap || merged.length >= 300;
  const truncated = restIncomplete || (graphAvailable ? graphHasMore : atCap || restHasMore);
  if (totalCount === null && restAvailable && !restHasMore) totalCount = merged.length;
  return {
    number: context.number,
    files: merged,
    totalCount,
    truncated,
    filesUnavailable: false,
    partialFailures,
    pullRequestId,
  };
}

export function requireChangedFile(env: HostingEnv, result: ChangedFilesResult, path: string): ChangedFile {
  if (result.filesUnavailable) throw env.invalid('files_unavailable', 'Could not verify the changed file.');
  const file = result.files.find((candidate) => candidate.path === path);
  if (file !== undefined) return file;
  if (result.truncated) throw env.invalid('files_unavailable', 'The changed file list is truncated and does not confirm this path.');
  throw env.invalid('file_not_in_pull_request', 'The file is not part of this pull request.');
}

async function fileViewed(
  env: HostingEnv,
  params: Record<string, unknown>,
  caller: Parameters<Handler>[1],
): Promise<unknown> {
  const context = await resolveDetailContext(env, params, caller);
  const path = validateFilePath(env, params.path);
  if (typeof params.viewed !== 'boolean') throw env.invalid('invalid_input', 'viewed must be a boolean.');
  const files = await loadChangedFiles(env, context);
  requireChangedFile(env, files, path);
  if (files.pullRequestId === null) throw env.invalid('target_unavailable', 'Could not verify the pull request identity.');

  const field = params.viewed ? 'markFileAsViewed' : 'unmarkFileAsViewed';
  const operation = params.viewed ? 'HostingMarkFileViewed' : 'HostingUnmarkFileViewed';
  const mutation = `mutation ${operation}($pullRequestId: ID!, $path: String!) {
    ${field}(input: { pullRequestId: $pullRequestId, path: $path }) { pullRequest { id } }
  }`;
  let response: unknown;
  try {
    response = await env.graphql(context.scope, mutation, {
      pullRequestId: files.pullRequestId,
      path,
    }, { idempotent: false });
  } catch (error) {
    invalidateUncertainMutation(env, context, 'fileViewed', error);
    throw error;
  }
  if (graphqlHasErrors(response)) {
    env.changed(context.scope, { number: context.number, operation: 'fileViewed', uncertain: true });
    throw env.invalid('unknown_completion', 'GitHub did not confirm the viewed-file state.');
  }
  const payload = asRecord(asRecord(asRecord(response)?.data)?.[field]);
  if (nonemptyString(asRecord(payload?.pullRequest)?.id) !== files.pullRequestId) {
    env.changed(context.scope, { number: context.number, operation: 'fileViewed', uncertain: true });
    throw env.invalid('unknown_completion', 'GitHub did not confirm the viewed-file state.');
  }
  env.changed(context.scope, { number: context.number, operation: 'fileViewed', completedSteps: [params.viewed ? 'viewed' : 'unviewed'] });
  return { number: context.number, path, viewed: params.viewed };
}

async function fileContents(
  env: HostingEnv,
  params: Record<string, unknown>,
  caller: Parameters<Handler>[1],
): Promise<unknown> {
  const context = await resolveDetailContext(env, params, caller);
  const path = validateFilePath(env, params.path);
  const side = params.side;
  if (side !== 'base' && side !== 'head') throw env.invalid('invalid_input', 'File content side must be base or head.');
  const noCache = readNoCache(env, params);
  const pull = asRecord(await env.rest(context.scope, `${context.base}/pulls/${context.number}`, 'GET', undefined, { idempotent: true }));
  const sha = shaValue(asRecord(pull?.[side])?.sha);
  if (sha === null) throw env.invalid('file_unavailable', `The pull request ${side} SHA is unavailable.`);
  const files = await loadChangedFiles(env, context);
  requireChangedFile(env, files, path);

  const key = `${context.cachePrefix}:content:${side}:${sha}:${path}`;
  const load = () => loadRawFile(env, context, path, side, sha);
  return noCache ? load() : env.cache(key, 300_000, load);
}

async function loadRawFile(
  env: HostingEnv,
  context: DetailContext,
  path: string,
  side: 'base' | 'head',
  sha: string,
): Promise<unknown> {
  const route = `${context.base}/contents/${encodeFilePath(path)}?ref=${encodeURIComponent(sha)}`;
  let content: string;
  try {
    content = await env.run(context.scope, [
      'api', '--cache', '300s', '-H', 'Accept: application/vnd.github.raw', route,
    ], { idempotent: true, timeoutMs: 30_000, maxBytes: 8 * 1024 * 1024 });
  } catch (error) {
    const reason = errorReason(error);
    if (reason === 'output_limit') {
      return { number: context.number, path, side, sha, content: null, binary: false, tooLarge: true, unavailable: false };
    }
    if (reason === 'not_found' || reason === 'http_404') {
      return { number: context.number, path, side, sha, content: null, binary: false, tooLarge: false, unavailable: true };
    }
    throw env.invalid('file_contents_unavailable', 'Could not load the requested pull request file contents.');
  }
  const nulIndex = content.slice(0, 2048).indexOf('\0');
  if (nulIndex >= 0 && Buffer.byteLength(content.slice(0, nulIndex), 'utf8') < 2048) {
    return { number: context.number, path, side, sha, content: null, binary: true, tooLarge: false, unavailable: false };
  }
  return { number: context.number, path, side, sha, content, binary: false, tooLarge: false, unavailable: false };
}

function mapChangedFile(value: DetailRecord): ChangedFile | null {
  const path = nonemptyString(value.filename);
  if (path === null || !nonnegativeInteger(value.additions) || !nonnegativeInteger(value.deletions) || !nonnegativeInteger(value.changes)) return null;
  const patch = typeof value.patch === 'string' ? value.patch : null;
  return {
    path,
    status: nonemptyString(value.status) ?? 'unknown',
    additions: value.additions,
    deletions: value.deletions,
    changes: value.changes,
    patch,
    isBinary: patch === null && value.changes > 0,
    patchUnavailable: patch === null,
    viewed: null,
    coordinates: patch === null ? [] : patchCoordinates(patch),
  };
}

function patchCoordinates(patch: string): PatchCoordinate[] {
  const coordinates: PatchCoordinate[] = [];
  let left: number | null = null;
  let right: number | null = null;
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) {
      const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      left = hunk === null ? null : Number(hunk[1]);
      right = hunk === null ? null : Number(hunk[2]);
      continue;
    }
    if (left === null || right === null) continue;
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) {
      coordinates.push({ line: right, side: 'RIGHT' });
      right += 1;
    } else if (line.startsWith('-')) {
      coordinates.push({ line: left, side: 'LEFT' });
      left += 1;
    } else if (line.startsWith(' ')) {
      coordinates.push({ line: left, side: 'LEFT' }, { line: right, side: 'RIGHT' });
      left += 1;
      right += 1;
    }
  }
  const seen = new Set<string>();
  return coordinates.filter((coordinate) => {
    const key = `${coordinate.side}:${coordinate.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
