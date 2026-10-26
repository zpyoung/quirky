import type { ParsedArgs } from '../args'
import type { FlagSpec, PositionalSpec } from '../command-spec'
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
  summary: string
  positionals: PositionalSpec[]
  flags: Record<string, FlagSpec>
  /** Every RPC method the command's run code may call. */
  methods: readonly string[]
  /** The contributing plugin's ID; `null` for kernel commands. */
  plugin: string | null
  /** Receives the tokens after the command words unparsed in `args.positionals`. */
  rawArgs?: true
  /** Required flags are documentation only; the run code checks them after merging `--params`. */
  deferRequired?: true
  /** The `kernel <name>` or `<plugin> <name>` command that wins over this generated one. */
  shadowedBy?: string
  run(args: ParsedArgs, ctx: Context): Promise<void>
}
