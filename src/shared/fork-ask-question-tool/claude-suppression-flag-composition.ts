import {
  CLAUDE_ASK_SUPPRESSION_DISALLOWED_TOOLS_FLAG,
  CLAUDE_ASK_SUPPRESSION_DISALLOWED_TOOLS_VALUE,
  CLAUDE_ASK_SUPPRESSION_SYSTEM_PROMPT_FLAG,
  CLAUDE_ASK_SUPPRESSION_SYSTEM_PROMPT_VALUE
} from './claude-suppression-flags'
import {
  quoteStartupArg,
  tokenizeStartupCommand,
  type AgentStartupShell
} from '../tui-agent-startup-shell'
import { resolveClaudeSuppressionVerdict } from './claude-suppression-verdict'
import type { TuiAgent } from '../tui-agent'

type SuppressionPair = {
  flag: string
  value: string
  aliases: readonly string[]
}

const SUPPRESSION_PAIRS: readonly SuppressionPair[] = [
  {
    flag: CLAUDE_ASK_SUPPRESSION_DISALLOWED_TOOLS_FLAG,
    value: CLAUDE_ASK_SUPPRESSION_DISALLOWED_TOOLS_VALUE,
    aliases: ['--disallowedTools', '--disallowed-tools']
  },
  {
    flag: CLAUDE_ASK_SUPPRESSION_SYSTEM_PROMPT_FLAG,
    value: CLAUDE_ASK_SUPPRESSION_SYSTEM_PROMPT_VALUE,
    aliases: ['--append-system-prompt', '--append-system-prompt-file']
  }
]

function tokensOf(text: string, shell: AgentStartupShell): readonly string[] {
  const tokenized = tokenizeStartupCommand(text, shell)
  return tokenized.ok ? tokenized.tokens : []
}

// `--flag=value` sets the same flag as a bare `--flag` token, so both count as a collision here.
function tokenCollidesWithAlias(tokens: readonly string[], alias: string): boolean {
  return tokens.some((token) => token === alias || token.startsWith(`${alias}=`))
}

function pairsMissingFrom(scanText: string, shell: AgentStartupShell): readonly SuppressionPair[] {
  const tokens = tokensOf(scanText, shell)
  return SUPPRESSION_PAIRS.filter(
    (pair) => !pair.aliases.some((alias) => tokenCollidesWithAlias(tokens, alias))
  )
}

function quotedPair(pair: SuppressionPair, shell: AgentStartupShell): string {
  return `${quoteStartupArg(pair.flag, shell)} ${quoteStartupArg(pair.value, shell)}`
}

function appendPairs(
  command: string,
  pairs: readonly SuppressionPair[],
  shell: AgentStartupShell
): string {
  if (pairs.length === 0) {
    return command
  }
  return `${command} ${pairs.map((pair) => quotedPair(pair, shell)).join(' ')}`
}

export type ClaudeLaunchCommandFlagsInput = {
  agent: TuiAgent
  shell: AgentStartupShell
  /** The user's raw `agentCmdOverrides` string for this agent, if any — scanned
   *  in place of the resolved command per the per-flag-skip contract. */
  override?: string | null
  command: string
  commandWithoutSessionOptions: string
  /** Omit to take this process's ambient local verdict; pass a value only when the
   *  caller knows the launch host itself. */
  claudeSuppressionFlags?: string[] | null
  isRemote?: boolean
}

/**
 * Appends Quirky's AskUserQuestion suppression flags to a Claude launch command.
 * Skips a flag already present in the effective command (the user's override,
 * else the resolved command) rather than duplicating or rewriting it, and is a
 * no-op for any agent but `claude` or for any verdict short of flags to inject —
 * preserving today's output byte-for-byte in both cases.
 */
export function appendClaudeSuppressionFlags(args: ClaudeLaunchCommandFlagsInput): {
  command: string
  commandWithoutSessionOptions: string
} {
  const identity = {
    command: args.command,
    commandWithoutSessionOptions: args.commandWithoutSessionOptions
  }
  if (args.agent !== 'claude') {
    return identity
  }
  const verdict = resolveClaudeSuppressionVerdict({
    explicit: args.claudeSuppressionFlags,
    isRemote: args.isRemote
  })
  if (verdict === 'pending' || !verdict?.length) {
    return identity
  }
  const pairs = pairsMissingFrom(args.override || args.command, args.shell)
  return {
    command: appendPairs(args.command, pairs, args.shell),
    commandWithoutSessionOptions: appendPairs(args.commandWithoutSessionOptions, pairs, args.shell)
  }
}

/**
 * Reconciles a resumed session's captured launch command against a freshly
 * re-evaluated gate verdict. A non-null verdict injects any suppression pair
 * the capture is missing (per-flag skip prevents duplicating one already
 * baked in from the original launch); a null verdict strips exactly the
 * token pairs Quirky itself injected, matched against its own literal flag and
 * value — a user-authored flag, even one with the same name, is left alone
 * unless its value is byte-identical to Quirky's, so this can only remove what
 * Quirky put there. A pending verdict leaves the capture exactly as it is.
 */
export function applyClaudeSuppressionFlagsToResumeCommand(args: {
  agent: TuiAgent
  shell: AgentStartupShell
  command: string
  claudeSuppressionFlags?: string[] | null
  isRemote?: boolean
}): string {
  if (args.agent !== 'claude') {
    return args.command
  }
  const verdict = resolveClaudeSuppressionVerdict({
    explicit: args.claudeSuppressionFlags,
    isRemote: args.isRemote
  })
  // A cold restore resumes before the version probe lands, and stripping on an unread verdict
  // would un-suppress every restored session on every boot.
  if (verdict === 'pending') {
    return args.command
  }
  if (verdict?.length) {
    return appendPairs(args.command, pairsMissingFrom(args.command, args.shell), args.shell)
  }
  return SUPPRESSION_PAIRS.reduce(
    (command, pair) => command.replace(` ${quotedPair(pair, args.shell)}`, ''),
    args.command
  )
}
