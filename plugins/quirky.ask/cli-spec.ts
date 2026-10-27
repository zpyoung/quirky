import type { AskSpec, CliContext } from '@quirky/protocol'
import { formatSpecErrors, validateAskSpec } from './src/core/spec'

/**
 * Parses the `--spec` argument (inline JSON, or `@path` read through the context) and validates it
 * with the daemon's validator. Every refusal is a usage error carrying the validator's message.
 */
export async function parseSpecArgument(arg: string, ctx: Pick<CliContext, 'readFile' | 'usage'>): Promise<AskSpec> {
  let text = arg
  if (arg.startsWith('@')) {
    const path = arg.slice(1)
    try {
      text = await ctx.readFile(path)
    } catch (error) {
      throw ctx.usage(`--spec: cannot read ${path}: ${(error as Error).message}`)
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw ctx.usage(`Invalid JSON for --spec: ${(error as Error).message}`)
  }
  const result = validateAskSpec(parsed, { checkCredentialText: true })
  if (!result.ok) throw ctx.usage(formatSpecErrors(result.errors))
  return result.spec
}
