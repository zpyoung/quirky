import type { CliContext } from '@quirky/protocol'

/**
 * Reads the `--spec` argument: inline JSON, or `@path` read through the context. Returns the parsed
 * value, or the raw text when it is not JSON, so the daemon can refuse it and keep the source for
 * the transcript's error card. An unreadable file is a usage error.
 */
export async function readSpecArgument(arg: string, ctx: Pick<CliContext, 'readFile' | 'usage'>): Promise<unknown> {
  let text = arg
  if (arg.startsWith('@')) {
    const path = arg.slice(1)
    try {
      text = await ctx.readFile(path)
    } catch (error) {
      throw ctx.usage(`--spec: cannot read ${path}: ${(error as Error).message}`)
    }
  }
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
