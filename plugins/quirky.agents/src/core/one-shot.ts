import { findOptionOccurrence } from './arg-occurrence'
import { tokenize } from './shell'
import type { AgentEntry, OneShotSpec } from './types'

/** A one-shot command that can't be built; the message is the text shown to the user. */
export class OneShotError extends Error {}

const STRICT_MCP_FLAG = '--strict-mcp-config'
const ENTERPRISE_REFUSAL = 'You cannot use --strict-mcp-config when an enterprise MCP config is present'
const PROMPT_PLACEHOLDER = '{prompt}'
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

export type OneShotInput = {
  /** The user's CLI arguments as typed; tokenized shell-style and merged into the generated ones. */
  userArgs?: string
  prompt: string
  /** A model of the spec; defaults to the spec's default model. */
  model?: string
  /** An effort level; defaults to the model's own, and null forces none. */
  thinking?: string | null
  /** False leaves out the generated `--strict-mcp-config`, for the retry of a `claude` run. */
  strictMcp?: boolean
}

/** What to start: the arguments after the agent's command, and the text to write to its stdin (null when none). */
export type OneShotCommand = { argv: string[]; stdin: string | null }

function tokens(text: string | undefined, message: (reason: string) => string): string[] {
  const trimmed = text?.trim()
  if (!trimmed) return []
  const result = tokenize(trimmed)
  if (!result.ok) throw new OneShotError(message(result.error))
  return result.tokens
}

function groupApplies(when: string, model: string | null, thinking: string | null): boolean {
  if (when === 'model') return model !== null && model !== 'default'
  if (when === 'thinking') return thinking !== null
  return thinking === when.slice('thinking='.length)
}

function expand(spec: OneShotSpec, values: { model: string | null; thinking: string | null; prompt: string }): string[] {
  const fill = (token: string) =>
    token.replace(/\{(model|thinking|prompt)\}/g, (_, name: 'model' | 'thinking' | 'prompt') => values[name] ?? '')
  return spec.args.flatMap((item) =>
    typeof item === 'string' ? [fill(item)] : groupApplies(item.when, values.model, values.thinking) ? item.args.map(fill) : []
  )
}

function removeAll(list: string[], aliases: readonly string[]): string[] {
  let result = list
  for (let found = findOptionOccurrence(result, aliases, true); found; found = findOptionOccurrence(result, aliases, true)) {
    result = [...result.slice(0, found.index), ...result.slice(found.index + found.consumed)]
  }
  return result
}

/** Drops every occurrence after the first, so a user who types the same singleton twice still gets one flag. */
function keepFirst(list: string[], aliases: readonly string[]): string[] {
  const first = findOptionOccurrence(list, aliases, true)
  if (!first) return list
  const end = first.index + first.consumed
  return [...list.slice(0, end), ...removeAll(list.slice(end), aliases)]
}

/**
 * Lets a user argument naming one of `groups` replace the generated flag, value and all, where it
 * stood: CLIs that take a flag once treat a repeat as an array and crash. Returns the generated
 * arguments and the user arguments that replaced nothing.
 */
function applySingletons(generated: string[], user: string[], groups: readonly (readonly string[])[]): { generated: string[]; user: string[] } {
  let produced = generated
  let remaining = user
  for (const aliases of groups) {
    remaining = keepFirst(remaining, aliases)
    const own = findOptionOccurrence(remaining, aliases, true)
    const replaced = findOptionOccurrence(produced, aliases, false)
    if (!own || !replaced) continue
    const override = remaining.slice(own.index, own.index + own.consumed)
    produced = [...produced.slice(0, replaced.index), ...override, ...produced.slice(replaced.index + replaced.consumed)]
    remaining = [...remaining.slice(0, own.index), ...remaining.slice(own.index + own.consumed)]
  }
  return { generated: produced, user: remaining }
}

/** Puts `user` before the prompt when the prompt is the final argument, else at the end. */
function insertUserArgs(args: string[], user: string[], spec: OneShotSpec, prompt: string): string[] {
  if (user.length === 0) return args
  if (spec.prompt === 'argv' && prompt.length > 0 && args.at(-1) === prompt) return [...args.slice(0, -1), ...user, prompt]
  return [...args, ...user]
}

/**
 * The argv (after the agent's command) and stdin for one non-interactive run of `entry`: the
 * `oneShot.args` template filled in for the default model and its effort level, the user's
 * arguments merged in, and the prompt delivered the way the spec says. Pure. Throws
 * `OneShotError` for an agent with no one-shot shape, a model the spec doesn't list, user
 * arguments that don't tokenize, or an argv prompt containing NUL.
 */
export function buildOneShotCommand(entry: Pick<AgentEntry, 'label' | 'oneShot'>, input: OneShotInput): OneShotCommand {
  const spec = entry.oneShot
  if (!spec) throw new OneShotError(`${entry.label} can't generate text. Pick another agent.`)
  if (spec.prompt === 'argv' && input.prompt.includes('\0')) throw new OneShotError('the prompt contains a NUL character')

  const modelId = input.model ?? spec.defaultModel
  const model = modelId === null ? undefined : spec.models.find((candidate) => candidate.id === modelId)
  if (input.model !== undefined && !model) throw new OneShotError(`Model "${input.model}" is not available for ${entry.label}.`)
  const thinking = input.thinking === undefined ? (model?.thinking ?? null) : input.thinking

  const prompt = spec.prompt === 'argv' ? input.prompt : ''
  let generated = expand(spec, { model: modelId, thinking, prompt })
  if (spec.background === 'claude' && input.strictMcp === false) generated = generated.filter((token) => token !== STRICT_MCP_FLAG)

  const user = tokens(input.userArgs, (reason) => `CLI arguments are invalid: ${reason}`)
  const merged = applySingletons(generated, user, spec.singletonOptions)
  return {
    argv: insertUserArgs(merged.generated, merged.user, spec, prompt),
    stdin: spec.prompt === 'stdin' ? input.prompt : null
  }
}

/**
 * Whether a run of a `claude` entry that exited with `code` should be started again without
 * `--strict-mcp-config`: only when Claude refused the flag because an enterprise MCP config is
 * present, which it says in its output.
 */
export function shouldRetryWithoutStrictMcp(spec: OneShotSpec, run: { code: number | null; stdout: string; stderr: string }): boolean {
  return spec.background === 'claude' && typeof run.code === 'number' && run.code !== 0 && `${run.stdout}\n${run.stderr}`.includes(ENTERPRISE_REFUSAL)
}

/** Splits leading `NAME=value` words off a command; they are environment, never shell. */
export function extractEnvAssignments(command: readonly string[]): { env: Record<string, string>; rest: string[] } {
  const env: Record<string, string> = {}
  let index = 0
  for (; index < command.length && ENV_ASSIGNMENT.test(command[index]!); index += 1) {
    const word = command[index]!
    const equals = word.indexOf('=')
    delete env[word.slice(0, equals)]
    env[word.slice(0, equals)] = word.slice(equals + 1)
  }
  return { env, rest: command.slice(index) }
}

/** A user-typed command line planned for one run. */
export type CustomCommand = { binary: string; args: string[]; stdin: string | null; env: Record<string, string> }

/**
 * Plans a custom command line: tokenized shell-style (nothing expands), leading `NAME=value`
 * words as environment, and the prompt as one argument wherever a word contains `{prompt}`,
 * else on stdin. Throws `OneShotError` for an empty or unclosed command, or an argv prompt
 * containing NUL.
 */
export function planCustomCommand(template: string, prompt: string): CustomCommand {
  const tokenized = tokenize(template)
  if (!tokenized.ok) throw new OneShotError('Unclosed quote in command template.')
  if (tokenized.tokens.length === 0) throw new OneShotError('Custom command is empty.')
  const { env, rest: command } = extractEnvAssignments(tokenized.tokens)
  const [binary, ...args] = command
  if (!binary) throw new OneShotError('Custom command must start with a binary name.')

  if (!command.some((word) => word.includes(PROMPT_PLACEHOLDER))) return { binary, args, stdin: prompt, env }
  if (prompt.includes('\0')) throw new OneShotError('the prompt contains a NUL character')
  const substitute = (word: string) => word.split(PROMPT_PLACEHOLDER).join(prompt)
  return { binary: substitute(binary), args: args.map(substitute), stdin: null, env }
}
