/**
 * Finds the rule set that applies to an agent. Sources are tried in a fixed order (the user's
 * file, a plugin's contribution, the built-in file) and the first valid one replaces the others
 * whole. Everything is local: a file the person can read, or a manifest the daemon already holds.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ContributionInfo } from '@quirky/protocol'
import { parseRuleData, parseRuleFile, type ParseResult } from './format'
import type { IgnoredSource, Origin, RuleFile, RuleListing } from './types'

/** Why a source is skipped after the matcher cut one of its patterns off. */
export const TIMED_OUT_REASON = 'a pattern ran longer than 250 ms'

const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export type RuleSourceOptions = {
  userDir: string
  builtinDir: string
  contributions: () => Promise<ContributionInfo[]>
  log: (message: string) => void
}

export type EffectiveRules = { set: RuleFile; origin: Origin }

type Candidate = { origin: Origin; signature: string; result: ParseResult }
type CachedRead = { signature: string; result: ParseResult }

const signatureOf = (stat: { mtimeMs: number; size: number }) => `${stat.mtimeMs}:${stat.size}`

const keyOf = (origin: Origin) => (origin.kind === 'plugin' ? `plugin:${origin.plugin}:${origin.contribution}` : origin.path)

const describeOrigin = (origin: Origin) => (origin.kind === 'plugin' ? `contribution ${origin.contribution} of plugin ${origin.plugin}` : origin.path)

/**
 * The effective rule set per agent, with the sources that were skipped and why. A bad source
 * never throws: it is skipped, recorded, and logged once per version of that source.
 */
export class RuleSources {
  private readonly files = new Map<string, CachedRead>()
  private readonly timedOut = new Map<string, string>()
  private readonly logged = new Set<string>()
  private contributionCache: Promise<ContributionInfo[]> | null = null

  constructor(private readonly options: RuleSourceOptions) {}

  /** The rule set that applies to `agent`, or null when no source holds a valid one. */
  async effective(agent: string): Promise<EffectiveRules | null> {
    return (await this.resolve(agent)).effective
  }

  /** What `effective` chose for `agent` and what it skipped; null when the agent has no source at all. */
  async listing(agent: string): Promise<RuleListing | null> {
    const { effective, ignored } = await this.resolve(agent)
    if (effective === null && ignored.length === 0) return null
    return { agent, origin: effective?.origin ?? null, rules: effective?.set.rules.length ?? 0, ignored }
  }

  /** One listing per agent that has any source, sorted by agent. */
  async list(): Promise<RuleListing[]> {
    const agents = new Set<string>()
    for (const dir of [this.options.userDir, this.options.builtinDir]) {
      for (const name of this.namesIn(dir)) agents.add(name)
    }
    for (const info of await this.contributionList()) {
      if (info.kind === 'agent-rules' && info.status === 'effective' && AGENT_NAME.test(info.name)) agents.add(info.name)
    }
    const listings: RuleListing[] = []
    for (const agent of [...agents].sort()) {
      const listing = await this.listing(agent)
      if (listing) listings.push(listing)
    }
    return listings
  }

  /** Forgets the fetched contributions, and any contribution marked slow, after a plugin change. */
  invalidateContributions(): void {
    this.contributionCache = null
    for (const key of [...this.timedOut.keys()]) {
      if (key.startsWith('plugin:')) this.timedOut.delete(key)
    }
  }

  /** Marks the source behind `origin` as ignored until its file changes (a contribution: until the next invalidation). */
  reportTimeout(origin: Origin): void {
    const key = keyOf(origin)
    if (origin.kind === 'plugin') {
      this.timedOut.set(key, '')
      return
    }
    const cached = this.files.get(key)
    if (cached) this.timedOut.set(key, cached.signature)
  }

  private namesIn(dir: string): string[] {
    try {
      return readdirSync(dir)
        .filter((entry) => entry.endsWith('.json'))
        .map((entry) => entry.slice(0, -'.json'.length))
        .filter((name) => AGENT_NAME.test(name))
    } catch {
      return []
    }
  }

  private contributionList(): Promise<ContributionInfo[]> {
    if (this.contributionCache === null) {
      const pending = this.options.contributions().catch((error: unknown) => {
        this.options.log(`could not read rule contributions: ${error instanceof Error ? error.message : String(error)}`)
        if (this.contributionCache === pending) this.contributionCache = null
        return []
      })
      this.contributionCache = pending
    }
    return this.contributionCache
  }

  private readFile(path: string, agent: string): { signature: string; result: ParseResult } | null {
    const stat = statSync(path, { throwIfNoEntry: false })
    if (stat === undefined) {
      this.files.delete(path)
      return null
    }
    const signature = signatureOf(stat)
    const cached = this.files.get(path)
    if (cached && cached.signature === signature) return cached
    let result: ParseResult
    if (!stat.isFile()) {
      result = { ok: false, reason: 'is not a file' }
    } else {
      try {
        result = parseRuleFile(readFileSync(path, 'utf8'), agent)
      } catch (error) {
        result = { ok: false, reason: `cannot be read: ${error instanceof Error ? error.message : String(error)}` }
      }
    }
    const read = { signature, result }
    this.files.set(path, read)
    return read
  }

  private async candidates(agent: string): Promise<Candidate[]> {
    const found: Candidate[] = []
    const fromFile = (kind: 'user' | 'built-in', dir: string) => {
      const path = join(dir, `${agent}.json`)
      const read = this.readFile(path, agent)
      if (read) found.push({ origin: { kind, path }, ...read })
    }
    fromFile('user', this.options.userDir)
    const info = (await this.contributionList()).find((entry) => entry.kind === 'agent-rules' && entry.status === 'effective' && entry.name === agent)
    if (info) found.push({ origin: { kind: 'plugin', plugin: info.plugin, contribution: info.name }, signature: '', result: parseRuleData(info.data, agent) })
    fromFile('built-in', this.options.builtinDir)
    return found
  }

  private async resolve(agent: string): Promise<{ effective: EffectiveRules | null; ignored: IgnoredSource[] }> {
    const ignored: IgnoredSource[] = []
    if (!AGENT_NAME.test(agent)) return { effective: null, ignored }
    for (const candidate of await this.candidates(agent)) {
      const key = keyOf(candidate.origin)
      if (candidate.result.ok && this.timedOut.get(key) !== candidate.signature) {
        return { effective: { set: candidate.result.file, origin: candidate.origin }, ignored }
      }
      const reason = candidate.result.ok ? TIMED_OUT_REASON : candidate.result.reason
      ignored.push({ origin: candidate.origin, reason })
      const logKey = `${key}@${candidate.signature}`
      if (!this.logged.has(logKey)) {
        this.logged.add(logKey)
        this.options.log(`ignoring rules from ${describeOrigin(candidate.origin)}: ${reason}`)
      }
    }
    return { effective: null, ignored }
  }
}
