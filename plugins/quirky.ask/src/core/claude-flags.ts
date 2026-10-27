/** First Claude Code release where `--append-system-prompt` works in interactive sessions. */
export const CLAUDE_VERSION_FLOOR = '1.0.51'

export const SUPPRESSION_PROMPT =
  'When you need to ask the user a question, run quirky ask (see quirky ask --help) instead of asking in chat.'

type SuppressionPair = { flag: string; value: string; aliases: readonly string[] }

const SUPPRESSION_PAIRS: readonly SuppressionPair[] = [
  { flag: '--disallowedTools', value: 'AskUserQuestion', aliases: ['--disallowedTools', '--disallowed-tools'] },
  { flag: '--append-system-prompt', value: SUPPRESSION_PROMPT, aliases: ['--append-system-prompt', '--append-system-prompt-file'] }
]

/** True for `--flag` and for `--flag=value`, which sets the same flag. */
function hasFlag(tokens: readonly string[], flag: string): boolean {
  return tokens.some((token) => token === flag || token.startsWith(`${flag}=`))
}

/**
 * The suppression flag/value pairs, flattened in order, that `existing` does not already set under
 * the flag or one of its aliases. A flag the user configured is never doubled or overridden.
 */
export function missingSuppressionArgs(existing: readonly string[]): string[] {
  return SUPPRESSION_PAIRS.filter((pair) => !pair.aliases.some((alias) => hasFlag(existing, alias))).flatMap((pair) => [pair.flag, pair.value])
}

function parseVersion(text: string): [number, number, number] | null {
  const match = text.match(/(\d+)\.(\d+)\.(\d+)/)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

/**
 * Whether the first `x.y.z` in a `--version` output is at or above `floor`; null when the output
 * holds no such version.
 */
export function versionAtLeast(output: string, floor: string): boolean | null {
  const found = parseVersion(output)
  const wanted = parseVersion(floor)
  if (!found || !wanted) return null
  for (let i = 0; i < 3; i++) {
    if (found[i]! !== wanted[i]!) return found[i]! > wanted[i]!
  }
  return true
}
