import type { HostingEnv } from './env'
import { record, safeErrorMessage, safeErrorReason } from './item-data'

export type ProjectErrorReason =
  | 'auth_required'
  | 'scope_missing'
  | 'rate_limited'
  | 'network_error'
  | 'not_found'
  | 'validation_error'
  | 'schema_drift'
  | 'body_too_long'
  | 'already_exists'
  | 'too_large'
  | 'unsupported_layout'
  | 'unknown'

function isProjectErrorReason(value: string): value is ProjectErrorReason {
  switch (value) {
    case 'auth_required':
    case 'scope_missing':
    case 'rate_limited':
    case 'network_error':
    case 'not_found':
    case 'validation_error':
    case 'schema_drift':
    case 'body_too_long':
    case 'already_exists':
    case 'too_large':
    case 'unsupported_layout':
    case 'unknown':
      return true
    default:
      return false
  }
}

export function projectError(
  env: HostingEnv,
  reason: ProjectErrorReason,
  message: string,
  extra: Record<string, unknown> = {}
): Error {
  const error = env.invalid(reason, message)
  const existing = record(record(error)?.data) ?? {}
  return Object.assign(error, { data: { ...existing, reason, ...extra } })
}

export function classifyProjectError(env: HostingEnv, error: unknown, host: string): Error {
  const originalReason = safeErrorReason(error)
  if (originalReason !== 'unknown' && isProjectErrorReason(originalReason)) {
    const message = safeErrorMessage(error)
    return projectError(env, originalReason, message)
  }
  const message = safeErrorMessage(error)
  const text = message.toLowerCase()
  if (originalReason === 'permission_denied' || /permission denied|forbidden|http 403/.test(text)) {
    return projectError(env, 'scope_missing', `GitHub Projects requires scopes. Run gh auth refresh --hostname ${host} -s project -s read:org -s repo.`)
  }
  if (/authentication required|authentication unavailable|authentication failed|not logged in|not authenticated|unauthorized|gh auth login|bad credentials|http 401/.test(text)) {
    return projectError(env, 'auth_required', `GitHub CLI is not authenticated to ${host}. Run gh auth login --hostname ${host}.`)
  }
  if (/insufficient scope|resource not accessible|missing.*scope|project.*scope|read:org/.test(text)) {
    return projectError(env, 'scope_missing', `GitHub Projects requires scopes. Run gh auth refresh --hostname ${host} -s project -s read:org -s repo.`)
  }
  if (/rate limit|secondary rate|http 429/.test(text)) {
    return projectError(env, 'rate_limited', 'GitHub rate limit is currently exhausted.')
  }
  if (/timed out|timeout|econnreset|enotfound|network|socket hang up|connection refused|http 5[0-9]{3}|server error/.test(text)) {
    return projectError(env, 'network_error', 'GitHub is unreachable right now. Check your connection and try again.')
  }
  if (/http 404|not found|could not resolve|does not exist/.test(text)) {
    return projectError(env, 'not_found', 'The requested GitHub project or work item was not found.')
  }
  if (/too large|too long|exceeds.*limit|maximum.*size/.test(text)) {
    return projectError(env, 'too_large', 'The requested GitHub project data exceeds the supported size limit.')
  }
  if (/field .* not found|could not resolve to a type|unknown field|schema/.test(text)) {
    return projectError(env, 'schema_drift', 'GitHub Projects returned an unsupported schema. Refresh and try again.')
  }
  if (/http 422|validation failed|unprocessable/.test(text)) {
    return projectError(env, 'validation_error', 'GitHub rejected the project request as invalid.')
  }
  return projectError(env, 'unknown', 'GitHub Projects operation failed.')
}

