import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { validateValue, type Schema } from '@quirky/protocol'
import type { BrowserStore } from '../profiles/store'
import type { BrowserRuntime } from '../runtime/driver'
import { BrowserFault, fault, redactedMessage } from '../runtime/errors'
import type { BrowserDependencies, CookieTransport } from '../runtime/dependencies'
import { planCookieImport, registrableFamily, validateSourceProfile, type CookieImportPlan } from './policy'
import { detectBrowsers, readCookieSource, type CookieSourceRequest, type SourceCookies } from './sources'
import type { BrowserFamily, Cookie, ImportJob, ImportSummary } from './types'

const SOURCE_SCHEMA: Schema = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['file', 'json', 'browser'] },
    path: { type: 'string' },
    cookies: { type: 'array', items: {} },
    family: { type: 'string', enum: ['chrome', 'edge', 'arc', 'chromium', 'comet', 'helium', 'firefox', 'safari'] },
    profile: { type: 'string' }
  },
  required: ['kind'],
  additionalProperties: false
}

const COOKIE_SUMMARY_SCHEMA: Schema = {
  type: 'object',
  properties: {
    totalCookies: { type: 'integer' },
    importedCookies: { type: 'integer' },
    skippedCookies: { type: 'integer' },
    googleCookiesSkipped: { type: 'integer' },
    partitionSkippedCookies: { type: 'integer' },
    domains: { type: 'array', items: { type: 'string' } },
    warning: {
      type: 'object',
      properties: { code: { type: 'string' }, reasons: { type: 'array', items: { type: 'string' } } },
      required: ['code'],
      additionalProperties: false
    }
  },
  required: ['totalCookies', 'importedCookies', 'skippedCookies', 'domains'],
  additionalProperties: false
}

const BROWSER_FAMILIES = ['chrome', 'edge', 'arc', 'chromium', 'comet', 'helium', 'firefox', 'safari'] as const

function parseImportSource(value: unknown): CookieSourceRequest {
  if (validateValue(SOURCE_SCHEMA, value, 'source')) throw fault('invalid_argument', 'cookie source must be an exact file, JSON, or browser source object')
  const source = value as Record<string, unknown>
  if (source.kind === 'file') {
    if (Object.keys(source).some((key) => key !== 'kind' && key !== 'path') || typeof source.path !== 'string' || source.path === '' || !isAbsolute(source.path)) {
      throw fault('invalid_argument', 'file cookie source requires only a non-empty absolute path')
    }
    return { kind: 'file', path: source.path }
  }
  if (source.kind === 'json') {
    if (Object.keys(source).some((key) => key !== 'kind' && key !== 'cookies') || !Array.isArray(source.cookies)) {
      throw fault('invalid_argument', 'JSON cookie source requires only a cookies array')
    }
    return { kind: 'json', cookies: source.cookies }
  }
  if (source.kind !== 'browser' || Object.keys(source).some((key) => key !== 'kind' && key !== 'family' && key !== 'profile') || typeof source.family !== 'string') {
    throw fault('invalid_argument', 'browser cookie source requires a supported family and optional profile')
  }
  if (!(BROWSER_FAMILIES as readonly string[]).includes(source.family)) throw fault('invalid_argument', 'unsupported source browser family')
  let profile: string | undefined
  if (source.profile !== undefined) {
    if (typeof source.profile !== 'string') throw fault('invalid_argument', 'source profile must be a string')
    profile = validateSourceProfile(source.profile)
  }
  if (source.family === 'safari' && profile !== undefined) throw fault('invalid_argument', 'Safari does not accept a source profile')
  return { kind: 'browser', family: source.family as BrowserFamily, ...(profile === undefined ? {} : { profile }) }
}

function familySet(domains: readonly string[]): Set<string> {
  const families = new Set<string>()
  for (const domain of domains) families.add(registrableFamily(domain) ?? '')
  return families
}

function samePartition(a: Cookie['partitionKey'], b: Cookie['partitionKey']): boolean {
  return a?.topLevelSite === b?.topLevelSite && a?.hasCrossSiteAncestor === b?.hasCrossSiteAncestor
}

function sameIdentity(a: Cookie, b: Cookie): boolean {
  return a.name === b.name && a.domain.replace(/^\.+/, '').toLowerCase() === b.domain.replace(/^\.+/, '').toLowerCase() &&
    a.path === b.path && a.hostOnly === b.hostOnly && samePartition(a.partitionKey, b.partitionKey)
}

function sameCookie(a: Cookie, b: Cookie): boolean {
  return sameIdentity(a, b) && a.value === b.value && a.secure === b.secure && a.httpOnly === b.httpOnly &&
    a.sameSite === b.sameSite && a.expires === b.expires
}

function cookieIdentityKey(cookie: Cookie): string {
  return JSON.stringify([
    cookie.name,
    cookie.domain.replace(/^\.+/, '').toLowerCase(),
    cookie.path,
    cookie.hostOnly,
    cookie.partitionKey?.topLevelSite ?? null,
    cookie.partitionKey?.hasCrossSiteAncestor ?? null
  ])
}

function sameCookieSet(expected: readonly Cookie[], actual: readonly Cookie[]): boolean {
  if (expected.length !== actual.length) return false
  const remaining = new Map<string, Cookie[]>()
  for (const cookie of expected) {
    const identity = cookieIdentityKey(cookie)
    const cookies = remaining.get(identity) ?? []
    cookies.push(cookie)
    remaining.set(identity, cookies)
  }
  for (const cookie of actual) {
    const identity = cookieIdentityKey(cookie)
    const candidates = remaining.get(identity)
    if (!candidates) return false
    const index = candidates.findIndex((candidate) => sameCookie(cookie, candidate))
    if (index < 0) return false
    candidates.splice(index, 1)
    if (candidates.length === 0) remaining.delete(identity)
  }
  return remaining.size === 0
}

function inImportedFamilies(cookie: Cookie, families: ReadonlySet<string>): boolean {
  const family = registrableFamily(cookie.domain)
  return family !== null && families.has(family)
}

function sourceWarning(sourceWarnings: readonly string[], partitionSkipped: number, googleSkipped: number): { code: string; reasons: string[] } | undefined {
  const reasons = new Set(sourceWarnings)
  if (partitionSkipped > 0) reasons.add('unreadable-partition-family')
  if (googleSkipped > 0) reasons.add('google-source-bound')
  if (reasons.size === 0) return undefined
  const code = partitionSkipped > 0 || sourceWarnings.includes('partition-skipped')
    ? 'browser_import_partition_skipped'
    : sourceWarnings.includes('decryption-skipped') || sourceWarnings.includes('unsupported-encryption')
      ? 'browser_import_decryption_skipped'
      : 'browser_import_source_warning'
  return { code, reasons: [...reasons] }
}

function summaryFor(source: SourceCookies): { summary: ImportSummary; plan: CookieImportPlan } {
  const partitionFamilies = familySet(source.unreadablePartitionDomains)
  const unreadableFamilies = familySet(source.unreadableCookieDomains)
  const plan = planCookieImport(source.cookies, {
    unreadablePartitionFamilies: partitionFamilies,
    unreadableFamilies
  })
  const partitionSkippedCookies = source.unreadablePartitionDomains.length + plan.partitionSkippedCookies
  const warning = sourceWarning(source.warnings, partitionSkippedCookies, plan.googleCookiesSkipped)
  const summary: ImportSummary = {
    totalCookies: source.totalCookies,
    importedCookies: plan.cookies.length,
    skippedCookies: source.skippedCookies + plan.skippedCookies,
    ...(plan.googleCookiesSkipped > 0 ? { googleCookiesSkipped: plan.googleCookiesSkipped } : {}),
    ...(partitionSkippedCookies > 0 ? { partitionSkippedCookies } : {}),
    domains: plan.domains,
    ...(warning ? { warning } : {})
  }
  if (validateValue(COOKIE_SUMMARY_SCHEMA, summary, 'cookie import summary')) {
    throw fault('browser_error', 'cookie importer produced an invalid summary')
  }
  return { summary, plan }
}

function metadataSource(source: CookieSourceRequest): { browserFamily: string; profileName?: string; importedAt: number } {
  if (source.kind === 'browser') {
    return { browserFamily: source.family, ...(source.profile === undefined ? {} : { profileName: source.profile }), importedAt: Date.now() }
  }
  return { browserFamily: source.kind, importedAt: Date.now() }
}

function cancelled(): BrowserFault {
  return fault('browser_tab_closed', 'cookie import was cancelled during plugin shutdown')
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw cancelled()
}

async function rollbackReplacement(
  transport: CookieTransport,
  profileId: string,
  attempted: readonly Cookie[],
  removed: readonly Cookie[]
): Promise<unknown[]> {
  const errors: unknown[] = []
  for (const cookie of attempted) {
    try { await transport.delete(profileId, cookie) } catch (error) { errors.push(error) }
  }
  for (const cookie of removed) {
    try { await transport.set(profileId, cookie) } catch (error) { errors.push(error) }
  }
  return errors
}

export class CookieImporter {
  private readonly jobs = new Map<string, ImportJob>()
  private readonly order: string[] = []
  private readonly controllers = new Set<AbortController>()
  private readonly activeWork = new Set<Promise<unknown>>()
  private active = true

  constructor(
    private readonly store: BrowserStore,
    private readonly runtime: BrowserRuntime,
    private readonly dependencies: BrowserDependencies
  ) {}


  async importCookies(profileId: string | undefined, sourceValue: unknown): Promise<ImportSummary> {
    if (!this.active) throw fault('browser_error', 'cookie importer is shutting down')
    const destination = profileId ?? 'default'
    this.store.getProfile(destination)
    const source = parseImportSource(sourceValue)
    const controller = new AbortController()
    return await this.track(controller, async () => await this.runtime.withCookieMutation(destination, async (transport) => {
      assertNotAborted(controller.signal)
      return await this.runImport(destination, source, transport, controller.signal)
    }))
  }

  start(profileId: string | undefined, sourceValue: unknown): { id: string } {
    if (!this.active) throw fault('browser_error', 'cookie importer is shutting down')
    const destination = profileId ?? 'default'
    this.store.getProfile(destination)
    const source = parseImportSource(sourceValue)
    const id = randomUUID()
    const job: ImportJob = { id, profileId: destination, status: 'queued', createdAt: Date.now() }
    this.jobs.set(id, job)
    this.order.push(id)
    const controller = new AbortController()
    void this.track(controller, async () => await this.runJob(job, source, controller))
    return { id }
  }

  get(id: string): ImportJob {
    const job = this.jobs.get(id)
    if (!job) throw fault('browser_import_not_found', `cookie import job ${id} does not exist`)
    return structuredClone(job)
  }

  list(profileId: string | undefined, status: ImportJob['status'] | undefined): { jobs: ImportJob[] } {
    if (profileId !== undefined) this.store.getProfile(profileId)
    const jobs = this.order
      .map((id) => this.jobs.get(id)!)
      .filter((job) => (profileId === undefined || job.profileId === profileId) && (status === undefined || job.status === status))
      .map((job) => structuredClone(job))
    return { jobs }
  }

  async cancelAll(): Promise<void> {
    this.active = false
    for (const controller of this.controllers) controller.abort()
    await Promise.allSettled([...this.activeWork])
  }

  private track<T>(controller: AbortController, operation: () => Promise<T>): Promise<T> {
    this.controllers.add(controller)
    let task: Promise<T>
    task = Promise.resolve().then(operation).finally(() => {
      this.controllers.delete(controller)
      this.activeWork.delete(task)
    })
    this.activeWork.add(task)
    return task
  }

  private async runJob(job: ImportJob, source: CookieSourceRequest, controller: AbortController): Promise<void> {
    if (controller.signal.aborted || !this.active) {
      this.failJob(job, cancelled())
      return
    }
    job.status = 'running'
    try {
      const result = await this.runtime.withCookieMutation(job.profileId, async (transport) => {
        assertNotAborted(controller.signal)
        return await this.runImport(job.profileId, source, transport, controller.signal)
      })
      assertNotAborted(controller.signal)
      job.status = 'succeeded'
      job.result = result
      job.finishedAt = Date.now()
    } catch (error) {
      this.failJob(job, error)
    }
  }

  private failJob(job: ImportJob, error: unknown): void {
    const browserFault = error instanceof BrowserFault ? error : fault('browser_error', redactedMessage(error))
    job.status = 'failed'
    job.error = { code: browserFault.reason, message: redactedMessage(browserFault) }
    job.finishedAt = Date.now()
  }

  private async runImport(profileId: string, source: CookieSourceRequest, transport: CookieTransport, signal: AbortSignal): Promise<ImportSummary> {
    const sourceCookies = await readCookieSource(source, this.store.dataDir, this.dependencies)
    assertNotAborted(signal)
    const { summary, plan } = summaryFor(sourceCookies)
    const families = new Set(plan.domains)
    const existing = (await transport.list(profileId)).filter((cookie) => inImportedFamilies(cookie, families))
    assertNotAborted(signal)
    const removed: Cookie[] = []
    const attempted: Cookie[] = []
    try {
      for (const cookie of existing) {
        assertNotAborted(signal)
        removed.push(cookie)
        await transport.delete(profileId, cookie)
        assertNotAborted(signal)
      }
      for (const cookie of plan.cookies) {
        assertNotAborted(signal)
        attempted.push(cookie)
        await transport.set(profileId, cookie)
        assertNotAborted(signal)
      }
      this.store.markImported(profileId, metadataSource(source))
    } catch (error) {
      const rollbackErrors = await rollbackReplacement(transport, profileId, attempted, removed)
      let restored = false
      try {
        const afterRollback = (await transport.list(profileId)).filter((cookie) => inImportedFamilies(cookie, families))
        restored = sameCookieSet(existing, afterRollback)
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError)
      }
      if (rollbackErrors.length > 0 || !restored || error instanceof BrowserFault && error.reason === 'browser_unsafe_replace') {
        throw fault('browser_unsafe_replace', 'cookie replacement failed and rollback could not restore the exact original identities')
      }
      if (error instanceof BrowserFault && error.reason === 'browser_tab_closed') throw error
      throw fault('browser_error', 'cookie replacement failed; the original destination cookies were restored')
    }
    return summary
  }
}

export { detectBrowsers, readCookieSource }
export type { DetectedBrowser, SourceCookies } from './sources'
