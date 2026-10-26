import { parseArgs, type ParsedArgs } from '../args'
import { commandHelp, usageOf } from '../command-spec'
import { api, apiCall } from './api'
import { jobList, jobRun } from './job'
import { daemonRestart } from './daemon'
import { distroInspect, distroInstall, distroList, distroRemove } from './distro'
import { open } from './open'
import {
  pluginActivate,
  pluginContributions,
  pluginDisable,
  pluginEnable,
  pluginInspect,
  pluginInstall,
  pluginList,
  pluginUninstall
} from './plugin'
import { settingGet, settingList, settingReset, settingSet } from './setting'
import { skillInstall, skillShow, skillStatus } from './skill'
import { status } from './status'
import { themeList, themeSet } from './theme'
import {
  uiClosePanel,
  uiCloseView,
  uiContributions,
  uiFocus,
  uiOpenPanel,
  uiOpenView,
  uiRun,
  uiSidebar,
  uiState
} from './ui'
import type { Command, Context } from './types'

export const USAGE_LINE = 'usage: quirky [--json] <command> [options]'

const help: Command = {
  name: 'help',
  summary: 'show help for quirky or one command',
  positionals: [{ name: 'command', description: 'the command to show help for', required: false }],
  flags: {},
  methods: [],
  plugin: null,
  async run(args, ctx) {
    ctx.out.line(helpText(args.positionals))
  }
}

export const COMMANDS: Command[] = [
  status,
  pluginList,
  pluginContributions,
  pluginEnable,
  pluginDisable,
  pluginActivate,
  pluginInspect,
  pluginInstall,
  pluginUninstall,
  distroInspect,
  distroInstall,
  distroList,
  distroRemove,
  daemonRestart,
  jobList,
  jobRun,
  uiContributions,
  uiState,
  uiOpenView,
  uiCloseView,
  uiOpenPanel,
  uiClosePanel,
  uiSidebar,
  uiFocus,
  uiRun,
  settingList,
  settingGet,
  settingSet,
  settingReset,
  themeList,
  themeSet,
  open,
  api,
  apiCall,
  skillShow,
  skillInstall,
  skillStatus,
  help
]

const GLOBAL_TOKENS = new Set(['--json', '--json=true', '--json=false', '--help', '-h', '--yes', '--version', '-v'])

/** True for the switches every command accepts: `--json` (with or without a value), `--help`, `-h`, `--yes`, `--version` and `-v`. */
export function isGlobalToken(token: string): boolean {
  return GLOBAL_TOKENS.has(token)
}

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
  return parseArgs(rest, command.flags, command.name, { checkRequired: !command.deferRequired })
}

/**
 * Help for the whole CLI, a group of commands, or one command, from the declarations in `commands`
 * (the kernel's by default, which never contacts the daemon).
 */
export function helpText(topic: readonly string[] = [], commands: readonly Command[] = COMMANDS): string {
  const name = topic.join(' ')
  const exact = commands.find((command) => command.name === name)
  if (exact) return commandHelp(exact)
  const group = name ? commands.filter((command) => command.name.startsWith(`${name} `)) : []
  const listed = group.length ? group : commands.filter((command) => command.aliasOf === undefined)
  const usages = listed.map(usageOf)
  const width = Math.max(...usages.map((usage) => usage.length))
  const lines = listed.map((command, i) => `  ${usages[i].padEnd(width)}  ${command.summary}`)
  const footer =
    'global: --json prints machine-readable JSON; --yes skips confirmations; --retry-request <id> reissues a call; --version prints the version; <command> --help shows one command'
  if (group.length) return [`usage: quirky ${name} <command>`, '', 'commands:', ...lines, '', footer].join('\n')
  return [USAGE_LINE, '', 'commands:', ...lines, '', footer, "run 'quirky api' to list every command, including plugins'"].join('\n')
}
