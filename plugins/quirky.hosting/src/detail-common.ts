import type { Handler, HostingEnv, Identity, Scope } from './env';

export type DetailContext = {
  scope: Scope;
  number: number;
  identity: Identity;
  base: string;
  cachePrefix: string;
};

export type DetailRecord = Record<string, unknown>;

export function asRecord(value: unknown): DetailRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as DetailRecord
    : null;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function nonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function nonemptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}


export function shaValue(value: unknown): string | null {
  return typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value)
    ? value
    : null;
}

export function errorReason(error: unknown): string | null {
  const record = asRecord(error);
  const data = record === null ? null : asRecord(record.data);
  return data === null ? null : stringValue(data.reason);
}
export function uncertainMutation(error: unknown): boolean {
  const reason = errorReason(error);
  return reason === 'timeout' || reason === 'output_limit' || reason === 'unknown_completion';
}
export function invalidateUncertainMutation(
  env: HostingEnv,
  context: DetailContext,
  operation: string,
  error: unknown,
): void {
  if (uncertainMutation(error)) {
    env.changed(context.scope, { number: context.number, operation, uncertain: true });
  }
}

export function detailError(
  env: HostingEnv,
  reason: string,
  message: string,
  extra: Record<string, unknown> = {},
): Error {
  const error = env.invalid(reason, message);
  const oldError = asRecord(error);
  const oldData = oldError === null ? null : asRecord(oldError.data);
  return Object.assign(error, {
    data: { ...(oldData ?? {}), ...extra, reason },
  });
}

export async function resolveDetailContext(
  env: HostingEnv,
  params: Record<string, unknown>,
  caller: Parameters<Handler>[1],
): Promise<DetailContext> {
  if (!positiveInteger(params.number)) {
    throw env.invalid('invalid_input', 'A positive pull request number is required.');
  }
  if (params.worktree !== undefined && nonemptyString(params.worktree) === null) {
    throw env.invalid('invalid_input', 'The worktree selector must be a non-empty string.');
  }

  const requested = params.prRepo === undefined ? null : parseRequestedIdentity(params.prRepo);
  if (params.prRepo !== undefined && requested === null) {
    throw env.invalid('invalid_input', 'The pull request repository selector is invalid.');
  }

  const scope = await env.resolve(params, caller);
  const allowed = [scope.origin, scope.repository, ...scope.candidates];
  const identity = requested ?? scope.repository;
  if (!allowed.some((candidate) => sameIdentity(candidate, identity))) {
    throw env.invalid('repository_mismatch', 'The requested pull request repository is not configured for this worktree.');
  }

  const base = `repos/${identity.owner}/${identity.repo}`;
  const cachePrefix = env.cacheKey(scope, `details:${identity.host}:${identity.owner}/${identity.repo}:pr:${params.number}`);
  return { scope, number: params.number, identity, base, cachePrefix };
}

function parseRequestedIdentity(value: unknown): Identity | null {
  const record = asRecord(value);
  if (record === null) return null;
  const host = nonemptyString(record.host);
  const owner = nonemptyString(record.owner);
  const repo = nonemptyString(record.repo);
  if (host === null || owner === null || repo === null) return null;
  if (!/^[a-z0-9.-]+(?::[0-9]{1,5})?$/i.test(host)) return null;
  if (!/^[a-z0-9_.-]+$/i.test(owner) || !/^[a-z0-9_.-]+$/i.test(repo)) return null;
  return { host, owner, repo };
}

function sameIdentity(left: Identity, right: Identity): boolean {
  return left.host.toLowerCase() === right.host.toLowerCase()
    && left.owner.toLowerCase() === right.owner.toLowerCase()
    && left.repo.toLowerCase() === right.repo.toLowerCase();
}

export function readNoCache(env: HostingEnv, params: Record<string, unknown>): boolean {
  if (params.noCache === undefined) return false;
  if (typeof params.noCache !== 'boolean') {
    throw env.invalid('invalid_input', 'noCache must be a boolean.');
  }
  return params.noCache;
}

export function validateFilePath(env: HostingEnv, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > 4096) {
    throw env.invalid('invalid_input', 'A repository-relative file path is required.');
  }
  const segments = value.split('/');
  if (value.startsWith('/') || value.includes('\\') || value.includes('\0')
    || /[\u0000-\u001f\u007f]/.test(value)
    || segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw env.invalid('invalid_input', 'The file path is not a valid repository-relative path.');
  }
  return value;
}

export function encodeFilePath(path: string): string {
  return path.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}


export function graphqlHasErrors(value: unknown): boolean {
  const record = asRecord(value);
  return record !== null && Array.isArray(record.errors) && record.errors.length > 0;
}


