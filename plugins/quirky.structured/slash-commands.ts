import type { AgentCommand } from '@quirky/protocol'

/** A `/name` token at the start of the text or after whitespace; a name never holds a `/`, so paths and URLs never match. */
const COMMAND_TOKEN = /(^|\s)\/([^\s/]+)(?=\s|$)/g

type Token = { name: string; start: number; end: number }

function commandTokens(text: string): Token[] {
  return [...text.matchAll(COMMAND_TOKEN)].map((match) => {
    const start = match.index! + match[1]!.length
    return { name: match[2]!, start, end: start + 1 + match[2]!.length }
  })
}

/** The names of the known commands the text references with a `/name` token anywhere, in order and without repeats. */
export function referencedCommands(text: string, commands: readonly AgentCommand[]): string[] {
  const known = new Set(commands.map((command) => command.name))
  return [...new Set(commandTokens(text).map((token) => token.name).filter((name) => known.has(name)))]
}

/**
 * Rewrites a message whose first runnable command sits mid-text so the command opens it, for
 * harnesses that only run a leading `/name`. The prose around the token becomes the command's
 * arguments, so `fix the login /tdd focus on auth` becomes `/tdd fix the login focus on auth`.
 * Text that already opens with a known command, or names no command that may move, is returned as is.
 */
export function hoistCommand(text: string, commands: readonly AgentCommand[]): string {
  const byName = new Map(commands.map((command) => [command.name, command]))
  const tokens = commandTokens(text)
  const first = tokens[0]
  if (first && byName.has(first.name) && text.slice(0, first.start).trim() === '') return text
  const token = tokens.find((candidate) => {
    const command = byName.get(candidate.name)
    return command !== undefined && command.startOnly !== true
  })
  if (!token) return text
  const rest = [text.slice(0, token.start).trimEnd(), text.slice(token.end).trimStart()].filter((part) => part !== '').join(' ')
  return rest === '' ? `/${token.name}` : `/${token.name} ${rest}`
}
