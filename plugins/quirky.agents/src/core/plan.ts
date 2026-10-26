import { joinCommand, quote, tokenize } from './shell'
import type { AgentConfig, AgentEntry, LaunchPlan, LaunchRecord, ProviderSession } from './types'

/** A launch or resume that can't be planned; the message is the text shown to the user. */
export class PlanError extends Error {}

const COMMAND_LINE_PROMPT_LIMIT_BYTES = 131_072
const HERMES_QUERY_LIMIT_BYTES = 24_000
const HERMES_QUERY_ENV = 'HERMES_QUIRKY_STARTUP_QUERY'
const HERMES_QUERY_ARG = '--query=__HERMES_QUIRKY_STARTUP_QUERY__'
const HERMES_QUERY_VARIABLE = '__quirky_hermes_startup_query'

type Resolve = (name: string) => string | null

const encoder = new TextEncoder()

function byteLength(text: string): number {
  return encoder.encode(text).byteLength
}

function tokenizeOrThrow(text: string, message: (reason: string) => string): string[] {
  const result = tokenize(text)
  if (!result.ok) throw new PlanError(message(result.error))
  return result.tokens
}

function commandTokens(text: string, resolve?: Resolve): string[] {
  const tokens = tokenizeOrThrow(text, (reason) => `Agent command override is invalid: ${reason}`)
  if (tokens.length === 0) throw new PlanError('Agent command override is invalid: the command is empty')
  const first = tokens[0]
  if (!first.includes('/')) {
    const resolved = resolve?.(first)
    if (resolved) tokens[0] = resolved
  }
  return tokens
}

function argTokens(text: string, entry: AgentEntry): string[] {
  const tokens = tokenizeOrThrow(text, (reason) => `CLI arguments are invalid: ${reason}`)
  return entry.stripArgs.length === 0 ? tokens : tokens.filter((token) => !entry.stripArgs.includes(token))
}

function templateTokens(entry: AgentEntry, template: string[], session: ProviderSession): string[] {
  const transcript = session.transcriptPath || null
  return template.map((part) =>
    part.replace(/\{(transcriptOrId|transcript|id)\}/g, (_, name: string) => {
      if (name === 'id') return session.id
      if (name === 'transcriptOrId') return transcript ?? session.id
      if (!transcript) throw new PlanError(`${entry.id} needs a transcript path to resume`)
      return transcript
    })
  )
}

function mergeEnv(...layers: Record<string, string | null>[]): Record<string, string | null> {
  return Object.assign({}, ...layers)
}

function isHermesExecutable(token: string): boolean {
  return (token.split('/').pop() ?? '').toLowerCase() === 'hermes'
}

const HERMES_VALUELESS_FLAGS = new Set([
  '--tui',
  '--cli',
  '--verbose',
  '-v',
  '--quiet',
  '-Q',
  '--worktree',
  '-w',
  '--accept-hooks',
  '--checkpoints',
  '--yolo',
  '--pass-session-id',
  '--ignore-user-config',
  '--ignore-rules',
  '--safe-mode',
  '--dev'
])

function findChatSubcommand(args: readonly string[]): number {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (token === 'chat') return index
    if (token.startsWith('-') && !token.includes('=') && !HERMES_VALUELESS_FLAGS.has(token)) index += 1
  }
  return -1
}

function withoutChat(args: readonly string[]): string[] {
  const index = findChatSubcommand(args)
  return index === -1 ? [...args] : args.filter((_, at) => at !== index)
}

function withoutOwnedHermesArgs(args: readonly string[]): string[] {
  const kept: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (token === '--query' || token === '-q') {
      index += 1
      continue
    }
    if (
      token.startsWith('--query=') ||
      token.startsWith('-q=') ||
      (token.startsWith('-q') && token.length > 2) ||
      token === '--tui' ||
      token === '--cli'
    ) {
      continue
    }
    kept.push(token)
  }
  return kept
}

/** Hermes argv with its subcommand and TUI mode fixed and the query slot marked; null when no `hermes` executable can be found. */
function hermesArgv(base: string[], configured: string[]): string[] | null {
  const candidates = base.flatMap((token, index) => (isHermesExecutable(token) ? [index] : []))
  let anchored: number | undefined
  for (const index of candidates) {
    if (findChatSubcommand(base.slice(index + 1)) !== -1) anchored = index
  }
  const executable = anchored ?? candidates.at(-1) ?? -1
  if (executable === -1) return null
  let prefix = base.slice(0, executable + 1)
  let assignments = 0
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(prefix[assignments] ?? '')) assignments += 1
  if (assignments > 0) prefix = ['env', ...prefix]
  return [
    ...prefix,
    'chat',
    HERMES_QUERY_ARG,
    ...withoutOwnedHermesArgs(withoutChat(base.slice(executable + 1))),
    ...withoutOwnedHermesArgs(withoutChat(configured)),
    '--tui'
  ]
}

function octalEscapes(text: string): string {
  return Array.from(encoder.encode(text), (byte) => `\\0${byte.toString(8).padStart(3, '0')}`).join('')
}

/** `sh -c` wrapper that moves the prompt from the environment into `--query=` and unsets it before hermes runs. */
function hermesQueryCommand(argv: string[]): string {
  const invocation = argv
    .map((token) => (token === HERMES_QUERY_ARG ? `"--query=\${${HERMES_QUERY_VARIABLE}}"` : quote(token, true)))
    .join(' ')
  const script =
    `${HERMES_QUERY_VARIABLE}="\${${HERMES_QUERY_ENV}}"; unset ${HERMES_QUERY_ENV}; ` +
    `eval "$(printf %b "${octalEscapes(invocation)}")"`
  return `sh -c ${quote(script, true)}`
}

export type LaunchPlanInput = {
  entry: AgentEntry
  config: AgentConfig
  prompt?: string
  /** False leaves the prompt in the agent's input without submitting it. */
  submitPrompt?: boolean
  hookArgs?: string[]
  hookEnv?: Record<string, string | null>
  /** Absolute path for a bare command name found outside the launch shell's PATH, or null. */
  resolveExecutable?: Resolve
}

function blank(text: string | null | undefined): boolean {
  return text === null || text === undefined || text.trim() === ''
}

/**
 * Plans one agent launch: the command string the launch shell will exec, the environment to
 * apply, the record a later resume replays, and how the first prompt travels. Pure; throws
 * `PlanError` for text that doesn't tokenize or a prompt containing NUL.
 */
export function buildLaunchPlan(input: LaunchPlanInput): LaunchPlan {
  const { entry, config } = input
  const hookArgs = input.hookArgs ?? []
  if (input.prompt?.includes('\0')) throw new PlanError('the prompt contains a NUL character')

  const commandText = blank(config.command) ? entry.launch : (config.command as string)
  const argsText = config.args ?? entry.yolo ?? ''
  const userEnv = config.env ?? entry.yoloEnv ?? {}
  const base = commandTokens(commandText, input.resolveExecutable)
  const userArgs = argTokens(argsText, entry)
  const env = mergeEnv(entry.env, userEnv, input.hookEnv ?? {})
  const record: LaunchRecord = { command: commandText, args: argsText, env: { ...userEnv } }
  const finish = (
    command: string,
    promptDelivery: LaunchPlan['promptDelivery'],
    paste: LaunchPlan['paste'],
    planEnv = env
  ): LaunchPlan => ({ agent: entry.id, command, env: planEnv, record, promptDelivery, paste })

  const head = [...base, ...userArgs, ...hookArgs]
  const plain = joinCommand(head)
  const prompt = input.prompt?.trim() ?? ''
  if (!prompt) return finish(plain, null, null)

  const submit = input.submitPrompt !== false
  const oversized = byteLength(prompt) > COMMAND_LINE_PROMPT_LIMIT_BYTES
  const paste = finish(plain, 'pending', { text: prompt, submit })
  const quoted = quote(prompt, true)

  if (!submit) {
    if (entry.draftFlag && !oversized) {
      return finish(`${plain} ${quote(entry.draftFlag)} ${quoted}`, 'command-line', null)
    }
    return paste
  }
  if (oversized || entry.prompt === 'stdin-after-start') return paste

  switch (entry.prompt) {
    case 'argv':
      return finish(`${plain}${entry.promptSeparator ? ` ${entry.promptSeparator}` : ''} ${quoted}`, 'command-line', null)
    case 'flag-prompt':
      return finish(`${plain} --prompt ${quoted}`, 'command-line', null)
    case 'flag-prompt-interactive':
      return finish(`${plain} --prompt-interactive ${quoted}`, 'command-line', null)
    case 'flag-interactive':
      return finish(`${plain} -i ${quoted}`, 'command-line', null)
    case 'hermes-query': {
      const argv = hermesArgv(base, [...userArgs, ...hookArgs])
      if (!argv) return paste
      const command = hermesQueryCommand(argv)
      const planEnv = mergeEnv(env, { [HERMES_QUERY_ENV]: prompt })
      const size =
        byteLength(command) +
        Object.entries(planEnv).reduce(
          (total, [key, value]) => total + (value === null ? 0 : byteLength(`${key}=${value}`) + 1),
          0
        )
      return size <= HERMES_QUERY_LIMIT_BYTES ? finish(command, 'command-line', null, planEnv) : paste
    }
    default:
      return paste
  }
}

function isClaudeExecutable(token: string): boolean {
  return /^claude$/i.test(token.split('/').pop() ?? '')
}

/** Index of the claude executable in command position (first, after NAME=value prefixes, or after a wrapper's `--`), else -1. */
function findClaudeExecutable(tokens: readonly string[]): number {
  let commandPosition = true
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (commandPosition) {
      if (isClaudeExecutable(token)) return index
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue
      commandPosition = false
    }
    if (token === '--') commandPosition = true
  }
  return -1
}

function isClaudeResumeSelector(token: string): boolean {
  return (
    token === '--resume' ||
    token.startsWith('--resume=') ||
    token === '--continue' ||
    token.startsWith('--continue=') ||
    token === '-r' ||
    token.startsWith('-r=') ||
    token === '-c' ||
    token.startsWith('-c=')
  )
}

/**
 * Claude's resume: drops any `--resume`/`--continue`/`-r`/`-c` selector (and the stale locator
 * after `--resume`/`-r`) from the recorded command, then puts `inserted` before claude's own `--`
 * terminator, or at the end. Appends unchanged when no claude executable can be located.
 */
function spliceClaudeResume(tokens: string[], inserted: string[]): string[] {
  const claude = findClaudeExecutable(tokens)
  if (claude === -1) return [...tokens, ...inserted]
  const kept = tokens.slice(0, claude + 1)
  let rest: string[] = []
  for (let index = claude + 1; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === '--') {
      rest = tokens.slice(index)
      break
    }
    if (!isClaudeResumeSelector(token)) {
      kept.push(token)
      continue
    }
    const next = tokens[index + 1]
    if ((token === '--resume' || token === '-r') && next !== undefined && !next.startsWith('-')) index += 1
  }
  return [...kept, ...inserted, ...rest]
}

export type ResumePlanInput = {
  entry: AgentEntry
  /** What the session launched with; null (a session from before records) resumes with the catalog command and no arguments. */
  record: LaunchRecord | null
  providerSession: ProviderSession
  fork: boolean
  hookArgs?: string[]
  hookEnv?: Record<string, string | null>
  resolveExecutable?: Resolve
}

/**
 * Plans a resume (or fork) from the launch record, never from the current configuration, so a
 * session comes back with the arguments and environment it started with. The returned `record`
 * is the one the new session stores.
 */
export function buildResumePlan(input: ResumePlanInput): {
  command: string
  env: Record<string, string | null>
  record: LaunchRecord
} {
  const { entry, providerSession } = input
  const template = input.fork ? entry.fork : entry.resume
  if (input.fork && !entry.fork) throw new PlanError(`${entry.id} can't fork from Quirky yet`)
  if (!template) throw new PlanError(`${entry.id} can't resume sessions`)

  const record: LaunchRecord = input.record
    ? { command: input.record.command, args: input.record.args, env: { ...input.record.env } }
    : { command: entry.launch, args: '', env: {} }
  const hookArgs = input.hookArgs ?? []
  const base = commandTokens(blank(record.command) ? entry.launch : record.command, input.resolveExecutable)
  const userArgs = argTokens(record.args, entry)
  const resume = templateTokens(entry, template, providerSession)
  const tokens =
    entry.resumeStyle === 'claude-splice'
      ? spliceClaudeResume([...base, ...userArgs], [...hookArgs, ...resume])
      : [...base, ...userArgs, ...hookArgs, ...resume]
  return {
    command: joinCommand(tokens),
    env: mergeEnv(entry.env, record.env, input.hookEnv ?? {}),
    record
  }
}
