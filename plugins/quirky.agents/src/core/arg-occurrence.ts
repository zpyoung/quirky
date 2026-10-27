import type { Conflict } from './types'

export type Occurrence = { index: number; consumed: number; value?: string }

function matchesOption(token: string, aliases: readonly string[]): boolean {
  return aliases.some(
    (alias) =>
      token === alias ||
      (alias !== '--' && token.startsWith(`${alias}=`)) ||
      (alias.startsWith('-') && !alias.startsWith('--') && token.startsWith(alias) && token.length > alias.length)
  )
}

/**
 * Finds the first occurrence of any of `aliases`: `--flag value`, `--flag=value`, or `-fvalue` for
 * single-dash aliases. A following token is only consumed as the value when it doesn't start with `-`.
 * `valueFlags` name flags whose next token is always a value, so it is skipped even when it looks like a flag.
 * With `stopAtTerminator`, scanning ends at the first `--`.
 */
export function findOptionOccurrence(
  tokens: readonly string[],
  aliases: readonly string[],
  stopAtTerminator: boolean,
  valueFlags: readonly string[] = []
): Occurrence | null {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!
    if (stopAtTerminator && token === '--') break
    if (!matchesOption(token, aliases)) {
      if (valueFlags.includes(token)) index += 1
      continue
    }
    const next = tokens[index + 1]
    const consumesNext = aliases.includes(token) && next !== undefined && !next.startsWith('-')
    const alias = aliases.find((name) => matchesOption(token, [name]))
    const value = consumesNext
      ? next
      : alias && token !== alias
        ? token.slice(alias.length + (token[alias.length] === '=' ? 1 : 0))
        : undefined
    return { index, consumed: consumesNext ? 2 : 1, value }
  }
  return null
}

/** Index of the first `--` that is not a value flag's value, or `tokens.length` when there is none. */
export function terminatorIndex(tokens: readonly string[], valueFlags: readonly string[] = []): number {
  return findOptionOccurrence(tokens, ['--'], false, valueFlags)?.index ?? tokens.length
}

/**
 * Returns `tokens` without every occurrence of the conflict's flags before the first real `--`.
 * With `valuePrefix`, only occurrences whose value starts with it are removed.
 */
export function removeOption(tokens: readonly string[], conflict: Conflict, valueFlags: readonly string[] = []): string[] {
  const { flags, valuePrefix } = conflict
  const accepts = (value: string | undefined) => valuePrefix === undefined || (value?.startsWith(valuePrefix) ?? false)
  const kept: string[] = []
  let rest = tokens
  let found = findOptionOccurrence(rest, flags, true, valueFlags)
  while (found) {
    const end = found.index + found.consumed
    kept.push(...rest.slice(0, accepts(found.value) ? found.index : end))
    rest = rest.slice(end)
    found = findOptionOccurrence(rest, flags, true, valueFlags)
  }
  return [...kept, ...rest]
}

/** Whether `removeOption` would remove anything. */
export function hasOption(tokens: readonly string[], conflict: Conflict, valueFlags: readonly string[] = []): boolean {
  return removeOption(tokens, conflict, valueFlags).length < tokens.length
}

/**
 * Whether any occurrence of the conflict's flags appears in `tokens`, past a `--` too. For a
 * command override, where a wrapper's own terminator doesn't end the agent's arguments.
 */
export function hasOptionAnywhere(tokens: readonly string[], conflict: Conflict, valueFlags: readonly string[] = []): boolean {
  const { flags, valuePrefix } = conflict
  let rest = tokens
  for (let found = findOptionOccurrence(rest, flags, false, valueFlags); found; found = findOptionOccurrence(rest, flags, false, valueFlags)) {
    if (valuePrefix === undefined || (found.value?.startsWith(valuePrefix) ?? false)) return true
    rest = rest.slice(found.index + found.consumed)
  }
  return false
}

/** Applies each conflict's removal in turn. */
export function removeConflicts(tokens: readonly string[], conflicts: readonly Conflict[], valueFlags: readonly string[] = []): string[] {
  return conflicts.reduce<string[]>((current, conflict) => removeOption(current, conflict, valueFlags), [...tokens])
}
