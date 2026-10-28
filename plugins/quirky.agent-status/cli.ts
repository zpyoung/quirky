import { RpcError, type CliArgs, type CliContext, type CliModule } from '@quirky/protocol'
import type { Explanation } from './src/explain'
import type { ActivityThread } from './src/activity-types'
import type { DashboardBucket, DashboardSnapshot } from './src/dashboard-types'
import { unsafePatternReason } from './src/rules/safety'
import type { Matcher, Origin, RuleFile, RuleListing } from './src/rules/types'
import type { SendResult } from './src/send'
import type { OutputWaitResult, WaitResult } from './src/waits'

type SetupEntry = { agent: string; status: string; changed: string[]; note?: string; message?: string }
type RemoveEntry = { agent: string; changed: string[]; message?: string }
type StatusEntry = { agent: string; status: string; files: string[]; message?: string }
type StatusHostIdentity = {
  kind: 'local' | 'paired'
  id: string
  label?: string
  fingerprint?: string
  pairingRevision?: number
  incarnation?: string
}

const DASHBOARD_COLUMNS: { bucket: DashboardBucket; label: string }[] = [
  { bucket: 'attention', label: 'Needs you' },
  { bucket: 'working', label: 'Working' },
  { bucket: 'done', label: 'Done' },
  { bucket: 'idle', label: 'Idle' }
]

function dashboardLines(snapshot: DashboardSnapshot): string[] {
  const hidden = snapshot.hiddenIdle > 0 ? ` · ${snapshot.hiddenIdle} idle hidden` : ''
  const lines = [`${snapshot.total} total${hidden}`]
  for (const { bucket, label } of DASHBOARD_COLUMNS) {
    const cards = snapshot.cards.filter((card) => card.bucket === bucket)
    if (cards.length === 0 && (bucket === 'idle' || label === 'Idle')) continue
    lines.push(`${label} (${cards.length})`)
    for (const card of cards) {
      const { thread } = card
      const details = [thread.prompt, thread.detail].filter((value) => value !== '')
      lines.push(`  ${thread.sessionName} (${thread.sessionId}) @ ${thread.worktreeName} [${thread.agent}]${details.length > 0 ? `: ${details.join(' — ')}` : ''}${thread.live ? '' : ' (session unavailable)'}`)
    }
  }
  if (snapshot.cards.length === 0 && snapshot.total > 0) lines.push('Only hidden idle threads match.')
  else if (snapshot.total === 0) lines.push('no Dashboard threads match')
  for (const message of snapshot.unavailable) lines.push(`unavailable: ${message}`)
  return lines
}

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

function hostLine(host: StatusHostIdentity): string {
  if (host.kind === 'local') return 'Host: local'
  return `Host: ${host.id} (${host.label ?? host.id}) · fingerprint=${host.fingerprint ?? 'unknown'} · pairingRevision=${host.pairingRevision ?? 'unknown'} · incarnation=${host.incarnation ?? 'unknown'}`
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
        ? `because: ${because.rule} (${because.source}) ${ago(row.becauseAgeMs ?? row.ageMs)} ago`
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

const describeMatcher = (matcher: Matcher): string =>
  'contains' in matcher ? `contains ${JSON.stringify(matcher.contains)}` : `regex /${matcher.regex}/${matcher.ignoreCase ? 'i' : ''}`

/** One line per rule: id, state, region, quiet time, the `all` and `none` matchers, then why the rule exists. */
function describeRule(rule: RuleFile['rules'][number]): string {
  const region = rule.region === 'screen' && rule.lastLines !== undefined ? `screen last ${rule.lastLines}` : rule.region
  const matchers = [
    rule.all?.length ? `all: ${rule.all.map(describeMatcher).join(', ')}` : '',
    rule.none?.length ? `none: ${rule.none.map(describeMatcher).join(', ')}` : ''
  ].filter((part) => part !== '')
  const extras = [rule.quietMs ? `quiet ${rule.quietMs}ms` : '', matchers.join('; '), rule.why ?? ''].filter((part) => part !== '')
  return `${rule.id}  ${rule.state}${rule.kind ? ` ${rule.kind}` : ''}  ${region}${extras.length > 0 ? `  ${extras.join('  ')}` : ''}`
}

/** The prompt a `send` was given: the positional text, or the contents of `--file` (`-` is stdin) without its trailing line break. */
async function promptOf(args: CliArgs, ctx: CliContext): Promise<string> {
  const text = args.positionals[1]
  const file = args.flags.file
  if ((text === undefined) === (file === undefined)) throw ctx.usage('give the prompt as <text> or --file, not both and not neither')
  if (text !== undefined) return text
  const path = String(file)
  let body: string
  try {
    body = path === '-' ? await Bun.stdin.text() : await ctx.readFile(path)
  } catch (error) {
    throw ctx.usage(`--file: cannot read ${path}: ${(error as Error).message}`)
  }
  return body.replace(/(\r?\n)+$/, '')
}

const MAX_CALL_MS = 60_000
const MAX_CONSECUTIVE_CONNECTION_FAILURES = 10

/**
 * Repeats `call` (one server-side wait of at most a minute) until it settles `matched` or the
 * caller's `timeoutMs` is used up, in which case it returns the last `pending` result. A dropped
 * connection is re-established and the wait continues; errors the daemon answered are rethrown.
 */
async function longPoll<T extends { status: string }>(ctx: CliContext, timeoutMs: number | undefined, call: (callMs: number) => Promise<T>): Promise<T> {
  const startedAt = ctx.now()
  let failures = 0
  for (;;) {
    const left = timeoutMs === undefined ? MAX_CALL_MS : Math.max(0, timeoutMs - (ctx.now() - startedAt))
    let result: T
    try {
      result = await call(Math.min(MAX_CALL_MS, Math.ceil(left)))
      failures = 0
    } catch (error) {
      if (error instanceof RpcError || ++failures > MAX_CONSECUTIVE_CONNECTION_FAILURES) throw error
      await ctx.sleep(Math.min(500 * failures, 5000))
      await ctx.reconnect().catch(() => {})
      continue
    }
    if (result.status !== 'pending' || (timeoutMs !== undefined && ctx.now() - startedAt >= timeoutMs)) return result
  }
}

const seconds = (ms: number) => `${Math.round(ms / 100) / 10}s`

function timeoutFlag(args: CliArgs, ctx: CliContext): number | undefined {
  const value = args.flags['timeout-ms']
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw ctx.usage('--timeout-ms must be an integer of at least 0')
  return value
}

export const commands: CliModule['commands'] = {
  async explain(args, ctx) {
    const session = args.positionals[0]
    if (session === undefined) throw ctx.usage('missing <session>')
    const at = args.flags.at
    const explained = (await ctx.call('quirky.agent-status/explain', { session, ...(typeof at === 'number' ? { at } : {}) })) as Explanation
    ctx.out.result(explained, () => explanationLines(explained, ctx).join('\n'))
  },

  async send(args, ctx) {
    const session = args.positionals[0]
    if (session === undefined) throw ctx.usage('missing <session>')
    const text = await promptOf(args, ctx)
    if (text === '') throw ctx.usage('the prompt is empty')
    const timeout = args.flags['start-timeout-ms']
    const sent = (await ctx.call('quirky.agent-status/send', {
      session,
      text,
      ...(typeof timeout === 'number' ? { startTimeoutMs: timeout } : {})
    })) as SendResult
    ctx.out.result(sent, () => `${sent.session}: ${sent.state}${sent.state === 'blocked' && sent.kind ? ` (${sent.kind})` : ''}`)
  },

  async wait(args, ctx) {
    const session = args.positionals[0]
    if (session === undefined) throw ctx.usage('missing <session>')
    const timeoutMs = timeoutFlag(args, ctx)
    const output = args.flags.output
    const until = args.flags.until
    if (output !== undefined && until !== undefined) throw ctx.usage('give --until or --output, not both')

    if (output !== undefined) {
      const pattern = String(output)
      const reason = unsafePatternReason(pattern)
      if (reason !== null) throw ctx.usage(`--output pattern ${reason}`)
      const lines = args.flags.lines
      const found = await longPoll(
        ctx,
        timeoutMs,
        (callMs) =>
          ctx.call('quirky.agent-status/waitOutput', {
            session,
            pattern,
            ...(args.flags['ignore-case'] === true ? { ignoreCase: true } : {}),
            ...(typeof lines === 'number' ? { lines } : {}),
            timeoutMs: callMs
          }) as Promise<OutputWaitResult>
      )
      if (found.status === 'matched') {
        ctx.out.result(found, () => [found.line, ...found.groups.map((group, index) => `group ${index + 1}: ${group}`)].join('\n'))
        return
      }
      const text = `timed out after ${seconds(timeoutMs ?? 0)}; no line matched ${pattern}`
      ctx.out.result({ status: 'timeout', pattern }, () => text)
      throw ctx.fail(text)
    }

    const wanted = until === undefined ? undefined : String(until).split(',').map((state) => state.trim())
    const reached = await longPoll(
      ctx,
      timeoutMs,
      (callMs) => ctx.call('quirky.agent-status/wait', { session, ...(wanted !== undefined ? { until: wanted } : {}), timeoutMs: callMs }) as Promise<WaitResult>
    )
    const kind = reached.state === 'blocked' && reached.kind ? ` (${reached.kind})` : ''
    if (reached.status === 'matched') {
      ctx.out.result(reached, () => `${session}: ${reached.state}${kind}`)
      return
    }
    const text = `timed out after ${seconds(timeoutMs ?? 0)}; ${session} is ${reached.state}${kind}`
    ctx.out.result({ ...reached, status: 'timeout' }, () => text)
    throw ctx.fail(text)
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
    const host = args.flags.host
    if (host !== undefined && typeof host !== 'string') throw ctx.usage('--host must be a string')
    const params = { session, ...(typeof at === 'number' ? { at } : {}) }
    const row = typeof host === 'string'
      ? await ctx.call('quirky.agent-status/getOnHost', { ...params, host })
      : await ctx.call('quirky.agent-status/get', params)
    ctx.out.result(row, () => (row === null ? 'no agent status' : JSON.stringify(row, null, 2)))
  },
  async activity(args, ctx) {
    const worktree = args.flags.worktree
    const text = args.flags.text
    const result = (await ctx.call('quirky.agent-status/activity', {
      ...(typeof worktree === 'string' ? { worktree } : {}),
      ...(typeof text === 'string' ? { text } : {}),
      ...(args.flags['unread-only'] === true ? { unreadOnly: true } : {})
    })) as { threads: ActivityThread[] }
    ctx.out.result(result, () =>
      result.threads.length === 0
        ? 'no Activity threads match'
        : result.threads
            .map(
              (thread) =>
                `${thread.unread ? 'unread' : 'read'} ${thread.label} — ${thread.sessionName} (${thread.sessionId}) @ ${thread.worktreeName} [${thread.agent}]${thread.prompt ? `: ${thread.prompt}` : ''}${thread.live ? '' : ' (session unavailable)'}`
            )
            .join('\n')
    )
  },
  async dashboard(args, ctx) {
    const text = args.flags.text
    const project = args.flags.project
    const workspaceStatus = args.flags['workspace-status']
    const reviewStatus = args.flags['review-status']
    const snapshot = (await ctx.call('quirky.agent-status/dashboard', {
      ...(typeof text === 'string' ? { text } : {}),
      ...(typeof project === 'string' ? { project } : {}),
      ...(typeof workspaceStatus === 'string' ? { workspaceStatus } : {}),
      ...(typeof reviewStatus === 'string' ? { reviewStatus } : {}),
      ...(args.flags['show-idle'] === true ? { showIdle: true } : {})
    })) as DashboardSnapshot
    ctx.out.result(snapshot, () => dashboardLines(snapshot).join('\n'))
  },

  async acknowledge(args, ctx) {
    const session = args.positionals[0]
    const turn = args.flags.turn
    const all = args.flags.all === true
    if (all && (session !== undefined || turn !== undefined)) throw ctx.usage('--all cannot be combined with <session> or --turn')
    if (!all && session === undefined) throw ctx.usage('give <session> or --all')
    if (turn !== undefined && typeof turn !== 'string') throw ctx.usage('--turn must be a string')
    const params = all ? { all: true } : { session: session!, ...(typeof turn === 'string' ? { turn } : {}) }
    const result = (await ctx.call('quirky.agent-status/acknowledge', params)) as { acknowledged: number }
    ctx.out.result(result, () => `acknowledged ${result.acknowledged} ${result.acknowledged === 1 ? 'thread' : 'threads'}`)
  },

  async 'clear-completed'(args, ctx) {
    const worktree = args.flags.worktree
    if (worktree !== undefined && typeof worktree !== 'string') throw ctx.usage('--worktree must be a string')
    const result = (await ctx.call('quirky.agent-status/clearCompleted', typeof worktree === 'string' ? { worktree } : {})) as { cleared: number }
    ctx.out.result(result, () => `cleared ${result.cleared} terminal ${result.cleared === 1 ? 'thread' : 'threads'}`)
  },


  async 'hooks-status'(args, ctx) {
    const host = args.flags.host
    if (host !== undefined && typeof host !== 'string') throw ctx.usage('--host must be a string')
    if (host === undefined) {
      const entries = (await ctx.call('quirky.agent-status/hooksStatus', {})) as StatusEntry[]
      ctx.out.result(entries, () => entries.map((entry) => agentLine(entry.agent, entry.status, entry.message)).join('\n'))
      return
    }
    const result = (await ctx.call('quirky.agent-status/hooksStatusOnHost', { host })) as {
      host: StatusHostIdentity
      result: StatusEntry[]
    }
    ctx.out.result(result, () => [hostLine(result.host), ...result.result.map((entry) => agentLine(entry.agent, entry.status, entry.message))].join('\n'))
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
