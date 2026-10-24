import { GLOBAL_FLAGS, parseArgs, type FlagDefs, type ParsedArgs } from '../args'
import { ask, askCancel, askWait } from './ask'
import { open } from './open'
import { repoAdd, repoList, repoRm } from './repo'
import { sessionClose, sessionList, sessionNew } from './session'
import { status } from './status'
import { termRead, termSend } from './term'
import type { Command, Context } from './types'
import { wtCreate, wtList, wtRm } from './worktree'

export const USAGE_LINE = 'usage: quirky [--json] <command> [options]'

const help: Command = {
  name: 'help',
  usage: 'help [<command>]',
  summary: 'show help for quirky or one command',
  flags: {},
  async run(args, ctx) {
    ctx.out.line(helpText(args.positionals))
  }
}

export const COMMANDS: Command[] = [
  status,
  repoAdd,
  repoList,
  repoRm,
  wtList,
  wtCreate,
  wtRm,
  sessionList,
  sessionNew,
  sessionClose,
  termRead,
  termSend,
  ask,
  askWait,
  askCancel,
  open,
  help
]

const GLOBAL_TOKENS = new Set(['--json', '--help', '-h'])

export type Route =
  | { kind: 'command'; command: Command; rest: string[] }
  | { kind: 'group'; words: string[]; rest: string[] }
  | { kind: 'top'; rest: string[] }
  | { kind: 'unknown'; word: string }

/**
 * Picks the command named by the leading words of `argv` (global switches may be interleaved) and
 * returns the remaining tokens for that command's flag parser.
 */
export function route(argv: readonly string[], commands: readonly Command[] = COMMANDS): Route {
  const words: string[] = []
  const rest: string[] = []
  let i = 0
  for (; i < argv.length; i++) {
    const token = argv[i]
    if (GLOBAL_TOKENS.has(token)) {
      rest.push(token)
      continue
    }
    if (token.startsWith('-')) break
    const candidate = [...words, token].join(' ')
    if (!commands.some((command) => command.name === candidate || command.name.startsWith(`${candidate} `))) break
    words.push(token)
  }
  rest.push(...argv.slice(i))
  if (words.length === 0) {
    const first = argv.find((token) => !GLOBAL_TOKENS.has(token))
    return first === undefined ? { kind: 'top', rest } : { kind: 'unknown', word: first }
  }
  const command = commands.find((candidate) => candidate.name === words.join(' '))
  return command ? { kind: 'command', command, rest } : { kind: 'group', words, rest }
}

export function parseFor(command: Command, rest: string[]): ParsedArgs {
  const defs: FlagDefs = { ...GLOBAL_FLAGS, ...command.flags }
  return parseArgs(rest, defs)
}

export function helpText(topic: readonly string[] = []): string {
  const name = topic.join(' ')
  const exact = COMMANDS.find((command) => command.name === name)
  if (exact) {
    const flags = Object.keys(exact.flags)
    return [`usage: quirky ${exact.usage}`, '', exact.summary, ...(flags.length ? ['', `options: ${flags.map((f) => `--${f}`).join(' ')}`] : []), '', 'global: --json prints machine-readable JSON'].join('\n')
  }
  const group = name ? COMMANDS.filter((command) => command.name.startsWith(`${name} `)) : []
  const listed = group.length ? group : COMMANDS
  const width = Math.max(...listed.map((command) => command.usage.length))
  const lines = listed.map((command) => `  ${command.usage.padEnd(width)}  ${command.summary}`)
  const header = group.length ? `usage: quirky ${name} <command>` : USAGE_LINE
  return [header, '', 'commands:', ...lines, '', 'global: --json prints machine-readable JSON; <command> --help shows one command'].join('\n')
}
