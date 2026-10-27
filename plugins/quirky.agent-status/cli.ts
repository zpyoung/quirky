import type { CliContext, CliModule } from '@quirky/protocol'

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

export const commands: CliModule['commands'] = {
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
