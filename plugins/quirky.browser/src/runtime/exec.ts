import { validateValue, type Schema } from '@quirky/protocol'
import { fault } from './errors'
import type { BrowserMethod } from './catalog'

export type ExecCommand = { path: string[]; positionals: string[]; flags: Record<string, string | boolean> }
export type ExecPlan = { command: ExecCommand; method: BrowserMethod; params: Record<string, unknown> }
type Token = { value: string; quoted: boolean; optionEligible: boolean }

const UNSAFE_OPTIONS: Readonly<Record<string, true>> = {
  page: true, worktree: true, cwd: true, index: true, profile: true, 'browser-profile': true,
  cdp: true, 'cdp-url': true, session: true, 'session-id': true, executable: true,
  'executable-path': true, 'browser-path': true, 'chrome-path': true, chrome: true,
  args: true, target: true, 'target-id': true, tab: true, 'tab-id': true, port: true,
  host: true, endpoint: true, 'ws-endpoint': true, socket: true, 'socket-dir': true,
  headed: true, headless: true, launch: true, 'auto-connect': true, browser: true,
  'launch-args': true, 'user-data-dir': true, 'remote-debugging-port': true, 'remote-debugging-address': true
}
const BOOLEAN_OPTIONS: Readonly<Record<string, true>> = { secure: true, 'http-only': true, mobile: true }
const SHELL_META = '\n\r\0;|&<>$`*?[]{}()~'

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
    if (SHELL_META.includes(char)) throw fault('invalid_argument', 'exec accepts one shell-free command; metacharacters must be quoted data')
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

function pathLength(words: readonly Token[]): number {
  const first = words[0]?.value
  if (first === 'keyboard' || first === 'mouse' || first === 'cookies' || first === 'clipboard' || first === 'dialog') return 2
  if (first === 'storage') return Math.min(3, words.length)
  if (first === 'set') return 2
  if (first === 'network') return words[1]?.value === 'har' ? 3 : 2
  return 1
}

function parseOptions(tokens: Token[]): { positionals: string[]; flags: Record<string, string | boolean> } {
  const positionals: string[] = []
  const flags: Record<string, string | boolean> = {}
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!
    if (!token.optionEligible || !token.value.startsWith('--')) {
      positionals.push(token.value)
      continue
    }
    const equal = token.value.indexOf('=')
    const name = token.value.slice(2, equal === -1 ? undefined : equal)
    if (name === '' || Object.hasOwn(flags, name)) throw fault('invalid_argument', `exec has an empty or duplicate option --${name}`)
    if (Object.hasOwn(UNSAFE_OPTIONS, name)) throw fault('invalid_argument', `exec cannot override browser target option --${name}`)
    if (equal !== -1) {
      const value = token.value.slice(equal + 1)
      if (Object.hasOwn(BOOLEAN_OPTIONS, name)) {
        if (value !== 'true' && value !== 'false') throw fault('invalid_argument', `exec boolean option --${name} must be true or false`)
        flags[name] = value === 'true'
      } else flags[name] = value
      continue
    }
    const next = tokens[index + 1]
    if (Object.hasOwn(BOOLEAN_OPTIONS, name)) {
      flags[name] = true
      if (next && !next.quoted && (next.value === 'true' || next.value === 'false')) {
        flags[name] = next.value === 'true'
        index += 1
      }
      continue
    }
    if (!next) throw fault('invalid_argument', `exec option --${name} requires a value`)
    flags[name] = next.value
    index += 1
  }
  return { positionals, flags }
}

function positionalCount(positionals: string[], minimum: number, maximum = minimum): void {
  if (positionals.length < minimum || positionals.length > maximum) throw fault('invalid_argument', 'exec command has an invalid number of arguments')
}

function numberText(value: string, name: string): number {
  if (value.trim() === '' || !Number.isFinite(Number(value))) throw fault('invalid_argument', `exec ${name} must be a finite number`)
  return Number(value)
}

function parsePartition(text: string): { topLevelSite: string; hasCrossSiteAncestor: boolean } {
  let parsed: unknown
  try { parsed = JSON.parse(text) as unknown } catch { throw fault('invalid_argument', 'exec partition key must be valid JSON') }
  const schema: Schema = {
    type: 'object', properties: { topLevelSite: { type: 'string' }, hasCrossSiteAncestor: { type: 'boolean' } },
    required: ['topLevelSite', 'hasCrossSiteAncestor'], additionalProperties: false
  }
  if (validateValue(schema, parsed, 'partition key')) throw fault('invalid_argument', 'exec partition key has an invalid shape')
  return parsed as { topLevelSite: string; hasCrossSiteAncestor: boolean }
}

function parseFlags(
  flags: Record<string, string | boolean>,
  params: Record<string, unknown>,
  allowed: Record<string, string>,
  pathText: string
): void {
  for (const [flag, param] of Object.entries(allowed)) {
    if (!Object.hasOwn(flags, flag)) continue
    if (Object.hasOwn(params, param)) throw fault('invalid_argument', `exec supplies ${param} more than once`)
    params[param] = flags[flag]
  }
  for (const flag of Object.keys(flags)) if (!Object.hasOwn(allowed, flag)) throw fault('invalid_argument', `exec option --${flag} is not supported by ${pathText}`)
}

function requireNoFlags(flags: Record<string, string | boolean>): void {
  const first = Object.keys(flags)[0]
  if (first !== undefined) throw fault('invalid_argument', `exec option --${first} is not supported by this command`)
}

function translate(path: string[], positionals: string[], flags: Record<string, string | boolean>): { method: BrowserMethod; params: Record<string, unknown> } {
  const pathText = path.join(' ')
  const params: Record<string, unknown> = {}
  const one = (method: BrowserMethod, field: string) => {
    requireNoFlags(flags)
    positionalCount(positionals, 1)
    params[field] = positionals[0]
    return { method, params }
  }
  const two = (method: BrowserMethod, first: string, second: string) => {
    requireNoFlags(flags)
    positionalCount(positionals, 2)
    params[first] = positionals[0]
    params[second] = positionals[1]
    return { method, params }
  }

  switch (pathText) {
    case 'snapshot': case 'pdf': case 'back': case 'forward': case 'reload':
    case 'clipboard read': case 'dialog dismiss':
      requireNoFlags(flags)
      positionalCount(positionals, 0)
      return { method: pathText === 'clipboard read' ? 'clipboardRead' : pathText === 'dialog dismiss' ? 'dialogDismiss' : pathText as BrowserMethod, params }
    case 'screenshot': case 'full-screenshot':
      positionalCount(positionals, 0)
      parseFlags(flags, params, { format: 'format' }, pathText)
      return { method: pathText === 'screenshot' ? 'screenshot' : 'fullScreenshot', params }
    case 'open': case 'navigate': case 'goto': return one('goto', 'url')
    case 'click': return one('click', 'element')
    case 'dblclick': return one('dblclick', 'element')
    case 'fill': return two('fill', 'element', 'value')
    case 'eval': return one('eval', 'expression')
    case 'press': return one('keypress', 'key')
    case 'keyboard type': return one('type', 'input')
    case 'keyboard inserttext': return one('keyboardInsertText', 'text')
    case 'select': return two('select', 'element', 'value')
    case 'check': return one('check', 'element')
    case 'uncheck': return one('uncheck', 'element')
    case 'focus': return one('focus', 'element')
    case 'hover': return one('hover', 'element')
    case 'scrollintoview': return one('scrollIntoView', 'element')
    case 'clear': return one('clear', 'element')
    case 'scroll':
      positionalCount(positionals, 1, 2)
      requireNoFlags(flags)
      params.direction = positionals[0]
      if (positionals[1] !== undefined) params.amount = numberText(positionals[1], 'scroll amount')
      return { method: 'scroll', params }
    case 'wait':
      positionalCount(positionals, 0)
      parseFlags(flags, params, { selector: 'selector', timeout: 'timeout', text: 'text', url: 'url', load: 'load', fn: 'fn', state: 'state' }, pathText)
      if (typeof params.timeout === 'string') params.timeout = numberText(params.timeout, 'wait timeout')
      return { method: 'wait', params }
    case 'get':
      positionalCount(positionals, 1, 2)
      params.what = positionals[0]
      if (positionals[1] !== undefined) params.element = positionals[1]
      parseFlags(flags, params, { element: 'element' }, pathText)
      return { method: 'get', params }
    case 'is':
      positionalCount(positionals, 2)
      params.what = positionals[0]
      params.element = positionals[1]
      requireNoFlags(flags)
      return { method: 'is', params }
    case 'find': {
      const locator = positionals[0]
      if (locator === 'nth') {
        positionalCount(positionals, 4, 5)
        const index = numberText(positionals[1]!, 'find index')
        if (!Number.isInteger(index) || index < -2_147_483_648 || index > 2_147_483_647) throw fault('invalid_argument', 'exec nth index must be a signed 32-bit integer')
        params.locator = locator
        params.index = index
        params.value = positionals[2]
        params.action = positionals[3]
        if (positionals[4] !== undefined) params.text = positionals[4]
      } else {
        positionalCount(positionals, 3, 4)
        params.locator = locator
        params.value = positionals[1]
        params.action = positionals[2]
        if (positionals[3] !== undefined) params.text = positionals[3]
      }
      requireNoFlags(flags)
      return { method: 'find', params }
    }
    case 'drag':
      positionalCount(positionals, 2)
      requireNoFlags(flags)
      params.from = positionals[0]
      params.to = positionals[1]
      return { method: 'drag', params }
    case 'upload':
      positionalCount(positionals, 2, Number.MAX_SAFE_INTEGER)
      requireNoFlags(flags)
      params.element = positionals[0]
      params.files = positionals.slice(1)
      return { method: 'upload', params }
    case 'mouse move':
      positionalCount(positionals, 2)
      requireNoFlags(flags)
      params.x = numberText(positionals[0]!, 'x coordinate')
      params.y = numberText(positionals[1]!, 'y coordinate')
      return { method: 'mouseMove', params }
    case 'mouse wheel':
      positionalCount(positionals, 1, 2)
      requireNoFlags(flags)
      params.dy = numberText(positionals[0]!, 'wheel y delta')
      if (positionals[1] !== undefined) params.dx = numberText(positionals[1], 'wheel x delta')
      return { method: 'mouseWheel', params }
    case 'mouse down': case 'mouse up':
      positionalCount(positionals, 0, 1)
      requireNoFlags(flags)
      if (positionals[0] !== undefined) params.button = positionals[0]
      return { method: pathText === 'mouse down' ? 'mouseDown' : 'mouseUp', params }
    case 'highlight': return one('highlight', 'selector')
    case 'download': return two('download', 'selector', 'path')
    case 'console': case 'network requests':
      positionalCount(positionals, 0)
      parseFlags(flags, params, { limit: 'limit' }, pathText)
      if (typeof params.limit === 'string') params.limit = numberText(params.limit, 'log limit')
      return { method: pathText === 'console' ? 'console' : 'network', params }
    case 'network route':
      positionalCount(positionals, 1, Number.MAX_SAFE_INTEGER)
      requireNoFlags(flags)
      params.patterns = positionals.flatMap((value) => value.split(',').map((pattern) => pattern.trim())).filter(Boolean)
      if (!Array.isArray(params.patterns) || params.patterns.length === 0) throw fault('invalid_argument', 'network route requires at least one pattern')
      return { method: 'interceptEnable', params }
    case 'network unroute':
      positionalCount(positionals, 0)
      requireNoFlags(flags)
      return { method: 'interceptDisable', params }
    case 'network intercepts':
      positionalCount(positionals, 0)
      requireNoFlags(flags)
      return { method: 'interceptList', params }
    case 'network har start': case 'network har stop':
      positionalCount(positionals, 0)
      requireNoFlags(flags)
      return { method: pathText.endsWith('start') ? 'captureStart' : 'captureStop', params }
    case 'cookies get':
      positionalCount(positionals, 0)
      parseFlags(flags, params, { url: 'url' }, pathText)
      return { method: 'cookieGet', params }
    case 'cookies set':
      positionalCount(positionals, 2)
      params.name = positionals[0]
      params.value = positionals[1]
      parseFlags(flags, params, {
        url: 'url', domain: 'domain', path: 'path', secure: 'secure', 'http-only': 'httpOnly',
        'same-site': 'sameSite', expires: 'expires', 'partition-key': 'partitionKey'
      }, pathText)
      if (typeof params.expires === 'string') params.expires = numberText(params.expires, 'cookie expiry')
      if (typeof params.partitionKey === 'string') params.partitionKey = parsePartition(params.partitionKey)
      return { method: 'cookieSet', params }
    case 'storage local get': return one('storageLocalGet', 'key')
    case 'storage local set': return two('storageLocalSet', 'key', 'value')
    case 'storage session get': return one('storageSessionGet', 'key')
    case 'storage session set': return two('storageSessionSet', 'key', 'value')
    case 'set viewport':
      positionalCount(positionals, 2, 3)
      params.width = numberText(positionals[0]!, 'viewport width')
      params.height = numberText(positionals[1]!, 'viewport height')
      if (positionals[2] !== undefined) params.deviceScaleFactor = numberText(positionals[2], 'device scale factor')
      parseFlags(flags, params, { mobile: 'mobile' }, pathText)
      return { method: 'viewport', params }
    case 'set device':
      positionalCount(positionals, 1)
      requireNoFlags(flags)
      params.name = positionals[0]
      return { method: 'setDevice', params }
    case 'set geo':
      positionalCount(positionals, 2)
      params.latitude = numberText(positionals[0]!, 'latitude')
      params.longitude = numberText(positionals[1]!, 'longitude')
      parseFlags(flags, params, { accuracy: 'accuracy' }, pathText)
      if (typeof params.accuracy === 'string') params.accuracy = numberText(params.accuracy, 'geolocation accuracy')
      return { method: 'geolocation', params }
    case 'set offline':
      positionalCount(positionals, 0, 1)
      requireNoFlags(flags)
      if (positionals[0] !== undefined) params.state = positionals[0]
      return { method: 'setOffline', params }
    case 'set headers': return one('setHeaders', 'headers')
    case 'set credentials': return two('setCredentials', 'user', 'pass')
    case 'set media':
      positionalCount(positionals, 1, 2)
      requireNoFlags(flags)
      for (const value of positionals) {
        if (value === 'dark' || value === 'light') params.colorScheme = value
        else if (value === 'reduce' || value === 'no-preference' || value === 'reduced-motion') params.reducedMotion = value === 'reduced-motion' ? 'reduce' : value
        else throw fault('invalid_argument', `unsupported media value ${value}`)
      }
      return { method: 'setMedia', params }
    case 'clipboard write': return one('clipboardWrite', 'text')
    case 'dialog accept':
      positionalCount(positionals, 0, 1)
      requireNoFlags(flags)
      if (positionals[0] !== undefined) params.text = positionals[0]
      return { method: 'dialogAccept', params }
    default: throw fault('invalid_argument', `exec command ${pathText} is not supported`)
  }
}

export function parseExec(commandText: string): ExecPlan {
  const tokens = tokenize(commandText)
  const length = pathLength(tokens)
  if (tokens.length < length) throw fault('invalid_argument', 'exec command is incomplete')
  const path = tokens.slice(0, length).map((token) => token.value)
  const root = path[0]!
  if (['close', 'tab', 'browser', 'profile', 'connect', 'stream', 'batch', 'chat', 'install', 'session', 'launch', 'attach', 'detach', 'disconnect', 'pages', 'context', 'contexts', 'new', 'quit', 'exit', 'import', 'identity', 'open-url'].includes(root)) {
    throw fault('invalid_argument', 'exec cannot invoke browser or process lifecycle commands')
  }
  const parsed = parseOptions(tokens.slice(length))
  for (const flag of Object.keys(parsed.flags)) if (Object.hasOwn(UNSAFE_OPTIONS, flag)) throw fault('invalid_argument', `exec cannot override browser target option --${flag}`)
  const { method, params } = translate(path, parsed.positionals, parsed.flags)
  const command: ExecCommand = { path, positionals: parsed.positionals, flags: parsed.flags }
  return { command, method, params }
}
