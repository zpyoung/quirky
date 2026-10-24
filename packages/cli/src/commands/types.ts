import type { FlagDefs, ParsedArgs } from '../args'
import type { DaemonLink } from '../link'
import type { Printer } from '../output'

export type OpenResult = { ok: true } | { ok: false; reason: string }

/** Everything a command needs from its surroundings, injected so commands are testable. */
export type Context = {
  rpc: DaemonLink
  out: Printer
  env: Record<string, string | undefined>
  cwd: string
  readFile(path: string): string
  sleep(ms: number): Promise<void>
  now(): number
  openDesktopApp(): Promise<OpenResult>
}

export type Command = {
  /** Space-separated words that select the command, e.g. `wt create`. */
  name: string
  usage: string
  summary: string
  flags: FlagDefs
  run(args: ParsedArgs, ctx: Context): Promise<void>
}
