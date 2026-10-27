import type { HostingEnv, Identity, RunOptions, Scope } from './env'
import {
  configuredRepositories,
  positiveInteger,
  record,
  scopeForRepository,
  safeErrorReason,
  utf8Length,
} from './item-data'
import { classifyProjectError, projectError } from './project-errors'

export type ProjectOwnerType = 'organization' | 'user'
export type ProjectReference = {
  host: string
  owner: string
  ownerType?: ProjectOwnerType
  number: number
  view?: string
}


function validHost(value: string): boolean {
  if (value.length === 0 || value.length > 255 || /[\s/@?#]/.test(value)) return false
  try {
    const parsed = new URL(`https://${value}`)
    return parsed.username.length === 0 && parsed.password.length === 0 && parsed.pathname === '/' && parsed.search.length === 0 && parsed.hash.length === 0 && parsed.host.toLowerCase() === value.toLowerCase()
  } catch {
    return false
  }
}

export function resolveProjectHost(env: HostingEnv, scope: Scope, hostValue: unknown): { host: string; identity: Identity } {
  const requested = hostValue === undefined ? scope.repository.host : hostValue
  if (typeof requested !== 'string' || !validHost(requested)) {
    throw env.invalid('validation_error', 'host must be a valid GitHub hostname.')
  }
  const identity = configuredRepositories(scope).find((candidate) => candidate.host.toLowerCase() === requested.toLowerCase())
  if (identity) return { host: identity.host, identity }
  if (requested.toLowerCase() === 'github.com') return { host: 'github.com', identity: { ...scope.origin, host: 'github.com' } }
  const host = requested.toLowerCase()
  return { host, identity: { ...scope.origin, host } }
}

async function requireAuthenticatedProjectHost(env: HostingEnv, scope: Scope, host: string): Promise<void> {
  if (host.toLowerCase() === 'github.com') return
  const accounts = await env.authAccounts({ ...scope, repository: scope.origin })
  if (accounts.some((account) => account.host.toLowerCase() === host.toLowerCase())) return
  throw projectError(env, 'auth_required', `GitHub CLI is not authenticated to ${host}. Run gh auth login --hostname ${host}.`)
}

export function projectScope(scope: Scope, identity: Identity): Scope {
  return scopeForRepository(scope, identity)
}

export async function parseProjectReference(
  env: HostingEnv,
  scope: Scope,
  inputValue: unknown,
  hostValue: unknown
): Promise<ProjectReference> {
  if (typeof inputValue !== 'string' || inputValue.length === 0 || utf8Length(inputValue) > 2048 || inputValue.trim() !== inputValue) {
    throw env.invalid('validation_error', 'input must be a project reference no longer than 2048 bytes.')
  }
  const isUrl = inputValue.startsWith('http://') || inputValue.startsWith('https://')
  let url: URL | null = null
  if (isUrl) {
    try {
      url = new URL(inputValue)
    } catch {
      throw env.invalid('validation_error', 'Project URL is invalid.')
    }
    if (url.protocol !== 'https:' || url.username.length > 0 || url.password.length > 0 || url.search.length > 0 || url.hash.length > 0) {
      throw env.invalid('validation_error', 'Project URL must be credential-free HTTPS without a query or fragment.')
    }
  }
  const configuredHost = await resolveProjectHost(env, scope, hostValue ?? url?.host)
  if (url) {
    if (url.host.toLowerCase() !== configuredHost.host.toLowerCase()) {
      throw env.invalid('validation_error', 'Project URL host must match the selected trusted GitHub host.')
    }
    const match = /^\/(orgs|users)\/([A-Za-z0-9-]+)\/projects\/([1-9][0-9]*)(?:\/views\/([A-Za-z0-9_-]+))?\/?$/.exec(url.pathname)
    if (!match) throw env.invalid('validation_error', 'Project URL must match /orgs/<owner>/projects/<number>[/views/<view>].')
    const number = positiveInteger(Number(match[3]))
    const owner = match[2]
    const ownerType = match[1] === 'orgs' ? 'organization' : 'user'
    if (number === null || owner === undefined) throw env.invalid('validation_error', 'Project URL has an invalid owner or number.')
    return { host: configuredHost.host, owner, ownerType, number, ...(match[4] === undefined ? {} : { view: match[4] }) }
  }
  const match = /^([A-Za-z0-9-]+)\/([1-9][0-9]*)$/.exec(inputValue)
  if (!match) throw env.invalid('validation_error', 'Project reference must be owner/number or a configured-host project URL.')
  const owner = match[1]
  const number = positiveInteger(Number(match[2]))
  if (owner === undefined || number === null) throw env.invalid('validation_error', 'Project reference has an invalid owner or number.')
  return { host: configuredHost.host, owner, number }
}

export async function projectGraphql(
  env: HostingEnv,
  scope: Scope,
  identity: Identity,
  query: string,
  variables: Record<string, unknown>,
  idempotent: boolean
): Promise<unknown> {
  await requireAuthenticatedProjectHost(env, scope, identity.host)
  try {
    const result = await env.graphql(projectScope(scope, identity), query, variables, {
      idempotent,
      ambient: true,
      projectHost: identity.host
    })
    const errors = record(result)?.errors
    if (Array.isArray(errors) && errors.length > 0) {
      const first = record(errors[0])
      const message = typeof first?.message === 'string' ? first.message : 'GitHub returned a Projects error.'
      throw new Error(message)
    }
    return result
  } catch (error: unknown) {
    const classified = classifyProjectError(env, error, identity.host)
    if (safeErrorReason(classified) === 'schema_drift') {
      const schemaField = query.includes('verticalGroupByFields')
        ? 'verticalGroupByFields'
        : query.includes('parent { number title url }')
          ? 'parent'
          : null
      if (schemaField !== null) {
        const existing = record(record(classified)?.data) ?? {}
        throw Object.assign(classified, { data: { ...existing, schemaField } })
      }
    }
    throw classified
  }
}

export async function projectRest(
  env: HostingEnv,
  scope: Scope,
  identity: Identity,
  path: string,
  method: string,
  fields?: Record<string, unknown>,
  options: RunOptions = {}
): Promise<unknown> {
  await requireAuthenticatedProjectHost(env, scope, identity.host)
  return env.rest(projectScope(scope, identity), path, method, fields, {
    ...options,
    ambient: true,
    projectHost: identity.host
  })
}
