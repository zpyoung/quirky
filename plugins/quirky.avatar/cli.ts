import type { CliArgs, CliContext, CliModule } from '@quirky/protocol'
import type { JournalEntry, NeedsYouItem, ReportModel, SwitchId, Switches, WorktreeState } from './src/contracts'

type Result = { worktreeId: string; ok: boolean; error?: string; handedBackWith?: string[] }

const SWITCH_NAMES: Record<string, SwitchId> = { messaging: 'messaging', 'history-rewrite': 'historyRewrite', historyRewrite: 'historyRewrite', deploys: 'deploys' }
const SWITCH_FLAGS: Record<string, SwitchId> = { 'allow-messaging': 'messaging', 'allow-history-rewrite': 'historyRewrite', 'allow-deploys': 'deploys' }

function list(value: unknown): string[] {
  return value === undefined ? [] : (Array.isArray(value) ? value : [value]).map(String)
}

function text(args: CliArgs, name: string): string | undefined {
  const value = args.flags[name]
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

async function resolveWorktree(ctx: CliContext, selector: string): Promise<string> {
  const worktree = (await ctx.call('quirky.worktree/resolve', { selector })) as { id: string }
  return worktree.id
}

function parseSwitches(args: CliArgs, ctx: CliContext): Partial<Switches> {
  const switches: Partial<Switches> = {}
  for (const entry of list(args.flags.switch)) {
    const [name = '', value, ...rest] = entry.split('=')
    const id = SWITCH_NAMES[name]
    if (id === undefined || rest.length > 0 || (value !== undefined && value !== 'true' && value !== 'false')) {
      throw ctx.usage(`--switch expects messaging, history-rewrite or deploys, optionally =true or =false, got "${entry}"`)
    }
    switches[id] = value !== 'false'
  }
  for (const [flag, id] of Object.entries(SWITCH_FLAGS)) {
    if (args.flags[flag] === true) switches[id] = true
  }
  return switches
}

function when(at: number): string {
  return new Date(at).toISOString().replace('T', ' ').slice(0, 19)
}

function reportText(report: ReportModel): string {
  const { summary } = report
  const lines = [
    `${summary.decisions} decisions: ${summary.allowed} allowed, ${summary.denied} denied, ${summary.held} held`,
    `${summary.guesses} ${summary.guesses === 1 ? 'guess' : 'guesses'}`,
    summary.sleeps.length === 0 ? 'the machine never slept' : `the machine slept ${summary.sleeps.length} ${summary.sleeps.length === 1 ? 'time' : 'times'}${summary.keptAwake ? '' : ' (not kept awake)'}`
  ]
  if (report.needsYou.length > 0) lines.push('', 'Needs you', ...report.needsYou.map((need: NeedsYouItem) => `- ${need.title}`))
  for (const story of report.stories) {
    lines.push('', story.switchesOn.length === 0 ? story.name : `${story.name} (${story.switchesOn.join(', ')} on)`, story.story)
    if (story.handedBackWith.length > 0) lines.push(`Handed back with: ${story.handedBackWith.join(', ')}`)
  }
  return lines.join('\n')
}

/** The `quirky avatar` commands: hand a worktree off, take it back, and read status, the report and the journal. */
export const commands: CliModule['commands'] = {
  /** Hands one worktree to the avatar with the same fields as the hand-off sheet; fails with the item's own error when it is refused. */
  async handoff(args, ctx) {
    if (args.positionals.length === 0) throw ctx.usage('a worktree is required')
    if (args.positionals.length > 1) throw ctx.usage('hand off one worktree at a time')
    const goal = text(args, 'goal')
    if (goal === undefined) throw ctx.usage('--goal is required')
    const doneWhen = text(args, 'done-when')
    if (doneWhen === undefined) throw ctx.usage('--done-when is required')
    const switches = parseSwitches(args, ctx)
    const selector = args.positionals[0]!
    const worktreeId = await resolveWorktree(ctx, selector)
    const guidelines = list(args.flags.guideline)
    const sharedGoal = text(args, 'shared-goal')
    const item = {
      worktreeId,
      goal,
      doneWhen,
      ...(text(args, 'level') === undefined ? {} : { level: text(args, 'level') }),
      ...(guidelines.length === 0 ? {} : { guidelines }),
      ...(Object.keys(switches).length === 0 ? {} : { switches }),
      ...(text(args, 'agent') === undefined ? {} : { agent: text(args, 'agent') }),
      ...(text(args, 'notes') === undefined ? {} : { notes: text(args, 'notes') }),
      ...(args.flags['allow-split'] === true ? { allowSplit: true } : {}),
      ...(sharedGoal === undefined ? {} : { sharedGoal: { goal: sharedGoal } })
    }
    const { results } = (await ctx.call('quirky.avatar/handoff', { items: [item] })) as { results: Result[] }
    const failed = results.find((result) => !result.ok)
    if (failed !== undefined) throw ctx.fail(failed.error ?? 'the hand-off failed')
    ctx.out.result(results, () => `Handed off ${selector} to the avatar.`)
  },

  async status(_args, ctx) {
    const status = (await ctx.call('quirky.avatar/status', {})) as { handoffs: { name: string; state: WorktreeState; level: string }[]; needsYouCount: number }
    ctx.out.result(status, () =>
      status.handoffs.length === 0
        ? 'Nothing is handed off to the avatar.'
        : `${ctx.format.table(['WORKTREE', 'STATE', 'LEVEL'], status.handoffs.map((row) => [row.name, row.state, row.level]))}\n${status.needsYouCount} need you`
    )
  },

  async report(_args, ctx) {
    const report = (await ctx.call('quirky.avatar/report', {})) as ReportModel
    ctx.out.result(report, () => reportText(report))
  },

  /** Prints the journal newest first, optionally for one worktree. */
  async log(args, ctx) {
    const params: Record<string, unknown> = {}
    const worktree = text(args, 'worktree')
    if (worktree !== undefined) params.worktreeId = await resolveWorktree(ctx, worktree)
    if (typeof args.flags.limit === 'number') params.limit = args.flags.limit
    if (typeof args.flags.before === 'number') params.before = args.flags.before
    const entries = (await ctx.call('quirky.avatar/log', params)) as JournalEntry[]
    ctx.out.result(entries, () =>
      entries.length === 0
        ? 'The journal is empty.'
        : entries.map((entry) => `#${entry.seq} ${when(entry.at)} ${entry.kind}${entry.worktreeId === null ? '' : ` ${entry.worktreeId}`} ${JSON.stringify(entry.data)}`).join('\n')
    )
  },

  /** Takes the named worktrees, or every handed-off one with `--all`, back from the avatar. Agents keep running. */
  async 'take-back'(args, ctx) {
    const all = args.flags.all === true
    if (all && args.positionals.length > 0) throw ctx.usage('name worktrees or pass --all, not both')
    if (!all && args.positionals.length === 0) throw ctx.usage('name a worktree or pass --all')
    const params = all ? { all: true } : { worktreeIds: await Promise.all(args.positionals.map((selector) => resolveWorktree(ctx, selector))) }
    const { results } = (await ctx.call('quirky.avatar/takeBack', params)) as { results: Result[] }
    ctx.out.result(results, () =>
      results.length === 0
        ? all ? 'Nothing was handed off.' : 'None of those worktrees was handed off.'
        : results.map((result) => `Took back ${result.worktreeId}${result.handedBackWith?.length ? ` (handed back with: ${result.handedBackWith.join(', ')})` : ''}`).join('\n')
    )
  }
}
