import { relative, resolve, sep } from 'node:path'
import type { ClassifyContext } from '../contracts'
import { parseShell } from './shell'

/** Whether the fixed rules may allow a shell command on their own. */
export type StrictVerdict = { plain: true } | { plain: false; why: string }

/** The longest command the strict rule reads. */
export const MAX_PLAIN_CHARS = 2000

type Token = {
  raw: string
  value: string
  quoted: boolean
  kind: 'word' | 'connector' | 'redirect'
  connector: '&&' | '|' | null
}

type TokenCommand = {
  words: Token[]
  redirects: number
  separatorBefore: '&&' | '|' | null
}

type TokenizeResult = { tokens: Token[] } | { why: string }
type SplitResult = { commands: TokenCommand[] } | { why: string }
type PathFailure = 'outside a handed-off worktree' | 'inside an agent config path' | null

type OptionSpec = {
  shortFlags: ReadonlySet<string>
  shortValues: ReadonlySet<string>
  longFlags: ReadonlySet<string>
  longValues: ReadonlySet<string>
  count?: boolean
  noOperands?: boolean
}

const AGENT_CONFIG_SEGMENTS = new Set(['.claude', '.codex', '.pi', '.omp', 'hooks.json'])
const ANY_WORD_COMMANDS = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'pwd', 'echo',
  'cargo', 'go', 'pytest', 'python', 'python3', 'vitest', 'jest', 'mocha', 'ava', 'karma',
  'tsc', 'eslint', 'oxlint', 'biome', 'ruff', 'mypy', 'pyright', 'knip'
])
const PACKAGE_MANAGERS = new Set(['bun', 'npm', 'pnpm', 'yarn'])
const SHORT_COUNT = /^-[0-9]+$/
const SED_SCRIPT = /^(?:[0-9]+p|[0-9]+,[0-9]+p)$/

function optionSpec(
  shortFlags = '',
  shortValues = '',
  longFlags: readonly string[] = [],
  longValues: readonly string[] = [],
  count = false,
  noOperands = false
): OptionSpec {
  return {
    shortFlags: new Set(shortFlags),
    shortValues: new Set(shortValues),
    longFlags: new Set(longFlags),
    longValues: new Set(longValues),
    count,
    noOperands
  }
}

const OPTION_FORMS = new Map<string, OptionSpec>([
  ['grep', optionSpec(
    'EFHILRchilnoqrsvwx', 'ABCem',
    ['ignore-case', 'line-number', 'recursive', 'files-with-matches', 'files-without-match', 'count', 'invert-match', 'word-regexp', 'extended-regexp', 'fixed-strings', 'only-matching', 'quiet', 'no-messages', 'with-filename', 'no-filename', 'color'],
    ['include', 'exclude', 'exclude-dir', 'max-count', 'after-context', 'before-context', 'context', 'color', 'regexp']
  )],
  ['rg', optionSpec(
    'FHILNPSUchilnoqsuvwx', 'ABCegmtT',
    ['files', 'hidden', 'ignore-case', 'smart-case', 'case-sensitive', 'line-number', 'no-line-number', 'files-with-matches', 'files-without-match', 'count', 'invert-match', 'word-regexp', 'fixed-strings', 'only-matching', 'quiet', 'no-ignore', 'heading', 'no-heading', 'with-filename', 'no-filename', 'multiline', 'json', 'stats', 'column', 'trim'],
    ['glob', 'iglob', 'type', 'type-not', 'max-count', 'after-context', 'before-context', 'context', 'max-depth', 'color', 'sort', 'regexp']
  )],
  ['mkdir', optionSpec('pv')],
  ['touch', optionSpec()],
  ['rm', optionSpec('fRrdv')],
  ['mv', optionSpec('fnv')],
  ['cp', optionSpec('Rrpafnv')],
  ['tee', optionSpec('a')],
  ['git status', optionSpec('sbu', '', ['short', 'branch', 'porcelain', 'ignored'], ['porcelain', 'untracked-files'])],
  ['git diff', optionSpec('w', 'U', ['stat', 'cached', 'staged', 'name-only', 'name-status', 'shortstat', 'numstat', 'summary', 'check', 'no-color', 'no-ext-diff', 'ignore-all-space'], ['unified', 'diff-filter', 'color'])],
  ['git log', optionSpec('p', 'n', ['oneline', 'stat', 'graph', 'decorate', 'all', 'name-only', 'name-status', 'patch', 'no-merges', 'reverse', 'follow', 'shortstat', 'first-parent', 'no-color'], ['max-count', 'since', 'until', 'author', 'grep', 'format', 'pretty', 'date', 'skip', 'color'], true)],
  ['git show', optionSpec('s', '', ['stat', 'name-only', 'name-status', 'oneline', 'no-patch', 'patch', 'no-color'], ['format', 'pretty', 'color'])],
  ['git branch', optionSpec('arv', '', ['show-current', 'all', 'remotes', 'list', 'verbose'], [], false, true)],
  ['git rev-parse', optionSpec('', '', ['abbrev-ref', 'short', 'show-toplevel', 'git-dir', 'verify', 'is-inside-work-tree', 'show-prefix', 'absolute-git-dir', 'git-common-dir'], ['short'])],
  ['git ls-files', optionSpec('mods', '', ['others', 'modified', 'deleted', 'stage', 'cached', 'exclude-standard'])],
  ['git blame', optionSpec('w', 'L')],
  ['git add', optionSpec('Au', '', ['all', 'update'])],
  ['git commit', optionSpec('a', 'm', ['all'], ['message'], false, true)],
  ['git remote', optionSpec('v', '', [], [], false, true)],
  ['gh pr view', optionSpec('', '', ['comments'], ['json', 'jq'])],
  ['gh pr list', optionSpec('', 'L', [], ['json', 'jq', 'limit', 'state', 'head', 'base', 'author'])],
  ['gh pr checks', optionSpec('', '', [], ['json', 'jq'])],
  ['gh pr diff', optionSpec('', '', ['name-only'])],
  ['gh pr status', optionSpec('', '', [], ['json', 'jq'])],
  ['gh run list', optionSpec('', 'L', [], ['json', 'jq', 'limit', 'branch', 'workflow', 'status'])],
  ['gh run view', optionSpec('', '', ['log', 'log-failed'], ['json', 'jq', 'job'])]
])

function fail(why: string): StrictVerdict {
  return { plain: false, why }
}

function isUnquotedCharacter(code: number): boolean {
  return code >= 65 && code <= 90 || code >= 97 && code <= 122 || code >= 48 && code <= 57 ||
    code === 95 || code === 46 || code === 47 || code === 58 || code === 61 ||
    code === 44 || code === 64 || code === 45
}

function tokenize(source: string): TokenizeResult {
  const tokens: Token[] = []
  let index = 0

  while (index < source.length) {
    if (source[index] === ' ') {
      index++
      continue
    }

    const raw: string[] = []
    const value: string[] = []
    let quote = ''
    let quoted = false
    let firstSpecial: string | null = null

    while (index < source.length && (quote !== '' || source[index] !== ' ')) {
      const character = source[index]
      const code = source.charCodeAt(index)

      if (quote === '') {
        if (character === "'" || character === '"') {
          quote = character
          quoted = true
          raw.push(character)
        } else {
          raw.push(character)
          value.push(character)
          if (!isUnquotedCharacter(code)) {
            if (character === '&' || character === '>' || character === '|') {
              if (firstSpecial === null) firstSpecial = character
            } else {
              return { why: `the character ${JSON.stringify(character)} is not plain text` }
            }
          }
        }
      } else if (character === quote) {
        quote = ''
        raw.push(character)
      } else {
        if (quote === '"' && (character === '$' || character === '`' || character === '\\' || character === '!')) {
          return { why: `a double-quoted word holds ${JSON.stringify(character)}` }
        }
        raw.push(character)
        value.push(character)
      }
      index++
    }

    if (quote !== '') return { why: 'a quote is not closed' }

    const rawText = raw.join('')
    const valueText = value.join('')
    const connector = rawText === '&&' || rawText === '|' ? rawText : null
    const redirect = rawText === '2>&1' || rawText === '2>/dev/null' || rawText === '>/dev/null'

    if (connector !== null) {
      tokens.push({ raw: rawText, value: valueText, quoted, kind: 'connector', connector })
    } else if (redirect) {
      tokens.push({ raw: rawText, value: valueText, quoted, kind: 'redirect', connector: null })
    } else {
      if (firstSpecial !== null) return { why: `the character ${JSON.stringify(firstSpecial)} is not plain text` }
      if (valueText.startsWith('=')) return { why: 'a word starts with =' }
      tokens.push({ raw: rawText, value: valueText, quoted, kind: 'word', connector: null })
    }
  }

  return { tokens }
}

function splitCommands(tokens: Token[]): SplitResult {
  const commands: TokenCommand[] = []
  let current: TokenCommand = { words: [], redirects: 0, separatorBefore: null }
  let afterRedirect = false

  for (const token of tokens) {
    if (token.kind === 'connector') {
      if (current.words.length === 0) return { why: `nothing before ${token.value}` }
      commands.push(current)
      current = { words: [], redirects: 0, separatorBefore: token.connector }
      afterRedirect = false
    } else if (token.kind === 'redirect') {
      current.redirects++
      afterRedirect = true
    } else {
      if (afterRedirect) return { why: 'a word follows a redirect' }
      current.words.push(token)
    }
  }

  if (current.words.length === 0) return { why: 'the command is empty or ends with a connector' }
  commands.push(current)
  return { commands }
}

function resolvedRoots(ctx: ClassifyContext): string[] {
  const roots = [resolve(ctx.worktreePath)]
  for (const path of ctx.handedOffPaths) roots.push(resolve(path))
  return roots
}

function isInside(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)
}

function deepestRoot(path: string, roots: readonly string[]): string | null {
  let deepest: string | null = null
  for (const root of roots) {
    if (isInside(path, root) && (deepest === null || root.length > deepest.length)) deepest = root
  }
  return deepest
}

function pathFailure(path: string, roots: readonly string[]): PathFailure {
  const root = deepestRoot(path, roots)
  if (root === null) return 'outside a handed-off worktree'
  const below = relative(root, path)
  for (const segment of below.split(sep)) {
    if (AGENT_CONFIG_SEGMENTS.has(segment.toLowerCase())) return 'inside an agent config path'
  }
  return null
}

function pathReason(failure: PathFailure, subject: string): string {
  if (failure === 'inside an agent config path') return `${subject} enters an agent config path`
  return `${subject} leaves the handed-off worktrees`
}

function isPathPieceCharacter(code: number): boolean {
  return code >= 65 && code <= 90 || code >= 97 && code <= 122 || code >= 48 && code <= 57 ||
    code === 95 || code === 46 || code === 47 || code === 64 || code === 45
}

function checkWordPaths(words: readonly Token[], cwd: string, roots: readonly string[]): PathFailure {
  for (const word of words) {
    const text = word.value
    let index = 0
    while (index < text.length) {
      if (!isPathPieceCharacter(text.charCodeAt(index))) {
        index++
        continue
      }
      const start = index
      while (index < text.length && isPathPieceCharacter(text.charCodeAt(index))) index++
      let piece = text.slice(start, index)
      if (piece.startsWith('-')) {
        const slash = piece.indexOf('/')
        if (slash < 0) continue
        piece = piece.slice(slash)
      }
      const failure = pathFailure(resolve(cwd, piece), roots)
      if (failure !== null) return failure
    }
  }
  return null
}

function optionWordsFit(words: readonly Token[], start: number, spec: OptionSpec): boolean {
  let hasOperand = false
  let optionsEnded = false

  for (let index = start; index < words.length; index++) {
    const value = words[index].value
    if (optionsEnded) {
      hasOperand = true
      continue
    }
    if (value === '--') {
      optionsEnded = true
      continue
    }
    if (value === '-' || !value.startsWith('-')) {
      hasOperand = true
      continue
    }

    if (value.startsWith('--')) {
      const equals = value.indexOf('=')
      if (equals >= 0) {
        if (!spec.longValues.has(value.slice(2, equals))) return false
        continue
      }
      const name = value.slice(2)
      if (spec.longFlags.has(name)) continue
      if (spec.longValues.has(name)) {
        if (index + 1 >= words.length) return false
        index++
        continue
      }
      return false
    }

    if (spec.count && SHORT_COUNT.test(value)) continue

    for (let offset = 1; offset < value.length; offset++) {
      const letter = value[offset]
      if (spec.shortFlags.has(letter)) continue
      if (spec.shortValues.has(letter)) {
        if (offset + 1 === value.length) {
          if (index + 1 >= words.length) return false
          index++
        }
        break
      }
      return false
    }
  }

  return !spec.noOperands || !hasOperand
}

const FIND_FLAGS = new Set(['-print', '-print0', '-empty', '-not', '-o', '-a', '-prune', '-depth'])
const FIND_VALUE_FLAGS = new Set([
  '-name', '-iname', '-path', '-ipath', '-type', '-maxdepth', '-mindepth', '-newer', '-mtime', '-mmin', '-size', '-regex', '-iregex'
])

function findWordsFit(words: readonly Token[]): boolean {
  for (let index = 1; index < words.length; index++) {
    const value = words[index].value
    if (!value.startsWith('-')) continue
    if (FIND_FLAGS.has(value)) continue
    if (!FIND_VALUE_FLAGS.has(value) || index + 1 >= words.length) return false
    index++
  }
  return true
}

function gitWordsFit(words: readonly Token[]): boolean {
  if (words.length < 2 || words[1].quoted) return false
  const spec = OPTION_FORMS.get(`git ${words[1].value}`)
  return spec !== undefined && optionWordsFit(words, 2, spec)
}

function ghWordsFit(words: readonly Token[]): boolean {
  if (words.length < 3 || words[1].quoted || words[2].quoted) return false
  const spec = OPTION_FORMS.get(`gh ${words[1].value} ${words[2].value}`)
  return spec !== undefined && optionWordsFit(words, 3, spec)
}

function tableCommandFits(words: readonly Token[]): boolean {
  const name = words[0].value
  if (ANY_WORD_COMMANDS.has(name)) return true

  const spec = OPTION_FORMS.get(name)
  if (spec !== undefined) return optionWordsFit(words, 1, spec)
  if (name === 'find') return findWordsFit(words)
  if (name === 'sed') {
    return words.length >= 3 && words[1].value === '-n' && SED_SCRIPT.test(words[2].value) &&
      words.slice(3).every((word) => !word.value.startsWith('-'))
  }
  if (name === 'git') return gitWordsFit(words)
  if (name === 'gh') return ghWordsFit(words)
  if (PACKAGE_MANAGERS.has(name)) return words.length >= 2 && (words[1].value === 'test' || words[1].value === 'run')
  if (name === 'bunx' || name === 'npx') return words.length >= 2 && !words[1].value.startsWith('-')
  if (name === 'make') return words.slice(1).every((word) => !word.value.startsWith('-'))
  if (name === 'playwright') return words.length >= 2 && words[1].value === 'test'
  return false
}

function ownerAllows(words: readonly Token[], allowed: (words: string[]) => boolean): boolean {
  if (words[0].value.includes('=')) return false
  try {
    return allowed(words.map((word) => word.value))
  } catch {
    return false
  }
}

function readersAgree(command: string, commands: readonly TokenCommand[], ctx: ClassifyContext, read: typeof parseShell): boolean {
  let script
  try {
    script = read(command, { home: ctx.home })
  } catch {
    return false
  }
  if (script === null || !Array.isArray(script.commands) || script.commands.length !== commands.length) return false

  for (let index = 0; index < commands.length; index++) {
    const expected = commands[index]
    const actual = script.commands[index]
    if (actual.scope !== 0 || actual.sep !== expected.separatorBefore ||
      !Array.isArray(actual.assignments) || actual.assignments.length !== 0 ||
      !Array.isArray(actual.words) || actual.words.length !== expected.words.length ||
      !Array.isArray(actual.redirects) || actual.redirects.length !== expected.redirects) return false

    for (let wordIndex = 0; wordIndex < expected.words.length; wordIndex++) {
      const actualWord = actual.words[wordIndex]
      if (actualWord.dynamic || !Array.isArray(actualWord.subs) || actualWord.subs.length !== 0 ||
        actualWord.text !== expected.words[wordIndex].value) return false
    }
  }
  return true
}

export function plainCommand(
  command: string,
  cwd: string,
  ctx: ClassifyContext,
  allowed: (words: string[]) => boolean,
  read: typeof parseShell = parseShell
): StrictVerdict {
  try {
    if (command.length > MAX_PLAIN_CHARS) return fail('the command is longer than the plain-command limit')
    for (let index = 0; index < command.length; index++) {
      const code = command.charCodeAt(index)
      if (code < 32 || code > 126) return fail('the command holds a character outside printable ASCII')
    }

    const tokenized = tokenize(command)
    if ('why' in tokenized) return fail(tokenized.why)
    const split = splitCommands(tokenized.tokens)
    if ('why' in split) return fail(split.why)

    const roots = resolvedRoots(ctx)
    const start = resolve(cwd)
    const startFailure = pathFailure(start, roots)
    if (startFailure !== null) return fail(pathReason(startFailure, 'the starting directory'))

    let currentDirectory = start
    for (let index = 0; index < split.commands.length; index++) {
      const parsed = split.commands[index]
      const first = parsed.words[0]
      const nextSeparator = split.commands[index + 1]?.separatorBefore ?? null
      const isCd = first.value === 'cd' && !first.quoted

      if (isCd) {
        if (parsed.separatorBefore === '|' || nextSeparator === '|' || parsed.words.length !== 2 || parsed.redirects !== 0 || parsed.words[1].value.startsWith('-')) {
          return fail('cd takes one directory and nothing else')
        }
        const destination = resolve(currentDirectory, parsed.words[1].value)
        const failure = pathFailure(destination, roots)
        if (failure !== null) return fail(pathReason(failure, 'cd'))
        currentDirectory = destination
        continue
      }

      if (first.quoted) return fail('the command word is quoted')
      const ownerAllowed = ownerAllows(parsed.words, allowed)
      if (!ownerAllowed && !tableCommandFits(parsed.words)) return fail(`${first.value} is not on the list`)
      if (!ownerAllowed) {
        const pathFailureReason = checkWordPaths(parsed.words.slice(1), currentDirectory, roots)
        if (pathFailureReason !== null) return fail(pathReason(pathFailureReason, first.value))
        if (first.value === 'rm' || first.value === 'mv') {
          for (const word of parsed.words.slice(1)) {
            if (!word.value.startsWith('-') && roots.includes(resolve(currentDirectory, word.value))) {
              return fail(`${first.value} may not remove or move a handed-off worktree root`)
            }
          }
        }
      }
    }

    if (!readersAgree(command, split.commands, ctx, read)) return fail('the two readers disagree about the command')
    return { plain: true }
  } catch {
    return fail('the command could not be read')
  }
}
