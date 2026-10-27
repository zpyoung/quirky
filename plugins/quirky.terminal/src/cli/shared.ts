import type { CliArgs, CliContext, CliModule } from '@quirky/protocol'
import type { Workspace } from '../layout/types'
import { renderWorkspace } from './text'

export type Handler = CliModule['commands'][string]

const PANE_ID = /^pane-\d+$/

/** Rejects positionals beyond the `count` a command takes. */
export function atMost(args: CliArgs, ctx: CliContext, count: number): void {
  if (args.positionals.length > count) throw ctx.usage(`unexpected argument "${args.positionals[count]}"`)
}

/** The positional at `index`, or a usage error naming it. */
export function positional(args: CliArgs, ctx: CliContext, index: number, name: string): string {
  const value = args.positionals[index]
  if (value === undefined) throw ctx.usage(`missing <${name}>`)
  return value
}

export function stringFlag(args: CliArgs, name: string): string | undefined {
  const value = args.flags[name]
  return typeof value === 'string' ? value : undefined
}

/** The string flags among `names` that were given, keyed by name, ready to merge into call params. */
export function stringFlags(args: CliArgs, names: readonly string[]): Record<string, string> {
  const given: Record<string, string> = {}
  for (const name of names) {
    const value = stringFlag(args, name)
    if (value !== undefined) given[name] = value
  }
  return given
}

export function numberFlag(args: CliArgs, name: string): number | undefined {
  const value = args.flags[name]
  return typeof value === 'number' ? value : undefined
}

export function requiredNumber(args: CliArgs, ctx: CliContext, name: string): number {
  const value = numberFlag(args, name)
  if (value === undefined) throw ctx.usage(`missing required flag --${name}`)
  return value
}

/** Prints the workspace of a layout-changing result as the same tree `layout` prints. */
export function showWorkspace(ctx: CliContext, result: unknown): void {
  ctx.out.result(result, () => renderWorkspace((result as { workspace: Workspace }).workspace))
}

/**
 * The pane a command targets. A pane ID is used as given; any other value is a session ID and is
 * resolved to its pane. Without a value, the pane showing `$QUIRKY_SESSION_ID`.
 */
export async function paneIdOf(explicit: string | undefined, ctx: CliContext): Promise<string> {
  if (explicit !== undefined && PANE_ID.test(explicit)) return explicit
  const session = explicit ?? ctx.env.QUIRKY_SESSION_ID
  if (!session) throw ctx.usage('no pane; pass <pane> or set QUIRKY_SESSION_ID')
  const found = (await ctx.call('quirky.terminal/paneOf', { session })) as { pane: string }
  return found.pane
}

/** The `workspace` param for `--worktree W`; `--workspace` is accepted where a command declares it. */
export function workspaceParam(args: CliArgs, ctx: CliContext): { workspace?: string } {
  const worktree = stringFlag(args, 'worktree')
  const workspace = stringFlag(args, 'workspace')
  if (worktree !== undefined && workspace !== undefined) throw ctx.usage('pass --worktree or --workspace, not both')
  const chosen = worktree ?? workspace
  return chosen === undefined ? {} : { workspace: chosen }
}
