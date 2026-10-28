import { randomUUID } from 'node:crypto'
import type { PluginCaller } from '@quirky/protocol'
import { CREATE_VIEW, REVIEW_VIEW, SETTINGS_VIEW, type CreationDefaults, type CreationState, type JsonRecord, type MethodSpec, type ReviewMethodTable, type ReviewsEnv } from '../contracts'
import { isRecord } from './guards'

const DEFAULTS: CreationDefaults = { draft: false, useTemplate: false, generateDetailsOnOpen: false, openAfterCreate: false }
const DEFAULT_KEYS = ['draft', 'useTemplate', 'generateDetailsOnOpen', 'openAfterCreate'] as const
const MAX_DIFF_FILES = 24
const MAX_DIFF_BYTES = 64 * 1024
const MAX_FILE_SIDE_BYTES = 12 * 1024
const MAX_GENERATED_BYTES = 64 * 1024

const objectSchema = (properties: JsonRecord, required: string[] = []): JsonRecord => ({
  type: 'object', properties, required, additionalProperties: false
})
const stringSchema: JsonRecord = { type: 'string' }
const worktreeSchema = { type: 'string', minLength: 1, description: 'Exact registered worktree id.' }
const defaultsSchema = objectSchema({
  draft: { type: 'boolean' },
  useTemplate: { type: 'boolean' },
  generateDetailsOnOpen: { type: 'boolean' },
  openAfterCreate: { type: 'boolean' }
}, [...DEFAULT_KEYS])
const defaultScopeSchema = { type: 'string', enum: ['global', 'repository'] }
const reviewSchema = objectSchema({
  number: { type: 'integer', minimum: 1 },
  url: { type: 'string', format: 'uri' },
  existing: { type: 'boolean' }
}, ['number', 'url'])
const accountSchema = objectSchema({
  host: stringSchema,
  user: stringSchema,
  source: { type: 'string', enum: ['keyring', 'env'] },
  active: { type: 'boolean' },
  bindable: { type: 'boolean' },
  scopes: { type: 'array', items: stringSchema }
}, ['host', 'user', 'source', 'active', 'scopes'])
const nullableAccountSchema = { oneOf: [accountSchema, { type: 'null' }] }
const configAccountSchema = {
  oneOf: [
    objectSchema({ host: stringSchema, user: stringSchema }, ['host', 'user']),
    { type: 'null' }
  ]
}
const hostingConfigurationSchema = objectSchema({
  worktreeId: stringSchema,
  issueSourcePreference: { type: 'string', enum: ['auto', 'origin', 'upstream'] },
  account: configAccountSchema
}, ['worktreeId', 'issueSourcePreference', 'account'])
const budgetBucketSchema = objectSchema({
  limit: { type: 'integer' },
  remaining: { type: 'integer' },
  resetAt: { type: 'number' }
}, ['limit', 'remaining', 'resetAt'])
const budgetSchema = objectSchema({
  core: budgetBucketSchema,
  search: budgetBucketSchema,
  graphql: budgetBucketSchema,
  fetchedAt: { type: 'number' }
}, ['core', 'search', 'graphql', 'fetchedAt'])


export const createSpecs: MethodSpec[] = [
  { id: 'createOpen', description: 'open the create-review view after refreshing eligibility for this exact worktree', params: objectSchema({ worktree: worktreeSchema }, ['worktree']), result: objectSchema({ worktree: stringSchema, opened: { type: 'boolean' }, stale: { type: 'boolean' }, existingReview: reviewSchema }, ['worktree', 'opened']) },
  { id: 'settingsOpen', description: 'open hosting settings scoped to the caller worktree when available', params: objectSchema({ worktree: worktreeSchema }), result: objectSchema({ opened: { type: 'boolean' }, worktree: stringSchema, error: stringSchema }, ['opened']) },
  { id: 'createDraft', description: 'update the session-owned create-review draft fields', params: objectSchema({ worktree: worktreeSchema, title: stringSchema, body: stringSchema, draft: { type: 'boolean' }, useTemplate: { type: 'boolean' } }, ['worktree']), result: objectSchema({ updated: { type: 'boolean' } }, ['updated']) },
  { id: 'createBases', readOnly: true, description: 'list remote Git branches available as review bases', params: objectSchema({ worktree: worktreeSchema, query: stringSchema }, ['worktree']), result: objectSchema({ bases: { type: 'array', items: stringSchema }, selected: stringSchema }, ['bases', 'selected']) },
  { id: 'createBase', description: 'select a remote base and refresh exact-context eligibility and stack capability', params: objectSchema({ worktree: worktreeSchema, base: stringSchema, stack: { type: 'boolean' } }, ['worktree', 'base']), result: objectSchema({ base: stringSchema, eligible: { type: 'boolean' }, stackSupported: { type: 'boolean' }, stackParentNumber: { type: 'integer', minimum: 1 }, stackEnabled: { type: 'boolean' } }, ['base', 'eligible', 'stackSupported', 'stackEnabled']) },
  { id: 'createGenerate', description: 'generate title and body from the selected worktree branch diff using a public agent', params: objectSchema({ worktree: worktreeSchema, agent: stringSchema }, ['worktree']), result: objectSchema({ generated: { type: 'boolean' }, title: stringSchema, body: stringSchema }, ['generated', 'title', 'body']) },
  { id: 'createCancelGenerate', description: 'cancel only the active review-details generation request', params: objectSchema({ worktree: worktreeSchema }, ['worktree']), result: objectSchema({ cancelled: { type: 'boolean' } }, ['cancelled']) },
  { id: 'createSubmit', description: 'recheck eligibility, push if required, create once, and link confirmed results', params: objectSchema({ worktree: worktreeSchema }, ['worktree']), result: objectSchema({ status: { type: 'string', enum: ['created', 'already_exists', 'partial'] }, review: reviewSchema, error: stringSchema }, ['status', 'review']) },
  { id: 'creationDefaults', readOnly: true, description: 'read global or repository creation defaults; scope explicitly selects global despite a caller worktree', params: objectSchema({ scope: defaultScopeSchema, worktree: worktreeSchema }), result: objectSchema({ scope: defaultScopeSchema, repoId: stringSchema, defaults: defaultsSchema, overrides: objectSchema({ draft: { type: 'boolean' }, useTemplate: { type: 'boolean' }, generateDetailsOnOpen: { type: 'boolean' }, openAfterCreate: { type: 'boolean' } }) }, ['scope', 'defaults']) },
  { id: 'setCreationDefaults', description: 'persist all four global or repository-scoped creation defaults', params: objectSchema({ scope: defaultScopeSchema, worktree: worktreeSchema, defaults: defaultsSchema }, ['defaults']), result: objectSchema({ scope: defaultScopeSchema, repoId: stringSchema, defaults: defaultsSchema }, ['scope', 'defaults']) },
  { id: 'resetCreationDefaults', description: 'reset global defaults to false or remove one repository override', params: objectSchema({ scope: defaultScopeSchema, worktree: worktreeSchema }), result: objectSchema({ scope: defaultScopeSchema, repoId: stringSchema, defaults: defaultsSchema }, ['scope', 'defaults']) },
  { id: 'hostingDiagnose', readOnly: true, description: 'read canonical GitHub CLI readiness and required scopes', params: objectSchema({ worktree: worktreeSchema }, ['worktree']), result: objectSchema({ ghAvailable: { type: 'boolean' }, activeAccount: nullableAccountSchema, accounts: { type: 'array', items: accountSchema }, envTokenInProcess: { type: 'boolean' }, missingScopes: { type: 'array', items: stringSchema }, requiredScopes: { type: 'array', items: stringSchema }, hasKeyringFallback: { type: 'boolean' }, requiredHost: stringSchema, requiredHostAuthenticated: { type: 'boolean' } }, ['ghAvailable', 'accounts', 'envTokenInProcess', 'missingScopes', 'requiredScopes', 'hasKeyringFallback', 'requiredHostAuthenticated']) },
  { id: 'hostingAccounts', readOnly: true, description: 'list canonical authenticated GitHub account identities and scopes', params: objectSchema({ worktree: worktreeSchema }, ['worktree']), result: objectSchema({ requiredHost: stringSchema, accounts: { type: 'array', items: accountSchema } }, ['accounts']) },
  { id: 'hostingConfiguration', readOnly: true, description: 'read canonical repository account binding without exposing credentials', params: objectSchema({ worktree: worktreeSchema }, ['worktree']), result: hostingConfigurationSchema },
  { id: 'hostingBudget', readOnly: true, description: 'read canonical host- and account-scoped GitHub API budget', params: objectSchema({ worktree: worktreeSchema, force: { type: 'boolean' } }, ['worktree']), result: budgetSchema },
  { id: 'hostingBindAccount', description: 'bind this repository to an existing keyring GitHub account; the hosting API fails closed', params: objectSchema({ worktree: worktreeSchema, host: stringSchema, user: stringSchema }, ['worktree', 'host', 'user']), result: hostingConfigurationSchema },
  { id: 'hostingUnbindAccount', description: 'clear this repository GitHub account binding to explicitly use ambient authentication', params: objectSchema({ worktree: worktreeSchema }, ['worktree']), result: hostingConfigurationSchema },
  { id: 'hostingSettingsRefresh', readOnly: true, description: 'refresh the daemon-owned hosting settings snapshot for an exact repository', params: objectSchema({ worktree: worktreeSchema, forceBudget: { type: 'boolean' } }, ['worktree']), result: objectSchema({ worktree: stringSchema, refreshed: { type: 'boolean' }, stale: { type: 'boolean' }, fetchedAt: { type: 'number' }, error: stringSchema }, ['worktree', 'refreshed', 'fetchedAt']) },
]

type Eligibility = JsonRecord & { eligible: boolean; defaultBase: string | null; head: string | null; blockers: Array<{ reason: string; nextAction: string; message: string }> }
type ReviewIdentity = { number: number; url: string; title?: string; body?: string; state?: string }
type StackInfo = { supported: boolean; parentNumber: number | null; error: string | null; enabled: boolean }
type ExactContext = { id: string; branch: string; head: string; repoId: string }


function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'The operation failed.'
}

function errorData(error: unknown): Record<string, unknown> | null {
  if (!isRecord(error) || !isRecord(error.data)) return null
  return error.data
}

function errorReason(error: unknown): string | null {
  const data = errorData(error)
  return data && typeof data.reason === 'string' ? data.reason : null
}
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function validAuthAccount(value: unknown): boolean {
  return isRecord(value) && typeof value.host === 'string' && typeof value.user === 'string' &&
    (value.source === 'keyring' || value.source === 'env') && typeof value.active === 'boolean' &&
    (value.bindable === undefined || typeof value.bindable === 'boolean') && isStringArray(value.scopes)
}
function parseHostingDiagnostics(env: ReviewsEnv, value: unknown): JsonRecord {
  if (!isRecord(value) || typeof value.ghAvailable !== 'boolean' || typeof value.requiredHostAuthenticated !== 'boolean' ||
    typeof value.envTokenInProcess !== 'boolean' || typeof value.hasKeyringFallback !== 'boolean' ||
    !isStringArray(value.missingScopes) || !isStringArray(value.requiredScopes) ||
    !Array.isArray(value.accounts) || !value.accounts.every(validAuthAccount) ||
    (value.activeAccount !== undefined && value.activeAccount !== null && !validAuthAccount(value.activeAccount)) ||
    (value.requiredHost !== undefined && typeof value.requiredHost !== 'string')) {
    throw env.invalid('invalid_response', 'GitHub diagnostics returned an invalid response.')
  }
  return value
}

function parseHostingAccounts(env: ReviewsEnv, value: unknown): JsonRecord {
  if (!isRecord(value) || !Array.isArray(value.accounts) ||
    !value.accounts.every((account) => validAuthAccount(account) && isRecord(account) && typeof account.bindable === 'boolean') ||
    (value.requiredHost !== undefined && typeof value.requiredHost !== 'string')) {
    throw env.invalid('invalid_response', 'GitHub accounts returned an invalid response.')
  }
  return value
}

function parseHostingConfiguration(env: ReviewsEnv, value: unknown): JsonRecord {
  if (!isRecord(value) || typeof value.worktreeId !== 'string' ||
    (value.issueSourcePreference !== 'auto' && value.issueSourcePreference !== 'origin' && value.issueSourcePreference !== 'upstream') ||
    (value.account !== null && (!isRecord(value.account) || typeof value.account.host !== 'string' || typeof value.account.user !== 'string'))) {
    throw env.invalid('invalid_response', 'GitHub returned an invalid repository configuration.')
  }
  return value
}

function parseHostingBudget(env: ReviewsEnv, value: unknown): JsonRecord {
  if (!isRecord(value) || !Number.isFinite(value.fetchedAt)) throw env.invalid('invalid_response', 'GitHub returned an invalid API budget.')
  for (const bucketName of ['core', 'search', 'graphql']) {
    const bucket = value[bucketName]
    if (!isRecord(bucket) || !Number.isFinite(bucket.limit) || !Number.isFinite(bucket.remaining) || !Number.isFinite(bucket.resetAt)) {
      throw env.invalid('invalid_response', `GitHub returned an invalid ${bucketName} API budget.`)
    }
  }
  return value
}
type SettingsField = 'diagnostics' | 'accounts' | 'configuration' | 'budget'
type SettingsErrorField = SettingsField | 'context'
type SettingsRead = { worktree: string; generation: number; field: SettingsField; sequence: number }
type SettingsReadResult = { value: JsonRecord } | { error: unknown }
type SettingsTracker = {
  worktree: string | null
  generation: number
  pending: number
  sequence: number
  latest: Map<SettingsField, number>
  errors: Map<SettingsErrorField, string>
}

const settingsTrackers = new WeakMap<ReviewsEnv, SettingsTracker>()

function createSettingsTracker(worktree: string | null, generation: number, error: string | null = null): SettingsTracker {
  const errors = new Map<SettingsErrorField, string>()
  if (error) errors.set('context', error)
  return { worktree, generation, pending: 0, sequence: 0, latest: new Map(), errors }
}

function settingsTracker(env: ReviewsEnv, worktree: string, generation: number): SettingsTracker {
  const current = settingsTrackers.get(env)
  if (current?.worktree === worktree && current.generation === generation) return current
  const snapshot = env.read().settings
  const error = snapshot.worktree === worktree && snapshot.generation === generation ? snapshot.error : null
  const tracker = createSettingsTracker(worktree, generation, error)
  settingsTrackers.set(env, tracker)
  return tracker
}

function setSettingsTarget(env: ReviewsEnv, worktree: string | null, error: string | null = null): number {
  let generation = 0
  let nextError: string | null = null
  env.update((state) => {
    const previous = state.settings
    const sameWorktree = previous.worktree === worktree
    generation = previous.generation + 1
    nextError = error ?? (sameWorktree ? previous.error : null)
    state.settings = {
      worktree,
      generation,
      loading: false,
      error: nextError,
      diagnostics: sameWorktree ? previous.diagnostics : null,
      accounts: sameWorktree ? previous.accounts : null,
      configuration: sameWorktree ? previous.configuration : null,
      budget: sameWorktree ? previous.budget : null,
      fetchedAt: sameWorktree ? previous.fetchedAt : 0
    }
  })
  settingsTrackers.set(env, createSettingsTracker(worktree, generation, nextError))
  return generation
}

function beginSettingsRefresh(env: ReviewsEnv, worktree: string): number {
  let generation = 0
  env.update((state) => {
    const current = state.settings
    generation = current.generation + 1
    if (current.worktree !== worktree) {
      state.settings = {
        worktree,
        generation,
        loading: true,
        error: null,
        diagnostics: null,
        accounts: null,
        configuration: null,
        budget: null,
        fetchedAt: 0
      }
      return
    }
    current.generation = generation
    current.loading = true
    current.error = null
  })
  settingsTrackers.set(env, createSettingsTracker(worktree, generation))
  return generation
}

function settingsGeneration(env: ReviewsEnv, worktree: string): number | null {
  const settings = env.read().settings
  return settings.worktree === worktree ? settings.generation : null
}

function beginSettingsReadAtGeneration(env: ReviewsEnv, worktree: string, generation: number, field: SettingsField): SettingsRead {
  const snapshot = env.read().settings
  if (snapshot.worktree !== worktree || snapshot.generation !== generation) {
    throw env.invalid('stale_target', 'The hosting settings context changed before the observation began.')
  }
  const tracker = settingsTracker(env, worktree, generation)
  const sequence = ++tracker.sequence
  tracker.pending += 1
  tracker.latest.set(field, sequence)
  env.update((state) => {
    if (state.settings.worktree === worktree && state.settings.generation === generation) state.settings.loading = true
  })
  return { worktree, generation, field, sequence }
}

function beginSettingsRead(env: ReviewsEnv, worktree: string, field: SettingsField): SettingsRead {
  if (env.read().settings.worktree !== worktree) setSettingsTarget(env, worktree)
  const generation = settingsGeneration(env, worktree)
  if (generation === null) throw env.invalid('stale_target', 'The hosting settings context changed before the observation began.')
  return beginSettingsReadAtGeneration(env, worktree, generation, field)
}

function completeSettingsRead(env: ReviewsEnv, request: SettingsRead, result: SettingsReadResult, label: string): void {
  const tracker = settingsTrackers.get(env)
  if (!tracker || tracker.worktree !== request.worktree || tracker.generation !== request.generation) return
  tracker.pending = Math.max(0, tracker.pending - 1)
  const isLatest = tracker.latest.get(request.field) === request.sequence
  if (isLatest && 'value' in result) tracker.errors.delete(request.field)
  else if (isLatest && 'error' in result) tracker.errors.set(request.field, `${label}: ${errorText(result.error)}`)
  env.update((state) => {
    if (state.settings.worktree !== request.worktree || state.settings.generation !== request.generation) return
    if (isLatest && 'value' in result) {
      state.settings[request.field] = result.value
      state.settings.fetchedAt = Date.now()
    }
    state.settings.loading = tracker.pending > 0
    state.settings.error = [...tracker.errors.values()].join(' ') || null
  })
}

async function readSettingsField(
  env: ReviewsEnv,
  worktree: string,
  field: SettingsField,
  label: string,
  read: () => Promise<unknown>,
  parse: (env: ReviewsEnv, value: unknown) => JsonRecord
): Promise<JsonRecord> {
  const request = beginSettingsRead(env, worktree, field)
  try {
    const value = parse(env, await read())
    completeSettingsRead(env, request, { value }, label)
    return value
  } catch (error) {
    completeSettingsRead(env, request, { error }, label)
    throw error
  }
}

function settingsContextError(env: ReviewsEnv, worktree: string, generation: number, error: string): void {
  if (settingsGeneration(env, worktree) !== generation) return
  setSettingsTarget(env, worktree, `Worktree context: ${error}`)
}

function currentSettingsResult(env: ReviewsEnv, worktree: string): { fetchedAt: number; error: string | null } {
  const settings = env.read().settings
  return settings.worktree === worktree ? { fetchedAt: settings.fetchedAt, error: settings.error } : { fetchedAt: 0, error: null }
}

function settledRead(result: PromiseSettledResult<unknown>, env: ReviewsEnv, parse: (env: ReviewsEnv, value: unknown) => JsonRecord): SettingsReadResult {
  if (result.status === 'rejected') return { error: result.reason }
  try {
    return { value: parse(env, result.value) }
  } catch (error) {
    return { error }
  }
}


function completeSettingsRefresh(
  env: ReviewsEnv,
  requests: SettingsRead[],
  results: PromiseSettledResult<unknown>[],
  parsers: Array<(env: ReviewsEnv, value: unknown) => JsonRecord>,
  labels: string[]
): void {
  requests.forEach((request, index) => {
    const result = results[index]
    const parse = parsers[index]
    const label = labels[index]
    if (!result || !parse || !label) {
      completeSettingsRead(env, request, { error: new Error(`${label ?? 'Hosting settings'} returned no observation.`) }, label ?? 'Hosting settings')
      return
    }
    completeSettingsRead(env, request, settledRead(result, env, parse), label)
  })
}


function requiredString(env: ReviewsEnv, value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) {
    throw env.invalid('validation_error', `${name} must be a non-empty string.`)
  }
  return value.trim()
}

function optionalString(env: ReviewsEnv, params: Record<string, unknown>, key: string): string | undefined {
  if (!Object.hasOwn(params, key)) return undefined
  if (typeof params[key] !== 'string' || (params[key] as string).includes('\0')) {
    throw env.invalid('validation_error', `${key} must be a string.`)
  }
  return (params[key] as string)
}

function optionalBoolean(env: ReviewsEnv, params: Record<string, unknown>, key: string): boolean | undefined {
  if (!Object.hasOwn(params, key)) return undefined
  if (typeof params[key] !== 'boolean') throw env.invalid('validation_error', `${key} must be a boolean.`)
  return params[key] as boolean
}
function creationDefaultsScope(env: ReviewsEnv, params: Record<string, unknown>): { scope: 'global' | 'repository'; selector?: string } {
  const requested = optionalString(env, params, 'scope')
  if (requested !== undefined && requested !== 'global' && requested !== 'repository') {
    throw env.invalid('validation_error', 'scope must be global or repository.')
  }
  const selector = optionalString(env, params, 'worktree')
  const scope = requested ?? (selector === undefined ? 'global' : 'repository')
  if (scope === 'repository' && selector === undefined) {
    throw env.invalid('validation_error', 'A worktree is required for repository-scoped creation defaults.')
  }
  return { scope, ...(selector === undefined ? {} : { selector }) }
}

function getExactDefaults(env: ReviewsEnv, repoId?: string): { scope: 'global' | 'repository'; defaults: CreationDefaults; overrides?: Partial<CreationDefaults> } {
  const state = env.read()
  const overrides = repoId ? state.repoDefaults[repoId] : undefined
  if (!repoId || !overrides) return { scope: repoId ? 'repository' : 'global', defaults: { ...state.defaults }, ...(overrides ? { overrides } : {}) }
  return { scope: 'repository', defaults: { ...state.defaults, ...overrides }, overrides: { ...overrides } }
}

function parseDefaults(env: ReviewsEnv, value: unknown): CreationDefaults {
  if (!isRecord(value) || DEFAULT_KEYS.some((key) => typeof value[key] !== 'boolean')) {
    throw env.invalid('validation_error', 'defaults must contain all four creation booleans.')
  }
  if (Object.keys(value).some((key) => !(DEFAULT_KEYS as readonly string[]).includes(key))) {
    throw env.invalid('validation_error', 'defaults contains an unsupported setting.')
  }
  return {
    draft: value.draft as boolean,
    useTemplate: value.useTemplate as boolean,
    generateDetailsOnOpen: value.generateDetailsOnOpen as boolean,
    openAfterCreate: value.openAfterCreate as boolean
  }
}

function parseBranchRefs(env: ReviewsEnv, value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.refs) || (value.current !== null && typeof value.current !== 'string')) {
    throw env.invalid('invalid_response', 'Git returned an invalid branch list.')
  }
  const names = new Set<string>()
  for (const item of value.refs) {
    if (!isRecord(item) || typeof item.name !== 'string' || (item.kind !== 'local' && item.kind !== 'remote')) {
      throw env.invalid('invalid_response', 'Git returned an invalid branch reference.')
    }
    if (item.kind !== 'remote') continue
    const slash = item.name.indexOf('/')
    if (slash <= 0 || slash === item.name.length - 1) continue
    names.add(item.name.slice(slash + 1))
  }
  return [...names].sort((left, right) => left.localeCompare(right))
}

function parseEligibility(env: ReviewsEnv, value: unknown, worktree: ExactContext, confirmedAt = Date.now()): Eligibility {
  if (!isRecord(value) || typeof value.eligible !== 'boolean' || (value.defaultBase !== null && typeof value.defaultBase !== 'string') ||
    (value.head !== null && typeof value.head !== 'string') || typeof value.title !== 'string' || typeof value.body !== 'string' ||
    !Array.isArray(value.blockers)) {
    throw env.invalid('invalid_response', 'Hosting returned an invalid pull-request eligibility response.')
  }
  const blockers: Array<{ reason: string; nextAction: string; message: string }> = []
  for (const item of value.blockers) {
    if (!isRecord(item) || typeof item.reason !== 'string' || typeof item.nextAction !== 'string' || typeof item.message !== 'string') {
      throw env.invalid('invalid_response', 'Hosting returned an invalid eligibility blocker.')
    }
    blockers.push({ reason: item.reason, nextAction: item.nextAction, message: item.message })
  }
  if (value.head !== worktree.branch) throw env.invalid('head_changed', 'The current branch changed while review eligibility was being checked.')
  return {
    ...value,
    blockers,
    confirmedAt,
    worktreeId: worktree.id,
    headOid: worktree.head
  } as Eligibility
}

function eligibilityBlocker(value: Eligibility): { reason: string; message: string } | null {
  const first = value.blockers[0]
  if (!first) return null
  return { reason: first.reason, message: first.message }
}

function parseMinimalReview(value: unknown): ReviewIdentity | null {
  if (!isRecord(value) || !Number.isSafeInteger(value.number) || (value.number as number) < 1 || typeof value.url !== 'string') return null
  let url: URL
  try {
    url = new URL(value.url)
  } catch {
    return null
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username !== '' || url.password !== '') return null
  return {
    number: value.number as number,
    url: url.toString(),
    ...(typeof value.title === 'string' ? { title: value.title } : {}),
    ...(typeof value.body === 'string' ? { body: value.body } : {}),
    ...(typeof value.state === 'string' ? { state: value.state } : {})
  }
}
function parseReviewLookup(env: ReviewsEnv, value: unknown): { kind: 'found'; review: ReviewIdentity & { headRefName: string; state: string } } | { kind: 'none' } | { kind: 'unavailable'; message: string } {
  if (!isRecord(value) || typeof value.kind !== 'string' || !Number.isFinite(value.fetchedAt)) throw env.invalid('invalid_response', 'Hosting returned an invalid branch review lookup.')
  if (value.kind === 'no-review') return { kind: 'none' }
  if (value.kind === 'unavailable') return { kind: 'unavailable', message: typeof value.message === 'string' ? value.message : 'The branch review lookup is unavailable.' }
  if (value.kind !== 'found') throw env.invalid('invalid_response', 'Hosting returned an unknown branch review lookup state.')
  const review = parseMinimalReview(value.review)
  if (!review || !isRecord(value.review) || typeof value.review.headRefName !== 'string' || typeof value.review.state !== 'string') {
    throw env.invalid('invalid_response', 'Hosting returned an invalid pull request identity.')
  }
  return { kind: 'found', review: { ...review, headRefName: value.review.headRefName, state: value.review.state } }
}

function parseStackInfo(env: ReviewsEnv, value: unknown, base: string): StackInfo {
  if (!isRecord(value) || typeof value.stackSupported !== 'boolean' || (value.stackParentNumber !== null &&
    (!Number.isSafeInteger(value.stackParentNumber) || (value.stackParentNumber as number) < 1)) ||
    (value.stackLookupError !== null && typeof value.stackLookupError !== 'string')) {
    throw env.invalid('invalid_response', 'The stack-capability response is invalid.')
  }
  const parentNumber = value.stackParentNumber as number | null
  return {
    supported: value.stackSupported,
    parentNumber,
    error: value.stackLookupError,
    enabled: value.stackEnabled === true && parentNumber !== null && base.length > 0
  }
}

async function resolveContext(env: ReviewsEnv, params: Record<string, unknown>, caller: PluginCaller): Promise<ExactContext> {
  const selector = requiredString(env, params.worktree, 'worktree')
  const worktree = await env.resolve({ worktree: selector }, caller)
  if (worktree.id !== selector) throw env.invalid('stale_target', 'The selected worktree context changed before review creation.')
  if (worktree.kind !== 'git' || typeof worktree.branch !== 'string' || worktree.branch.trim() === '' || typeof worktree.head !== 'string' || worktree.head.trim() === '') {
    throw env.invalid('detached_head', 'A checked-out Git branch with a commit is required for pull-request creation.')
  }
  return { id: worktree.id, branch: worktree.branch, head: worktree.head, repoId: worktree.repoId }
}
async function ensureExactHead(env: ReviewsEnv, worktree: ExactContext, caller: PluginCaller): Promise<void> {
  const current = await env.resolve({ worktree: worktree.id }, caller)
  if (current.id !== worktree.id || current.branch !== worktree.branch || current.head !== worktree.head) {
    throw env.invalid('head_changed', 'The worktree branch or head changed. Reopen review creation for the current context.')
  }
}
async function resolveRepoContext(env: ReviewsEnv, params: Record<string, unknown>, caller: PluginCaller): Promise<{ id: string; repoId: string }> {
  const selector = requiredString(env, params.worktree, 'worktree')
  const worktree = await env.resolve({ worktree: selector }, caller)
  if (worktree.id !== selector) throw env.invalid('stale_target', 'The selected repository context changed before hosting settings could load.')
  if (worktree.kind !== 'git') throw env.invalid('not_git_worktree', 'Hosting settings require a registered Git worktree.')
  return { id: worktree.id, repoId: worktree.repoId }
}

function assertCurrent(env: ReviewsEnv, worktree: ExactContext, generation?: number): CreationState {
  const creation = env.read().creation
  if (creation.worktree !== worktree.id || (generation !== undefined && creation.generation !== generation)) {
    throw env.invalid('stale_target', 'The create-review context changed. Reopen it for the selected worktree.')
  }
  const confirmedHead = creation.eligibility?.headOid
  if (creation.head !== worktree.branch || confirmedHead !== worktree.head) {
    throw env.invalid('head_changed', 'The worktree head changed. Refresh creation eligibility before continuing.')
  }
  return creation
}

function isCurrent(env: ReviewsEnv, worktree: ExactContext, generation: number, requestId?: string): boolean {
  const creation = env.read().creation
  return creation.worktree === worktree.id && creation.generation === generation &&
    (requestId === undefined || creation.requestId === requestId)
}

async function readEligibility(env: ReviewsEnv, worktree: ExactContext, base?: string, title?: string): Promise<Eligibility> {
  const params = {
    worktree: worktree.id,
    ...(base === undefined ? {} : { base }),
    head: worktree.branch,
    ...(title === undefined ? {} : { title })
  }
  return parseEligibility(env, await env.call('quirky.hosting/creationEligibility', params), worktree)
}

async function readBases(env: ReviewsEnv, worktree: ExactContext, query = ''): Promise<string[]> {
  return parseBranchRefs(env, await env.call('quirky.git/branches', { worktree: worktree.id, query }))
}

async function stackInfo(env: ReviewsEnv, worktree: ExactContext, base: string, current?: boolean): Promise<StackInfo> {
  let supported = false
  let parentNumber: number | null = null
  let lookupError: string | null = null
  try {
    const repository = await env.call('quirky.hosting/repository', { worktree: worktree.id })
    if (!isRecord(repository) || !isRecord(repository.origin) || typeof repository.origin.host !== 'string') {
      throw env.invalid('invalid_response', 'Hosting returned an invalid repository identity.')
    }
    supported = repository.origin.host.toLowerCase() === 'github.com'
    if (supported && base !== '') {
      const lookup = parseReviewLookup(env, await env.call('quirky.hosting/forBranch', { worktree: worktree.id, branch: base }))
      if (lookup.kind === 'unavailable') lookupError = lookup.message
      else if (lookup.kind === 'found' && lookup.review.headRefName === base && (lookup.review.state === 'open' || lookup.review.state === 'draft')) {
        parentNumber = lookup.review.number
      }
    }
  } catch (error) {
    lookupError = errorText(error)
  }
  return {
    supported,
    parentNumber,
    error: lookupError,
    enabled: current ?? parentNumber !== null
  }
}

function eligibilityWithStack(eligibility: Eligibility, stack: StackInfo): JsonRecord {
  return {
    ...eligibility,
    stackSupported: stack.supported,
    stackParentNumber: stack.parentNumber,
    stackLookupError: stack.error,
    stackEnabled: stack.enabled && stack.parentNumber !== null
  }
}

function toJsonDefaults(value: CreationDefaults): JsonRecord {
  return { draft: value.draft, useTemplate: value.useTemplate, generateDetailsOnOpen: value.generateDetailsOnOpen, openAfterCreate: value.openAfterCreate }
}

function truncateUtf8(value: string, byteLimit: number): string {
  const encoded = new TextEncoder().encode(value)
  if (encoded.byteLength <= byteLimit) return value
  let end = byteLimit
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end -= 1
  return `${new TextDecoder().decode(encoded.slice(0, end))}\n[truncated at the configured context bound]`
}

function generatedDetails(env: ReviewsEnv, value: unknown): { title: string; body: string } {
  if (!isRecord(value) || typeof value.text !== 'string') throw env.invalid('invalid_response', 'The agent returned an invalid generation response.')
  if (new TextEncoder().encode(value.text).byteLength > MAX_GENERATED_BYTES) throw env.invalid('output_limit', 'Generated review details exceeded the 64 KiB output limit.')
  let parsed: unknown
  try {
    parsed = JSON.parse(value.text)
  } catch {
    throw env.invalid('invalid_response', 'The agent response must be one JSON object with title and body strings.')
  }
  if (!isRecord(parsed) || typeof parsed.title !== 'string' || parsed.title.trim() === '' || typeof parsed.body !== 'string') {
    throw env.invalid('invalid_response', 'The agent response must contain a non-empty title and a body string.')
  }
  return { title: parsed.title.trim(), body: parsed.body }
}

async function chooseAgent(env: ReviewsEnv, requested?: string): Promise<string> {
  if (requested !== undefined) return requiredString(env, requested, 'agent')
  const catalog = await env.call('quirky.agents/list', {})
  if (!isRecord(catalog) || !Array.isArray(catalog.agents)) throw env.invalid('invalid_response', 'The agent catalog returned an invalid response.')
  const agents = catalog.agents.filter((value): value is Record<string, unknown> => isRecord(value) &&
    typeof value.id === 'string' && value.installed === true && value.enabled === true)
  const defaultAgent = typeof catalog.defaultAgent === 'string' ? catalog.defaultAgent : null
  const preferred = defaultAgent ? agents.find((agent) => agent.id === defaultAgent) : undefined
  const selected = preferred ?? agents.find((agent) => agent.isDefault === true) ?? agents[0]
  if (!selected || typeof selected.id !== 'string') throw env.invalid('agent_unavailable', 'No enabled one-shot agent is available for review detail generation.')
  return selected.id
}

async function branchDiffContext(env: ReviewsEnv, worktree: ExactContext, base: string, caller: PluginCaller): Promise<string> {
  const compare = await env.call('quirky.git/compare', { worktree: worktree.id, base })
  if (!isRecord(compare) || compare.status !== 'ready' || compare.headOid !== worktree.head || typeof compare.mergeBase !== 'string' || !Array.isArray(compare.entries)) {
    throw env.invalid('diff_unavailable', isRecord(compare) && typeof compare.message === 'string' ? compare.message : 'Could not load the exact branch diff for this worktree.')
  }
  const changes: Array<{ path: string; status: string }> = []
  for (const value of compare.entries) {
    if (!isRecord(value) || typeof value.path !== 'string' || typeof value.status !== 'string') {
      throw env.invalid('invalid_response', 'Git returned an invalid branch diff entry.')
    }
    changes.push({ path: value.path, status: value.status })
  }
  if (changes.length === 0) throw env.invalid('no_changes', 'This branch has no committed changes to summarize.')
  let context = `Worktree ${worktree.id}; branch ${worktree.branch}; base ${base}; head ${worktree.head}; merge-base ${compare.mergeBase}.\n`
  let included = 0
  for (const change of changes.slice(0, MAX_DIFF_FILES)) {
    if (new TextEncoder().encode(context).byteLength >= MAX_DIFF_BYTES) break
    const value = await env.call('quirky.git/diff', {
      worktree: worktree.id,
      path: change.path,
      source: 'branch',
      mergeBase: compare.mergeBase,
      head: worktree.head
    })
    if (!isRecord(value) || value.path !== change.path || value.source !== 'branch' || typeof value.binary !== 'boolean' ||
      typeof value.original !== 'string' || typeof value.modified !== 'string') {
      throw env.invalid('invalid_response', `Git returned an invalid branch diff for ${change.path}.`)
    }
    const remaining = Math.max(0, MAX_DIFF_BYTES - new TextEncoder().encode(context).byteLength)
    const header = `\n### ${change.status}: ${change.path}\n`
    if (value.binary) {
      context += truncateUtf8(header + '[binary file; content omitted]\n', remaining)
    } else if (isRecord(value.tooLarge)) {
      context += truncateUtf8(header + '[file diff exceeds the public diff size bound]\n', remaining)
    } else {
      const sideBudget = Math.min(MAX_FILE_SIDE_BYTES, Math.floor(remaining / 2))
      const sides = `BASE:\n${truncateUtf8(value.original, sideBudget)}\nHEAD:\n${truncateUtf8(value.modified, sideBudget)}\n`
      context += truncateUtf8(header + sides, remaining)
    }
    included += 1
  }
  if (changes.length > included) context += `\n[${changes.length - included} additional changed file(s) omitted by the context bound]\n`
  await ensureExactHead(env, worktree, caller)
  return truncateUtf8(context, MAX_DIFF_BYTES)
}

async function runGeneration(
  env: ReviewsEnv,
  worktree: ExactContext,
  generation: number,
  caller: PluginCaller,
  requestedAgent?: string,
  allowDuringSubmit = false
): Promise<{ title: string; body: string }> {
  const initial = assertCurrent(env, worktree, generation)
  if (initial.submitting && !allowDuringSubmit) throw env.invalid('conflict', 'Review creation is already being submitted.')
  const requestId = randomUUID()
  env.update((state) => {
    if (state.creation.generation !== generation || state.creation.worktree !== worktree.id) return
    state.creation.generating = true
    state.creation.requestId = requestId
    state.creation.generated = false
    state.creation.error = null
  })
  try {
    const current = assertCurrent(env, worktree, generation)
    const context = await branchDiffContext(env, worktree, current.base, caller)
    if (!isCurrent(env, worktree, generation, requestId)) throw env.invalid('cancelled', 'Generation was stopped.')
    const agent = await chooseAgent(env, requestedAgent)
    await ensureExactHead(env, worktree, caller)
    if (!isCurrent(env, worktree, generation, requestId)) throw env.invalid('cancelled', 'Generation was stopped.')
    const prompt = [
      'Write a concise pull request title and description from the exact branch diff below.',
      'Return only one JSON object: {"title":"...","body":"..."}. Do not add Markdown fences or commentary.',
      `Current title draft: ${current.title}`,
      `Current body draft:\n${current.body}`,
      'Branch diff context follows verbatim.',
      context
    ].join('\n\n')
    const response = await env.call('quirky.agents/generate', {
      agent, prompt, worktree: worktree.id, requestId, timeoutMs: 60_000
    })
    const details = generatedDetails(env, response)
    const latest = await env.resolve({ worktree: worktree.id }, caller)
    if (latest.id !== worktree.id || latest.branch !== worktree.branch || latest.head !== worktree.head || !isCurrent(env, worktree, generation, requestId)) {
      throw env.invalid('head_changed', 'The worktree or generation request changed before the agent response arrived.')
    }
    env.update((state) => {
      if (state.creation.generation !== generation || state.creation.worktree !== worktree.id || state.creation.requestId !== requestId) return
      state.creation.title = details.title
      state.creation.body = details.body
      state.creation.generating = false
      state.creation.requestId = null
      state.creation.generated = true
      state.creation.error = null
    })
    return details
  } catch (error) {
    if (isCurrent(env, worktree, generation, requestId)) {
      env.update((state) => {
        if (state.creation.generation !== generation || state.creation.worktree !== worktree.id || state.creation.requestId !== requestId) return
        state.creation.generating = false
        state.creation.requestId = null
        state.creation.error = errorText(error)
      })
    }
    throw error
  }
}

function reviewFromEligibility(eligibility: Eligibility): ReviewIdentity | null {
  return parseMinimalReview(eligibility.review)
}

async function publishReview(
  env: ReviewsEnv,
  worktree: ExactContext,
  generation: number,
  review: ReviewIdentity,
  status: 'created' | 'already_exists' | 'partial',
  error?: string
): Promise<Record<string, unknown>> {
  if (!isCurrent(env, worktree, generation)) throw env.invalid('stale_target', 'The create-review context changed before the result could be linked.')
  const result: JsonRecord = {
    status,
    review: { number: review.number, url: review.url, ...(status === 'already_exists' ? { existing: true } : {}) },
    ...(error === undefined ? {} : { error })
  }
  env.update((state) => {
    if (state.creation.generation !== generation || state.creation.worktree !== worktree.id) return
    state.links[worktree.id] = { number: review.number, url: review.url }
    state.creation.result = result
    state.creation.error = error ?? null
    state.creation.submitting = false
  })
  const current = env.read().creation
  const defaults = getExactDefaults(env, worktree.repoId).defaults
  if (defaults.openAfterCreate) {
    try {
      await env.openView(REVIEW_VIEW, { worktree: worktree.id, number: review.number, tab: 'conversation' })
    } catch (openError) {
      const openMessage = `Pull request #${review.number} was linked, but could not be opened: ${errorText(openError)}`
      env.update((state) => {
        if (state.creation.generation !== generation || state.creation.worktree !== worktree.id) return
        state.creation.error = error === undefined ? openMessage : `${error} ${openMessage}`
        if (state.creation.result) state.creation.result = { ...state.creation.result, openError: errorText(openError) }
      })
      return { ...result, openError: errorText(openError) }
    }
  }
  if (current.generation !== generation) throw env.invalid('stale_target', 'The create-review context changed after the result was linked.')
  return result
}

async function openReviewForIdentity(env: ReviewsEnv, worktree: ExactContext, review: ReviewIdentity): Promise<void> {
  env.update((state) => {
    state.links[worktree.id] = { number: review.number, url: review.url }
    state.creation.result = { status: 'already_exists', review: { number: review.number, url: review.url, existing: true } }
    state.creation.error = `Pull request #${review.number} already exists for this branch.`
    state.creation.loading = false
  })
  await env.openView(REVIEW_VIEW, { worktree: worktree.id, number: review.number, tab: 'conversation' })
}

function generationMatches(env: ReviewsEnv, worktree: ExactContext, generation: number, head: string, headOid: string): boolean {
  const creation = env.read().creation
  return creation.worktree === worktree.id && creation.generation === generation && creation.head === head &&
    (creation.eligibility === null || creation.eligibility.headOid === headOid)
}


async function freshStackParent(env: ReviewsEnv, worktree: ExactContext, base: string, expected: StackInfo): Promise<number | null> {
  if (!expected.supported || !expected.enabled || expected.parentNumber === null) return null
  const lookup = parseReviewLookup(env, await env.call('quirky.hosting/forBranch', { worktree: worktree.id, branch: base }))
  if (lookup.kind === 'unavailable') throw env.invalid('lookup_unavailable', lookup.message)
  if (lookup.kind !== 'found' || lookup.review.number !== expected.parentNumber || lookup.review.headRefName !== base ||
    (lookup.review.state !== 'open' && lookup.review.state !== 'draft')) {
    throw env.invalid('stack_parent_changed', 'The selected stack parent changed. Refresh the base branch before creating this pull request.')
  }
  return lookup.review.number
}

function applyError(env: ReviewsEnv, worktree: ExactContext, generation: number, error: unknown, field: 'submitting' | 'generating' = 'submitting'): void {
  env.update((state) => {
    if (state.creation.generation !== generation || state.creation.worktree !== worktree.id) return
    state.creation[field] = false
    if (field === 'generating') state.creation.requestId = null
    state.creation.error = errorText(error)
  })
}

export function createMethods(env: ReviewsEnv): ReviewMethodTable {
  let openSequence = 0
  let generationSequence = env.read().creation.generation

  const createOpen = async (params: Record<string, unknown>, caller: PluginCaller) => {
    const selector = requiredString(env, params.worktree, 'worktree')
    const sequence = ++openSequence
    const worktree = await resolveContext(env, { worktree: selector }, caller)
    if (sequence !== openSequence) return { worktree: worktree.id, opened: false, stale: true }
    let previous = env.read().creation
    if (previous.requestId !== null) {
      const cancellation = await env.call('quirky.agents/cancelGenerate', { requestId: previous.requestId })
      if (!isRecord(cancellation) || typeof cancellation.cancelled !== 'boolean') {
        throw env.invalid('invalid_response', 'The agent service returned an invalid cancellation response.')
      }
    }
    previous = env.read().creation
    const sameWorktree = previous.worktree === worktree.id
    const sameHead = sameWorktree && previous.head === worktree.branch && previous.eligibility?.headOid === worktree.head
    const generation = ++generationSequence
    const defaults = getExactDefaults(env, worktree.repoId).defaults
    env.update((state) => {
      const prior = state.creation
      state.creation = {
        ...prior,
        worktree: worktree.id,
        generation,
        loading: true,
        error: null,
        eligibility: null,
        title: sameWorktree ? prior.title : '',
        body: sameWorktree ? prior.body : '',
        base: sameWorktree ? prior.base : '',
        head: worktree.branch,
        draft: sameWorktree && prior.draft !== prior.defaults.draft ? prior.draft : defaults.draft,
        useTemplate: sameWorktree && prior.useTemplate !== prior.defaults.useTemplate ? prior.useTemplate : defaults.useTemplate,
        bases: [],
        generating: false,
        requestId: null,
        submitting: false,
        generated: sameHead ? prior.generated : false,
        result: null,
        defaults
      }
    })
    try {
      const [rawEligibility, bases] = await Promise.all([
        env.call('quirky.hosting/creationEligibility', { worktree: worktree.id, head: worktree.branch }),
        readBases(env, worktree)
      ])
      if (sequence !== openSequence || !generationMatches(env, worktree, generation, worktree.branch, worktree.head)) {
        return { worktree: worktree.id, opened: false, stale: true }
      }
      let eligibility = parseEligibility(env, rawEligibility, worktree)
      const defaultBase = eligibility.defaultBase ?? ''
      const selectedBase = sameWorktree && previous.base !== '' && bases.includes(previous.base) ? previous.base : defaultBase
      const title = sameWorktree && previous.title.trim() !== '' ? previous.title : eligibility.title
      const body = sameWorktree && previous.body !== '' ? previous.body : eligibility.body
      if (selectedBase !== defaultBase) eligibility = await readEligibility(env, worktree, selectedBase, title)
      if (eligibility.reason === 'lookup_unavailable') {
        throw env.invalid('lookup_unavailable', eligibilityBlocker(eligibility)?.message ?? 'Could not confirm whether this branch already has a pull request.')
      }
      const stack = await stackInfo(env, worktree, selectedBase)
      await ensureExactHead(env, worktree, caller)
      const enriched = eligibilityWithStack(eligibility, stack)
      env.update((state) => {
        if (state.creation.generation !== generation || state.creation.worktree !== worktree.id) return
        state.creation.eligibility = enriched
        state.creation.bases = bases
        state.creation.base = selectedBase
        state.creation.head = worktree.branch
        if (state.creation.title.trim() === '') state.creation.title = title
        if (state.creation.body === '') state.creation.body = body
        state.creation.loading = false
        state.creation.error = stack.error
      })
      if (eligibility.reason === 'existing_review') {
        const existing = reviewFromEligibility(eligibility)
        if (!existing) throw env.invalid('invalid_response', 'Hosting found an existing pull request without a valid identity.')
        if (sequence !== openSequence) return { worktree: worktree.id, opened: false, stale: true }
        await openReviewForIdentity(env, worktree, existing)
        return { worktree: worktree.id, opened: true, existingReview: { number: existing.number, url: existing.url, existing: true } }
      }
      if (sequence !== openSequence) return { worktree: worktree.id, opened: false, stale: true }
      await env.openView(CREATE_VIEW, { worktree: worktree.id })
      if (defaults.generateDetailsOnOpen && !env.read().creation.generated && sequence === openSequence) {
        void runGeneration(env, worktree, generation, caller).catch((error: unknown) => {
          env.context.log(`Create-review auto-generation failed: ${errorText(error)}`)
        })
      }
      return { worktree: worktree.id, opened: true }
    } catch (error) {
      if (generationMatches(env, worktree, generation, worktree.branch, worktree.head)) {
        env.update((state) => {
          if (state.creation.generation !== generation || state.creation.worktree !== worktree.id) return
          state.creation.loading = false
          state.creation.error = errorText(error)
        })
      }
      if (sequence === openSequence) await env.openView(CREATE_VIEW, { worktree: worktree.id })
      throw error
    }
  }

  const settingsOpen = async (params: Record<string, unknown>, caller: PluginCaller) => {
    const selector = optionalString(env, params, 'worktree')
    let worktreeId: string | undefined
    let contextError: string | undefined
    try {
      const worktree = await env.resolve(selector === undefined ? {} : { worktree: selector }, caller)
      if (selector !== undefined && worktree.id !== selector) throw env.invalid('stale_target', 'The selected settings worktree changed.')
      if (worktree.kind === 'git') worktreeId = worktree.id
      else contextError = 'Hosting settings require a registered Git worktree.'
    } catch (error) {
      if (selector !== undefined) throw error
      contextError = errorText(error)
    }
    setSettingsTarget(env, worktreeId ?? null, contextError ?? null)
    await env.openView(SETTINGS_VIEW, {
      ...(worktreeId === undefined ? {} : { worktree: worktreeId }),
      ...(contextError === undefined ? {} : { contextError })
    })
    return { opened: true, ...(worktreeId === undefined ? {} : { worktree: worktreeId }), ...(contextError === undefined ? {} : { error: contextError }) }
  }

  const createDraft = async (params: Record<string, unknown>, caller: PluginCaller) => {
    const worktree = await resolveContext(env, params, caller)
    const creation = assertCurrent(env, worktree)
    if (creation.submitting || creation.generating) throw env.invalid('conflict', 'Review details cannot be edited while generation or submission is in progress.')
    const title = optionalString(env, params, 'title')
    const body = optionalString(env, params, 'body')
    const draft = optionalBoolean(env, params, 'draft')
    const useTemplate = optionalBoolean(env, params, 'useTemplate')
    if (title === undefined && body === undefined && draft === undefined && useTemplate === undefined) {
      throw env.invalid('validation_error', 'Provide at least one draft field to update.')
    }
    env.update((state) => {
      if (state.creation.generation !== creation.generation || state.creation.worktree !== worktree.id) return
      if (title !== undefined) state.creation.title = title
      if (body !== undefined) state.creation.body = body
      if (draft !== undefined) state.creation.draft = draft
      if (useTemplate !== undefined) state.creation.useTemplate = useTemplate
      state.creation.error = null
    })
    return { updated: true }
  }

  const createBases = async (params: Record<string, unknown>, caller: PluginCaller) => {
    const worktree = await resolveContext(env, params, caller)
    const creation = assertCurrent(env, worktree)
    const query = optionalString(env, params, 'query') ?? ''
    const bases = query === '' ? creation.bases : (await readBases(env, worktree, query))
    return { bases, selected: creation.base }
  }

  const createBase = async (params: Record<string, unknown>, caller: PluginCaller) => {
    const worktree = await resolveContext(env, params, caller)
    const creation = assertCurrent(env, worktree)
    if (creation.submitting || creation.generating) throw env.invalid('conflict', 'Wait for the active review operation to finish before changing its base.')
    const base = requiredString(env, params.base, 'base')
    if (!creation.bases.includes(base)) throw env.invalid('invalid_base', 'Choose a base branch returned by the public Git branch list.')
    if (base.toLowerCase() === creation.head.toLowerCase()) throw env.invalid('same_branch', 'Base branch must differ from the head branch.')
    const stackSelection = optionalBoolean(env, params, 'stack')
    const raw = await env.call('quirky.hosting/creationEligibility', { worktree: worktree.id, base, head: worktree.branch, title: creation.title })
    const eligibility = parseEligibility(env, raw, worktree)
    const detectedStack = await stackInfo(env, worktree, base, stackSelection)
    await ensureExactHead(env, worktree, caller)
    if (stackSelection === true && detectedStack.parentNumber === null) {
      throw env.invalid('stack_parent_unavailable', detectedStack.error ?? 'The selected base branch is not the head of an open pull request.')
    }
    const enriched = eligibilityWithStack(eligibility, detectedStack)
    if (!generationMatches(env, worktree, creation.generation, worktree.branch, worktree.head)) {
      throw env.invalid('head_changed', 'The worktree changed while the selected base was being checked.')
    }
    env.update((state) => {
      if (state.creation.generation !== creation.generation || state.creation.worktree !== worktree.id) return
      state.creation.base = base
      state.creation.eligibility = enriched
      state.creation.error = detectedStack.error
    })
    return {
      base,
      eligible: eligibility.eligible,
      stackSupported: detectedStack.supported,
      ...(detectedStack.parentNumber === null ? {} : { stackParentNumber: detectedStack.parentNumber }),
      stackEnabled: detectedStack.enabled
    }
  }

  const createGenerate = async (params: Record<string, unknown>, caller: PluginCaller) => {
    const worktree = await resolveContext(env, params, caller)
    const creation = assertCurrent(env, worktree)
    if (creation.generating || creation.submitting) throw env.invalid('conflict', 'Review detail generation or submission is already in progress.')
    const requestedAgent = optionalString(env, params, 'agent')
    const details = await runGeneration(env, worktree, creation.generation, caller, requestedAgent)
    return { generated: true, title: details.title, body: details.body }
  }

  const createCancelGenerate = async (params: Record<string, unknown>, caller: PluginCaller) => {
    const worktree = await resolveContext(env, params, caller)
    const creation = env.read().creation
    if (creation.worktree !== worktree.id || creation.generation < 1) throw env.invalid('stale_target', 'There is no create-review generation for this worktree.')
    if (!creation.generating || creation.requestId === null) return { cancelled: false }
    const response = await env.call('quirky.agents/cancelGenerate', { requestId: creation.requestId })
    if (!isRecord(response) || typeof response.cancelled !== 'boolean') throw env.invalid('invalid_response', 'The agent service returned an invalid cancellation response.')
    env.update((state) => {
      if (state.creation.generation !== creation.generation || state.creation.worktree !== worktree.id || state.creation.requestId !== creation.requestId) return
      state.creation.generating = false
      state.creation.requestId = null
      state.creation.error = response.cancelled ? null : 'The agent request was no longer cancellable; any late output will be discarded.'
    })
    return { cancelled: response.cancelled }
  }

  const createSubmit = async (params: Record<string, unknown>, caller: PluginCaller) => {
    const worktree = await resolveContext(env, params, caller)
    const creation = assertCurrent(env, worktree)
    if (creation.submitting) throw env.invalid('duplicate_submission', 'This pull request is already being submitted.')
    if (creation.generating) throw env.invalid('generation_in_progress', 'Wait for AI generation to finish.')
    if (creation.loading || creation.eligibility === null) throw env.invalid('eligibility_unconfirmed', 'Refresh eligibility before submitting this pull request.')
    if (creation.title.trim() === '') throw env.invalid('title_required', 'Enter a pull request title.')
    if (creation.base.trim() === '') throw env.invalid('base_required', 'Choose a base branch.')
    if (creation.base.toLowerCase() === creation.head.toLowerCase()) throw env.invalid('same_branch', 'Base branch must differ from the head branch.')
    const generation = creation.generation
    env.update((state) => {
      if (state.creation.generation !== generation || state.creation.worktree !== worktree.id) return
      state.creation.submitting = true
      state.creation.error = null
    })
    try {
      let latest = assertCurrent(env, worktree, generation)
      let eligibility = await readEligibility(env, worktree, latest.base, latest.title)
      if (eligibility.reason === 'existing_review') {
        const existing = reviewFromEligibility(eligibility)
        if (!existing) throw env.invalid('invalid_response', 'Hosting found an existing pull request without a valid identity.')
        return await publishReview(env, worktree, generation, existing, 'already_exists')
      }
      let blocker = eligibilityBlocker(eligibility)
      if (!eligibility.eligible && blocker && (blocker.reason === 'branch_ahead' || blocker.reason === 'no_upstream')) {
        await ensureExactHead(env, worktree, caller)
        try {
          await env.call('quirky.git/push', { worktree: worktree.id })
        } catch (pushError) {
          throw env.invalid('push_failed', `Push failed. Resolve the push error, then try again: ${errorText(pushError)}`)
        }
        const afterPush = await env.resolve({ worktree: worktree.id }, caller)
        if (afterPush.id !== worktree.id || afterPush.branch !== worktree.branch || afterPush.head !== worktree.head) {
          throw env.invalid('head_changed', 'The worktree head changed while pushing. Reopen the composer before creating a pull request.')
        }
        eligibility = await readEligibility(env, worktree, latest.base, latest.title)
        blocker = eligibilityBlocker(eligibility)
      }
      if (!eligibility.eligible) throw env.invalid(blocker?.reason ?? 'eligibility_blocked', blocker?.message ?? 'Pull-request creation eligibility could not be confirmed.')

      latest = assertCurrent(env, worktree, generation)
      const defaults = getExactDefaults(env, worktree.repoId).defaults
      if (defaults.generateDetailsOnOpen && !latest.generated) {
        await runGeneration(env, worktree, generation, caller, undefined, true)
        latest = assertCurrent(env, worktree, generation)
        eligibility = await readEligibility(env, worktree, latest.base, latest.title)
        if (!eligibility.eligible) {
          const generationBlocker = eligibilityBlocker(eligibility)
          if (eligibility.reason === 'existing_review') {
            const existing = reviewFromEligibility(eligibility)
            if (!existing) throw env.invalid('invalid_response', 'Hosting found an existing pull request without a valid identity.')
            return await publishReview(env, worktree, generation, existing, 'already_exists')
          }
          throw env.invalid(generationBlocker?.reason ?? 'eligibility_blocked', generationBlocker?.message ?? 'Pull-request eligibility changed during generation.')
        }
      }
      latest = assertCurrent(env, worktree, generation)
      const finalHead = await env.resolve({ worktree: worktree.id }, caller)
      if (finalHead.id !== worktree.id || finalHead.branch !== worktree.branch || finalHead.head !== worktree.head) {
        throw env.invalid('head_changed', 'The worktree head changed before pull-request creation.')
      }
      const confirmedAt = Number(eligibility.confirmedAt)
      if (!Number.isFinite(confirmedAt) || Date.now() - confirmedAt > 5 * 60_000) {
        throw env.invalid('eligibility_expired', 'Creation eligibility expired before submission. Reopen the composer and try again.')
      }
      let stackParent: number | null = null
      const stack = parseStackInfo(env, latest.eligibility ?? {}, latest.base)
      if (stack.enabled) stackParent = await freshStackParent(env, worktree, latest.base, stack)
      await ensureExactHead(env, worktree, caller)
      const payload: JsonRecord = {
        worktree: worktree.id,
        base: latest.base,
        head: worktree.branch,
        title: latest.title,
        body: latest.body,
        draft: latest.draft,
        useTemplate: latest.useTemplate
      }
      let created: unknown
      try {
        created = await env.call(stackParent === null ? 'quirky.hosting/create' : 'quirky.hosting/createStacked', {
          ...payload,
          ...(stackParent === null ? {} : { parentNumber: stackParent })
        })
      } catch (error) {
        const data = errorData(error)
        if (errorReason(error) === 'partial_change' && data?.partial === true && Array.isArray(data.completedSteps) && data.completedSteps.includes('create')) {
          const partialReview = parseMinimalReview(data.createdReview)
          if (!partialReview) throw error
          return await publishReview(env, worktree, generation, partialReview, 'partial', errorText(error))
        }
        if (errorReason(error) === 'already_exists') {
          const lookup = parseReviewLookup(env, await env.call('quirky.hosting/forBranch', { worktree: worktree.id, branch: worktree.branch, headOid: worktree.head, active: true }))
          if (lookup.kind === 'found') return await publishReview(env, worktree, generation, lookup.review, 'already_exists')
        }
        throw error
      }
      const identity = parseMinimalReview(created)
      if (!identity) throw env.invalid('unknown_completion', 'PR creation returned no confirmed review identity. Do not retry blindly; refresh the branch review state.')
      const existing = isRecord(created) && created.existing === true
      return await publishReview(env, worktree, generation, identity, existing ? 'already_exists' : 'created')
    } catch (error) {
      applyError(env, worktree, generation, error)
      throw error
    } finally {
      const current = env.read().creation
      if (current.generation === generation && current.worktree === worktree.id && current.submitting) {
        env.update((state) => {
          if (state.creation.generation === generation && state.creation.worktree === worktree.id) state.creation.submitting = false
        })
      }
    }
  }

  const creationDefaults = async (params: Record<string, unknown>, caller: PluginCaller) => {
    const target = creationDefaultsScope(env, params)
    if (target.scope === 'global') return { scope: 'global', defaults: { ...env.read().defaults } }
    const worktree = await resolveRepoContext(env, { worktree: requiredString(env, target.selector, 'worktree') }, caller)
    const resolved = getExactDefaults(env, worktree.repoId)
    return { ...resolved, repoId: worktree.repoId }
  }

  const setCreationDefaults = async (params: Record<string, unknown>, caller: PluginCaller) => {
    const defaults = parseDefaults(env, params.defaults)
    const target = creationDefaultsScope(env, params)
    if (target.scope === 'global') {
      env.update((state) => { state.defaults = { ...defaults } })
      return { scope: 'global', defaults }
    }
    const worktree = await resolveRepoContext(env, { worktree: requiredString(env, target.selector, 'worktree') }, caller)
    env.update((state) => { state.repoDefaults[worktree.repoId] = { ...defaults } })
    return { scope: 'repository', repoId: worktree.repoId, defaults }
  }

  const resetCreationDefaults = async (params: Record<string, unknown>, caller: PluginCaller) => {
    const target = creationDefaultsScope(env, params)
    if (target.scope === 'global') {
      env.update((state) => { state.defaults = { ...DEFAULTS } })
      return { scope: 'global', defaults: { ...DEFAULTS } }
    }
    const worktree = await resolveRepoContext(env, { worktree: requiredString(env, target.selector, 'worktree') }, caller)
    env.update((state) => { delete state.repoDefaults[worktree.repoId] })
    return { scope: 'repository', repoId: worktree.repoId, defaults: { ...env.read().defaults } }
  }

  const hostingDiagnose = async (params: Record<string, unknown>, caller: PluginCaller) => {
    const worktree = await resolveRepoContext(env, params, caller)
    return readSettingsField(env, worktree.id, 'diagnostics', 'GitHub diagnostics',
      () => env.call('quirky.hosting/diagnoseAuth', { worktree: worktree.id }), parseHostingDiagnostics)
  }

  const hostingAccounts = async (params: Record<string, unknown>, caller: PluginCaller) => {
    const worktree = await resolveRepoContext(env, params, caller)
    return readSettingsField(env, worktree.id, 'accounts', 'GitHub accounts',
      () => env.call('quirky.hosting/accounts', { worktree: worktree.id }), parseHostingAccounts)
  }

  const hostingConfiguration = async (params: Record<string, unknown>, caller: PluginCaller) => {
    const worktree = await resolveRepoContext(env, params, caller)
    return readSettingsField(env, worktree.id, 'configuration', 'Repository hosting configuration',
      () => env.call('quirky.hosting/configuration', { worktree: worktree.id }), parseHostingConfiguration)
  }

  const hostingBudget = async (params: Record<string, unknown>, caller: PluginCaller) => {
    const worktree = await resolveRepoContext(env, params, caller)
    const force = optionalBoolean(env, params, 'force') === true
    return readSettingsField(env, worktree.id, 'budget', 'GitHub API budget',
      () => env.call('quirky.hosting/rateLimit', { worktree: worktree.id, force }), parseHostingBudget)
  }

  const hostingSettingsRefresh = async (params: Record<string, unknown>, caller: PluginCaller) => {
    const worktree = await resolveRepoContext(env, params, caller)
    const generation = beginSettingsRefresh(env, worktree.id)
    const forceBudget = optionalBoolean(env, params, 'forceBudget') === true
    const observations = [
      {
        field: 'diagnostics' as const,
        label: 'GitHub diagnostics',
        parse: parseHostingDiagnostics,
        read: () => env.call('quirky.hosting/diagnoseAuth', { worktree: worktree.id })
      },
      {
        field: 'accounts' as const,
        label: 'GitHub accounts',
        parse: parseHostingAccounts,
        read: () => env.call('quirky.hosting/accounts', { worktree: worktree.id })
      },
      {
        field: 'configuration' as const,
        label: 'Repository hosting configuration',
        parse: parseHostingConfiguration,
        read: () => env.call('quirky.hosting/configuration', { worktree: worktree.id })
      },
      {
        field: 'budget' as const,
        label: 'GitHub API budget',
        parse: parseHostingBudget,
        read: () => env.call('quirky.hosting/rateLimit', { worktree: worktree.id, force: forceBudget })
      }
    ]
    const requests = observations.map(({ field }) => beginSettingsReadAtGeneration(env, worktree.id, generation, field))
    const results = await Promise.allSettled(observations.map(({ read }) => read()))
    if (settingsGeneration(env, worktree.id) !== generation) {
      const snapshot = currentSettingsResult(env, worktree.id)
      return { worktree: worktree.id, refreshed: false, stale: true, fetchedAt: snapshot.fetchedAt }
    }
    let contextError: string | null = null
    try {
      const current = await env.resolve({ worktree: worktree.id }, caller)
      if (current.id !== worktree.id) contextError = 'The selected worktree changed while hosting settings were loading.'
    } catch (error) {
      contextError = errorText(error)
    }
    if (settingsGeneration(env, worktree.id) !== generation) {
      const snapshot = currentSettingsResult(env, worktree.id)
      return { worktree: worktree.id, refreshed: false, stale: true, fetchedAt: snapshot.fetchedAt }
    }
    if (contextError !== null) {
      settingsContextError(env, worktree.id, generation, contextError)
      const snapshot = currentSettingsResult(env, worktree.id)
      return {
        worktree: worktree.id,
        refreshed: false,
        stale: true,
        fetchedAt: snapshot.fetchedAt,
        ...(snapshot.error === null ? {} : { error: snapshot.error })
      }
    }
    completeSettingsRefresh(
      env,
      requests,
      results,
      observations.map(({ parse }) => parse),
      observations.map(({ label }) => label)
    )
    const snapshot = currentSettingsResult(env, worktree.id)
    return {
      worktree: worktree.id,
      refreshed: snapshot.error === null,
      fetchedAt: snapshot.fetchedAt,
      ...(snapshot.error === null ? {} : { error: snapshot.error })
    }
  }

  const hostingBindAccount = async (params: Record<string, unknown>, caller: PluginCaller) => {
    const worktree = await resolveRepoContext(env, params, caller)
    const host = requiredString(env, params.host, 'host')
    const user = requiredString(env, params.user, 'user')
    return readSettingsField(env, worktree.id, 'configuration', 'Repository hosting configuration', async () => {
      await env.call('quirky.hosting/configure', { worktree: worktree.id, account: { host, user } })
      return env.call('quirky.hosting/configuration', { worktree: worktree.id })
    }, parseHostingConfiguration)
  }

  const hostingUnbindAccount = async (params: Record<string, unknown>, caller: PluginCaller) => {
    const worktree = await resolveRepoContext(env, params, caller)
    return readSettingsField(env, worktree.id, 'configuration', 'Repository hosting configuration', async () => {
      await env.call('quirky.hosting/configure', { worktree: worktree.id, clearAccount: true })
      return env.call('quirky.hosting/configuration', { worktree: worktree.id })
    }, parseHostingConfiguration)
  }

  return {
    createOpen,
    settingsOpen,
    createDraft,
    createBases,
    createBase,
    createGenerate,
    createCancelGenerate,
    createSubmit,
    creationDefaults,
    setCreationDefaults,
    resetCreationDefaults,
    hostingDiagnose,
    hostingAccounts,
    hostingConfiguration,
    hostingBudget,
    hostingSettingsRefresh,
    hostingBindAccount,
    hostingUnbindAccount
  }
}
