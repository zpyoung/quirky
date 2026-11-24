import type { TuiAgent } from '../tui-agent'

const CLAUDE_EFFORT_OPTION_ALIASES = ['--effort'] as const
const CODEX_EFFORT_OPTION_ALIASES = ['--reasoning-effort'] as const

type OptionOccurrence = { index: number; consumed: number }

function matchesOption(token: string, aliases: readonly string[]): boolean {
  return aliases.some(
    (alias) =>
      token === alias ||
      token.startsWith(`${alias}=`) ||
      (alias.startsWith('-') &&
        !alias.startsWith('--') &&
        token.startsWith(alias) &&
        token.length > alias.length)
  )
}

function matchesConfigOption(
  tokens: readonly string[],
  index: number,
  configKey: string | undefined
): number {
  if (!configKey) {
    return 0
  }
  const token = tokens[index]
  const next = tokens[index + 1]
  if ((token === '-c' || token === '--config') && next?.startsWith(`${configKey}=`)) {
    return 2
  }
  return token.startsWith(`-c${configKey}=`) ||
    token.startsWith(`-c=${configKey}=`) ||
    token.startsWith(`--config=${configKey}=`)
    ? 1
    : 0
}

function findOptionOccurrences(
  tokens: string[],
  aliases: readonly string[],
  stopAtTerminator: boolean,
  configKey?: string
): OptionOccurrence[] {
  const occurrences: OptionOccurrence[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (stopAtTerminator && token === '--') {
      break
    }
    const configConsumed = matchesConfigOption(tokens, index, configKey)
    if (configConsumed > 0) {
      occurrences.push({ index, consumed: configConsumed })
      index += configConsumed - 1
      continue
    }
    if (!matchesOption(token, aliases)) {
      continue
    }
    const nextToken = tokens[index + 1]
    const consumesNext =
      aliases.includes(token) && nextToken !== undefined && !nextToken.startsWith('-')
    occurrences.push({ index, consumed: consumesNext ? 2 : 1 })
    if (consumesNext) {
      index += 1
    }
  }
  return occurrences
}

function removeOptionOccurrences(tokens: string[], occurrences: OptionOccurrence[]): string[] {
  const removed = new Set<number>()
  for (const occurrence of occurrences) {
    for (let offset = 0; offset < occurrence.consumed; offset += 1) {
      removed.add(occurrence.index + offset)
    }
  }
  return tokens.filter((_, index) => !removed.has(index))
}

function applyRecipeOptionOverride(args: {
  generatedArgs: string[]
  recipeArgs: string[]
  aliases: readonly string[]
  configKey?: string
}): { generatedArgs: string[]; recipeArgs: string[] } {
  const recipeOptions = findOptionOccurrences(args.recipeArgs, args.aliases, true, args.configKey)
  const generatedOptions = findOptionOccurrences(
    args.generatedArgs,
    args.aliases,
    false,
    args.configKey
  )
  const recipeOption = recipeOptions[0]
  const generatedOption = generatedOptions[0]
  if (!recipeOption || !generatedOption) {
    return { generatedArgs: args.generatedArgs, recipeArgs: args.recipeArgs }
  }

  const overrideTokens = args.recipeArgs.slice(
    recipeOption.index,
    recipeOption.index + recipeOption.consumed
  )
  return {
    generatedArgs: [
      ...args.generatedArgs.slice(0, generatedOption.index),
      ...overrideTokens,
      ...args.generatedArgs.slice(generatedOption.index + generatedOption.consumed)
    ],
    recipeArgs: removeOptionOccurrences(args.recipeArgs, recipeOptions)
  }
}

/** Lets recipe CLI arguments replace the effort flag Quirky generated. Model flags are
 *  handled by the spec-driven singleton pass; only effort needs per-agent alias shapes. */
export function applyCommitMessageRecipeEffortOverrides(
  agentId: TuiAgent,
  generatedArgs: string[],
  recipeArgs: string[]
): { generatedArgs: string[]; recipeArgs: string[] } {
  const options =
    agentId === 'claude'
      ? [{ aliases: CLAUDE_EFFORT_OPTION_ALIASES }]
      : agentId === 'codex'
        ? [{ aliases: CODEX_EFFORT_OPTION_ALIASES, configKey: 'model_reasoning_effort' }]
        : []
  return options.reduce((current, option) => applyRecipeOptionOverride({ ...current, ...option }), {
    generatedArgs,
    recipeArgs
  })
}
