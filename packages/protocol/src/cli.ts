/** What a plugin CLI command receives: positionals in order and flags by name. */
export type CliArgs = { positionals: string[]; flags: Record<string, unknown> }

/** The CLI's services for a plugin CLI command. */
export type CliContext = {
  /** Calls a daemon method through the link: request IDs, `--yes` and confirmations apply. */
  call(method: string, params?: Record<string, unknown>): Promise<unknown>
  out: {
    json: boolean
    /** Prints `value` as JSON under `--json`, else the text. */
    result(value: unknown, text: () => string): void
    line(text: string): void
    jsonLine(value: unknown): void
  }
  format: {
    table(headers: string[], rows: string[][]): string
    record(pairs: [string, string][]): string
  }
  env: Record<string, string | undefined>
  cwd: string
  readFile(path: string): Promise<string>
  sleep(ms: number): Promise<void>
  now(): number
  /** An error the CLI reports as a usage mistake (exit 2). */
  usage(message: string): Error
  /** An error the CLI reports on stderr only (exit 1). */
  fail(message: string): Error
  reconnect(): Promise<void>
}

/** The shape a plugin's CLI module must export; keys are `cli-command` contribution names. */
export type CliModule = {
  commands: Record<string, (args: CliArgs, context: CliContext) => Promise<void>>
}
