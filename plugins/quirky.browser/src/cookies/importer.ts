import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { validateValue, type Schema } from '@quirky/protocol'
import { BrowserStore } from '../profiles/store'
import { BrowserRuntime } from '../runtime/driver'
import { BrowserFault, fault, redactedMessage } from '../runtime/errors'
import type { BrowserDependencies, CookieTransport } from '../runtime/dependencies'
import { planCookieImport, registrableFamily, validateSourceProfile } from './policy'
import { readCookieSource, type CookieSourceRequest } from './sources'
import type { BrowserFamily, Cookie, ImportJob, ImportSource, ImportSummary } from './types'

const SOURCE_SCHEMA: Schema = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['file', 'browser'] },
    path: { type: 'string' },
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
    warning: { type: 'object', properties: { code: { type: 'string' }, reasons: { type: 'array', items: { type: 'string' } } }, required: ['code'], additionalProperties: false }
  },
  required: ['totalCookies', 'importedCookies', 'skippedCookies', 'domains'],
  additionalProperties: false
}

function parseImportSource(value: unknown): CookieSourceRequest {
  if (validateValue(SOURCE_SCHEMA, value, 'source')) throw fault('invalid_argument', 'cookie source must be an exact file or browser source object')
  const source = value as Record<string, unknown>
  if (source.kind === 'file') {
    if (Object.hasOwn(source, 'family') || Object.hasOwn(source, 'profile') || typeof source.path !== 'string' || source.path === '' || !isAbsolute(source.path)) {
      throw fault('invalid_argument', 'file cookie source requires only a non-empty absolute path')
    }
    return { kind: 'file', path: source.path }
  }
  if (source.kind !== 'browser' || Object.hasOwn(source, 'path') || typeof source.family !== 'string') {
    throw fault('invalid_argument', 'browser cookie source requires a supported family and no file path')
  }
  if (!['chrome', 'edge', 'arc', 'chromium', 'comet', 'helium', 'firefox', 'safari'].includes(source.family)) {
    throw fault('invalid_argument', 'unsupported source browser family')
  }
  let profile: string | undefined
  if (source.profile !== undefined) profile = validateSourceProfile(source.profile as string)
  if (source.family === 'safari' && profile !== undefined) throw fault('invalid_argument', 'Safari does not accept a source profile')
  return { kind: 'browser', family: source.family as BrowserFamily, ...(profile === undefined ? {} : { profile }) }
}

function safeFamilies(unreadableDomains: readonly string[]): Set<string> {
  const families = new Set<string>()
  for (const domain of unreadableDomains) {
    const family = registrableFamily(domain)
    if (!family) families.add('')
    else families.add(family)
  }
  return families
}

function samePartition(a: Cookie['partitionKey'], b: Cookie['partitionKey']): boolean {
  return a?.topLevelSite === b?.topLevelSite && a?.hasCrossSiteAncestor === b?.hasCrossSiteAncestor
}

function sameIdentity(a: Cookie, b: Cookie): boolean {
  return a.name === b.name && a.domain.replace(/^\.+/, '').toLowerCase() === b.domain.replace(/^\.+/, '').toLowerCase() &&
    a.path === b.path && a.hostOnly === b.hostOnly && samePartition(a.partitionKey, b.partitionKey)
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

export class CookieImporter {
  private readonly jobs = new Map<string, ImportJob>()
  private readonly order: string[] = []
  private readonly controllers = new Set<AbortController>()
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
    const controller = this.controller()
    try {
      return await this.runtime.withCookieMutation(destination, async (transport) => {
        if (controller.signal.aborted) throw fault('browser_tab_closed', 'cookie import was cancelled during plugin shutdown')
        return await this.runImport(destination, source, transport, controller.signal)
      })
    } finally {
      this.controllers.delete(controller)
    }
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
    const controller = this.controller()
    queueMicrotask(() => { void this.runJob(job, source, controller) })
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

  cancelAll(): void {
    this.active = false
    for (const controller of this.controllers) controller.abort()
  }

  private controller(): AbortController {
    const controller = new AbortController()
    this.controllers.add(controller)
    return controller
  }

  private async runJob(job: ImportJob, source: CookieSourceRequest, controller: AbortController): Promise<void> {
    if (controller.signal.aborted || !this.active) {
      this.failJob(job, fault('browser_tab_closed', 'cookie import was cancelled during plugin shutdown'))
      this.controllers.delete(controller)
      return
    }
    job.status = 'running'
    try {
      const result = await this.runtime.withCookieMutation(job.profileId, async (transport) => {
        if (controller.signal.aborted) throw fault('browser_tab_closed', 'cookie import was cancelled during plugin shutdown')
        return await this.runImport(job.profileId, source, transport, controller.signal)
      })
      if (controller.signal.aborted) throw fault('browser_tab_closed', 'cookie import was cancelled during plugin shutdown')
      job.status = 'succeeded'
      job.result = result
      job.finishedAt = Date.now()
    } catch (error) {
      this.failJob(job, error)
    } finally {
      this.controllers.delete(controller)
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
    if (signal.aborted) throw fault('browser_tab_closed', 'cookie import was cancelled during plugin shutdown')
    const unreadablePartitionFamilies = safeFamilies(sourceCookies.unreadablePartitionDomains)
    const plan = planCookieImport(sourceCookies.cookies, { unreadablePartitionFamilies })
    const families = new Set(plan.domains)
    const existing = (await transport.list(profileId)).filter((cookie) => inImportedFamilies(cookie, families))
    if (signal.aborted) throw fault('browser_tab_closed', 'cookie import was cancelled during plugin shutdown')
    const removed: Cookie[] = []
    const attempted: Cookie[] = []
    try {
      for (const cookie of existing) {
        if (signal.aborted) throw fault('browser_tab_closed', 'cookie import was cancelled during plugin shutdown')
        removed.push(cookie)
        await transport.delete(profileId, cookie)
      }
      for (const cookie of plan.cookies) {
        if (signal.aborted) throw fault('browser_tab_closed', 'cookie import was cancelled during plugin shutdown')
        attempted.push(cookie)
        await transport.set(profileId, cookie)
      }
    } catch (error) {
      const rollbackErrors: unknown[] = []
      for (const cookie of attempted) {
        try { await transport.delete(profileId, cookie) } catch (rollbackError) { rollbackErrors.push(rollbackError) }
      }
      for (const cookie of removed) {
        try { await transport.set(profileId, cookie) } catch (rollbackError) { rollbackErrors.push(rollbackError) }
      }
      if (rollbackErrors.length > 0 || error instanceof BrowserFault && error.reason === 'browser_unsafe_replace') {
        throw fault('browser_unsafe_replace', 'cookie replacement failed and rollback could not restore the exact original identities')
      }
      throw fault('browser_error', 'cookie replacement failed; the original destination cookies were restored')
    }

    const partitionSkippedCookies = sourceCookies.unreadablePartitionDomains.length + plan.partitionSkippedCookies
    const warning = sourceWarning(sourceCookies.warnings, partitionSkippedCookies, plan.googleCookiesSkipped)
    const summary: ImportSummary = {
      totalCookies: sourceCookies.totalCookies,
      importedCookies: plan.cookies.length,
      skippedCookies: sourceCookies.skippedCookies + plan.skippedCookies,
      ...(plan.googleCookiesSkipped > 0 ? { googleCookiesSkipped: plan.googleCookiesSkipped } : {}),
      ...(partitionSkippedCookies > 0 ? { partitionSkippedCookies } : {}),
      domains: plan.domains,
      ...(warning ? { warning } : {})
    }
    const schemaFailure = validateValue(COOKIE_SUMMARY_SCHEMA, summary, 'cookie import summary')
    if (schemaFailure) throw fault('browser_error', 'cookie importer produced an invalid summary')
    return summary
  }
}
