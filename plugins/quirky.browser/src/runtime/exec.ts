import { fault } from './errors'
import type { BrowserMethod } from './catalog'

export type ExecCommand = { path: string[]; positionals: string[]; flags: Record<string, string | boolean> }
export type ExecPlan = { command: ExecCommand; method: BrowserMethod; params: Record<string, unknown> }
type Token = { value: string; quoted: boolean; optionEligible: boolean }

function tokenize(command: string): Token[] {
  const tokens: Token[] = []
  let value = ''
  let quote: "'" | '"' | undefined
  let escaped = false
  let started = false
  let quoted = false
  let optionEligible = true
  for (const char of command) {
    if (escaped) {
      value += char
      escaped = false
      started = true
      continue
    }
    if (char === '\\' && quote !== "'") {
      if (!started) optionEligible = false
      escaped = true
      started = true
      continue
    }
    if (quote) {
      if (char === quote) quote = undefined
      else value += char
      started = true
      continue
    }
    if (char === "'" || char === '"') {
      if (!started) optionEligible = false
      quote = char
      quoted = true
      started = true
      continue
    }
    if ('\n\r\0;|&<>$`*?[]{}()~'.includes(char)) throw fault('invalid_argument', 'exec accepts one shell-free command; metacharacters must be quoted data')
    if (/\s/.test(char)) {
      if (started) {
        tokens.push({ value, quoted, optionEligible })
        value = ''
        started = false
        quoted = false
        optionEligible = true
      }
      continue
    }
    if (!started) optionEligible = true
    value += char
    started = true
  }
  if (escaped || quote) throw fault('invalid_argument', 'exec command has malformed quoting or escaping')
  if (started) tokens.push({ value, quoted, optionEligible })
  if (tokens.length === 0) throw fault('invalid_argument', 'exec command must not be empty')
  return tokens
}

function parseOptions(tokens: Token[]): { positionals: string[]; flags: Record<string, string> } {
  const positionals: string[] = []
  const flags: Record<string, string> = {}
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!
    if (!token.optionEligible || !token.value.startsWith('--')) {
      positionals.push(token.value)
      continue
    }
    const equal = token.value.indexOf('=')
    const name = token.value.slice(2, equal === -1 ? undefined : equal)
    if (name === '' || Object.hasOwn(flags, name)) throw fault('invalid_argument', `exec has an empty or duplicate option --${name}`)
    if (equal !== -1) {
      flags[name] = token.value.slice(equal + 1)
      continue
    }
    const next = tokens[index + 1]
    if (!next) throw fault('invalid_argument', `exec option --${name} requires a value`)
    flags[name] = next.value
    index += 1
  }
  return { positionals, flags }
}

function requireNoFlags(flags: Record<string, string>): void {
  const names = Object.keys(flags)
  if (names.length > 0) throw fault('invalid_argument', `exec option --${names[0]} is not supported by this command`)
}

function requirePositionals(positionals: string[], count: number): void {
  if (positionals.length !== count) throw fault('invalid_argument', 'exec command has an invalid number of arguments')
}

export function parseExec(commandText: string): ExecPlan {
  const tokens = tokenize(commandText)
  const path = [tokens[0]!.value]
  const { positionals, flags } = parseOptions(tokens.slice(1))
  const command: ExecCommand = { path, positionals, flags }
  const params: Record<string, unknown> = {}
  const pathText = path[0]!
  let method: BrowserMethod

  switch (pathText) {
    case 'goto': case 'open': case 'navigate':
      requireNoFlags(flags)
      requirePositionals(positionals, 1)
      method = 'goto'
      params.url = positionals[0]
      break
    case 'eval':
      requireNoFlags(flags)
      requirePositionals(positionals, 1)
      method = 'eval'
      params.expression = positionals[0]
      break
    case 'snapshot':
      requireNoFlags(flags)
      requirePositionals(positionals, 0)
      method = 'snapshot'
      break
    case 'fill':
      requireNoFlags(flags)
      requirePositionals(positionals, 2)
      method = 'fill'
      params.element = positionals[0]
      params.value = positionals[1]
      break
    case 'click':
      requireNoFlags(flags)
      requirePositionals(positionals, 1)
      method = 'click'
      params.element = positionals[0]
      break
    case 'screenshot': {
      requirePositionals(positionals, 0)
      for (const name of Object.keys(flags)) if (name !== 'format') throw fault('invalid_argument', `exec option --${name} is not supported by screenshot`)
      const format = flags.format
      if (format !== undefined && format !== 'png' && format !== 'jpeg') throw fault('invalid_argument', 'exec screenshot format must be png or jpeg')
      method = 'screenshot'
      if (format !== undefined) params.format = format
      break
    }
    default:
      throw fault('invalid_argument', `exec command ${pathText} is not supported`)
  }
  return { command, method, params }
}
