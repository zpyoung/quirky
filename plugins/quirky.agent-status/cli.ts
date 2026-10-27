import type { CliContext, CliModule } from '@quirky/protocol'
import type { Explanation } from './src/explain'
import type { Origin, RuleFile, RuleListing } from './src/rules/types'

type SetupEntry = { agent: string; status: string; changed: string[]; note?: string; message?: string }
type RemoveEntry = { agent: string; changed: string[]; message?: string }
type StatusEntry = { agent: string; status: string; files: string[]; message?: string }

/** `path` with the CLI user's home shown as `~`. */
function shown(path: string, ctx: CliContext): string {
  const home = ctx.env.HOME
  return home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

const agentLine = (agent: string, outcome: string, ...details: (string | undefined)[]) =>
  [`${agent}: ${outcome}`, ...details.filter((detail): detail is string => detail !== undefined && detail !== '')].join(' — ')

/** One `changed <path>` line per file, then one line per agent. */
function formatChanges(entries: { changed: string[] }[], summaries: string[], ctx: CliContext): string {
  const changed = entries.flatMap((entry) => entry.changed).map((path) => `changed ${shown(path, ctx)}`)
  return [...changed, ...summaries].join('\n')
}

function agentArg(positionals: string[]): { agent: string } | Record<string, never> {
  return positionals[0] === undefined ? {} : { agent: positionals[0] }
}

const ago = (ms: number): string => {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 90) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  return minutes < 90 ? `${minutes}m` : `${Math.round(minutes / 60)}h`
}

/** `user`, `plugin <name>` or `built-in`. */
const originKind = (origin: Origin) => (origin.kind === 'plugin' ? `plugin ${origin.plugin}` : origin.kind)

/** The file of a user or built-in origin, the contribution name of a plugin's. */
const originWhere = (origin: Origin, ctx: CliContext) => (origin.kind === 'plugin' ? origin.contribution : shown(origin.path, ctx))

const originText = (origin: Origin, ctx: CliContext) => `${originKind(origin)} ${originWhere(origin, ctx)}`

/** The text `explain` prints: the sentence, then the evidence behind it, line by line. */
export function explanationLines(explained: Explanation, ctx: CliContext): string[] {
  const lines = [explained.summary]
  const { row, screen } = explained
  if (row === null) {
    lines.push('row: none')
  } else {
    const because = row.because
    lines.push(
      because
        ? `because: ${because.rule} (${because.source}) ${ago(row.ageMs)} ago`
        : 'because: no record (stored before explain existed)'
    )
    const facts = [`${row.state}`, `shown as ${row.display}`, `source ${row.source}`, row.fresh ? 'fresh' : 'not fresh', `last evidence ${ago(row.ageMs)} ago`]
    lines.push(`row: ${facts.join(', ')}${row.detail ? `, detail ${row.detail}` : ''}`)
    if (row.state !== row.lead.state) {
      const kids = Object.entries(row.children)
        .filter(([, count]) => count > 0)
        .map(([kind, count]) => `${count} ${kind}`)
      lines.push(`fold: the lead is ${row.lead.state} since ${new Date(row.lead.since).toISOString()}; ${kids.join(', ') || 'no children'} still running keep the row ${row.state}`)
    }
  }
  if (screen.verdict) {
    const { verdict } = screen
    lines.push(`screen: rule ${verdict.rule} matched, ${verdict.state}${verdict.kind ? ` ${verdict.kind}` : ''} (${originText(verdict.origin, ctx)})`)
  } else if (screen.origin) {
    lines.push(
      `screen: no rule matched (${originText(screen.origin, ctx)})${screen.pendingQuiet ? `; rule ${screen.pendingQuiet} matches but the screen has not been quiet long enough` : ''}`
    )
  } else {
    lines.push('screen: no rules apply')
  }
  for (const entry of screen.ignored) lines.push(`warning: ignored ${originText(entry.origin, ctx)}: ${entry.reason}`)
  if (screen.unavailable) lines.push(`warning: ${screen.unavailable}`)
  return lines
}

/** One line per agent: `agent  origin  path-or-contribution  N rules`, then its ignored sources. */
export function listingLines(listings: RuleListing[], ctx: CliContext): string[] {
  if (listings.length === 0) return ['no detection rules']
  return listings.flatMap((listing) => [
    [listing.agent, listing.origin ? originKind(listing.origin) : '-', listing.origin ? originWhere(listing.origin, ctx) : '-', `${listing.rules} rules`].join('  '),
    ...listing.ignored.map((entry) => `  ignored ${originText(entry.origin, ctx)}: ${entry.reason}`)
  ])
}

function describeRule(rule: RuleFile['rules'][number]): string {
  const region = rule.region === 'screen' && rule.lastLines !== undefined ? `screen last ${rule.lastLines}` : rule.region
  const extras = [rule.quietMs ? `quiet ${rule.quietMs}ms` : '', rule.why ?? ''].filter((part) => part !== '')
  return `${rule.id}  ${rule.state}${rule.kind ? ` ${rule.kind}` : ''}  ${region}${extras.length > 0 ? `  ${extras.join('; ')}` : ''}`
}

export const commands: CliModule['commands'] = {
  async explain(args, ctx) {
    const session = args.positionals[0]
    if (session === undefined) throw ctx.usage('missing <session>')
    const at = args.flags.at
    const explained = (await ctx.call('quirky.agent-status/explain', { session, ...(typeof at === 'number' ? { at } : {}) })) as Explanation
    ctx.out.result(explained, () => explanationLines(explained, ctx).join('\n'))
  },

  async 'rules-list'(_args, ctx) {
    const listings = (await ctx.call('quirky.agent-status/rules', {})) as RuleListing[]
    ctx.out.result(listings, () => listingLines(listings, ctx).join('\n'))
  },

  async 'rules-show'(args, ctx) {
    const agent = args.positionals[0]
    if (agent === undefined) throw ctx.usage('missing <agent>')
    const found = (await ctx.call('quirky.agent-status/ruleSet', { agent })) as { agent: string; origin: Origin; set: RuleFile } | null
    if (found === null) throw ctx.fail(`no detection rules for ${agent}`)
    ctx.out.result(found, () =>
      [`${found.agent}  ${originText(found.origin, ctx)}${found.set.description ? `  ${found.set.description}` : ''}`, ...found.set.rules.map(describeRule)].join('\n')
    )
  },

  async get(args, ctx) {
    const session = args.positionals[0]
    if (session === undefined) throw ctx.usage('missing <session>')
    const at = args.flags.at
    const row = await ctx.call('quirky.agent-status/get', { session, ...(typeof at === 'number' ? { at } : {}) })
    ctx.out.result(row, () => (row === null ? 'no agent status' : JSON.stringify(row, null, 2)))
  },

  async 'hooks-status'(_args, ctx) {
    const entries = (await ctx.call('quirky.agent-status/hooksStatus', {})) as StatusEntry[]
    ctx.out.result(entries, () => entries.map((entry) => agentLine(entry.agent, entry.status, entry.message)).join('\n'))
  },

  async 'hooks-setup'(args, ctx) {
    const entries = (await ctx.call('quirky.agent-status/hooksSetup', agentArg(args.positionals))) as SetupEntry[]
    ctx.out.result(entries, () =>
      formatChanges(
        entries,
        entries.map((entry) => agentLine(entry.agent, entry.status, entry.note, entry.message)),
        ctx
      )
    )
  },

  async 'hooks-remove'(args, ctx) {
    const entries = (await ctx.call('quirky.agent-status/hooksRemove', agentArg(args.positionals))) as RemoveEntry[]
    ctx.out.result(entries, () =>
      formatChanges(
        entries,
        entries.map((entry) => agentLine(entry.agent, entry.changed.length > 0 ? 'removed' : 'nothing to remove', entry.message)),
        ctx
      )
    )
  }
}
