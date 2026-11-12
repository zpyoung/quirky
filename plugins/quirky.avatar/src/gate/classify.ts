import { basename, isAbsolute, resolve, sep } from 'node:path'
import type { ActionClass, ClassifyContext, ToolCall } from '../contracts'
import { parseShell, MAX_BRACE_WORDS, MAX_SHELL_DEPTH, type ShellCommand, type ShellWord } from './shell'

type ShellAssignment = ShellCommand['assignments'][number]
type WordAssignment = ShellAssignment & { word: ShellWord }
type Parsed = {
  commandIndex: number
  cmd: string
  args: string[]
  argWords: ShellWord[]
  text: string
  assignments: readonly ShellAssignment[]
  wrapperAssignments: WordAssignment[]
  credential: boolean
  throughXargs: boolean
  wrapped: boolean
  dynamicCommand: boolean
  dynamicBeforeCommand: boolean
  unknownWrapperFlag: boolean
  subscriptBeforeCommand: boolean
  loneSubscriptAssignment: boolean
  argumentExempt: boolean
  execCwd: DirectorySet
  wrapperReads: WrapperTarget[]
  wrapperWrites: WrapperTarget[]
}

const READ_TOOLS = new Set(['read', 'notebookread', 'view', 'glob', 'grep', 'ls', 'find', 'todowrite', 'taskcreate', 'taskget', 'taskupdate', 'tasklist', 'taskoutput', 'enterplanmode', 'exitplanmode'])
const WRITE_TOOLS = new Set(['edit', 'write', 'multiedit', 'notebookedit', 'str_replace_editor', 'create'])
const NETWORK_TOOLS = new Set(['webfetch', 'websearch'])
const SHELL_TOOLS = new Set(['bash', 'shell', 'local_shell', 'exec_command', 'container.exec', 'run_shell_command'])
const PATH_KEYS = ['file_path', 'path', 'notebook_path', 'filePath', 'file']

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish'])
const NO_ARGUMENT_EFFECT_CMDS: Record<string, true> = { echo: true, printf: true, true: true, false: true, test: true, '[': true, basename: true, dirname: true, sleep: true }
type WrapperSpec = {
  shortFlags?: string
  shortValues?: string
  longFlags?: readonly string[]
  longOptionalValues?: readonly string[]
  longAttachedValues?: readonly string[]
  longValues?: readonly string[]
  numericIncrement?: boolean
  durationOperand?: boolean
  chdir?: string
}
const WRAPPER_SPECS: Partial<Record<string, WrapperSpec>> = {
  env: { shortFlags: 'i0v', shortValues: 'uPC', longFlags: ['ignore-environment', 'null', 'debug', 'list-signal-handling'], longOptionalValues: ['block-signal', 'default-signal', 'ignore-signal'], longAttachedValues: ['unset'], longValues: ['chdir'], chdir: 'C' },
  exec: { shortFlags: 'cl', shortValues: 'a' },
  command: { shortFlags: 'pvV' },
  builtin: {},
  nohup: {},
  time: { shortFlags: 'ahlpqv', shortValues: 'fo', longFlags: ['append', 'portability', 'quiet', 'verbose'], longValues: ['format', 'output'] },
  xargs: { shortFlags: '0oprtx', shortValues: 'EIJLnPRSsad', longFlags: ['null', 'open-tty', 'interactive', 'no-run-if-empty', 'verbose', 'exit'], longOptionalValues: ['eof', 'replace', 'max-lines'], longValues: ['arg-file', 'delimiter', 'max-args', 'max-procs', 'max-chars', 'process-slot-var'] },
  nice: { shortValues: 'n', longValues: ['adjustment'], numericIncrement: true },
  ionice: { shortFlags: 't', shortValues: 'cn', longFlags: ['ignore'], longValues: ['class', 'classdata'] },
  stdbuf: { shortValues: 'ioe', longValues: ['input', 'output', 'error'] },
  timeout: { shortFlags: 'v', shortValues: 'ks', longFlags: ['preserve-status', 'foreground', 'verbose'], longValues: ['kill-after', 'signal'], durationOperand: true },
  sudo: { shortFlags: 'ABbEeHiKklNnPSsVv', shortValues: 'CDghpRrTtUu', longFlags: ['askpass', 'bell', 'background', 'edit', 'set-home', 'login', 'remove-timestamp', 'reset-timestamp', 'list', 'no-update', 'non-interactive', 'preserve-groups', 'stdin', 'shell', 'version', 'validate'], longOptionalValues: ['preserve-env'], longValues: ['close-from', 'chdir', 'group', 'host', 'prompt', 'chroot', 'role', 'command-timeout', 'type', 'other-user', 'user'], chdir: 'D' },
  doas: { shortFlags: 'Lns', shortValues: 'aCu' }
}
const READ_CMDS = new Set(['command', 'ls', 'cat', 'head', 'tail', 'wc', 'pwd', 'echo', 'printf', 'which', 'whereis', 'type', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'sort', 'uniq', 'cut', 'tr', 'diff', 'cmp', 'stat', 'file', 'tree', 'jq', 'yq', 'basename', 'dirname', 'realpath', 'readlink', 'true', 'false', 'test', '[', 'date', 'whoami', 'uname', 'id', 'column', 'fmt', 'nl', 'tac', 'od', 'xxd', 'hexdump', 'md5sum', 'shasum', 'sha256sum', 'du', 'df', 'cd', 'pushd', 'popd', 'sleep', 'ps', 'lsof'])
const AWK_CMDS = new Set(['awk', 'gawk', 'mawk', 'nawk'])
const FIND_UNSAFE_PRIMARY = /^-(delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)$/
const WRITE_ALL_CMDS = new Set(['rm', 'rmdir', 'touch', 'tee', 'mkdir', 'truncate', 'unlink', 'mv', 'shred'])
const WRITE_SKIP_FIRST_CMDS = new Set(['chmod', 'chown', 'chgrp'])
const WRITE_DEST_CMDS = new Set(['cp', 'rsync', 'install', 'ln'])
const MESSAGE_CMDS = new Set(['slack', 'slack-cli', 'mail', 'mailx', 'sendmail', 'mutt', 'msmtp', 'himalaya', 'neomutt'])
const DOWNLOAD_CMDS = new Set(['curl', 'wget'])
const PACKAGE_MANAGERS = new Set(['bun', 'npm', 'pnpm', 'yarn'])
const PACKAGE_VALUE_FLAGS = new Set(['--filter', '-F', '--cwd', '-C', '--prefix', '--workspace', '-w'])
const TEST_RUNNERS = new Set(['vitest', 'jest', 'pytest', 'mocha', 'ava', 'playwright', 'karma'])
const BUILD_TOOLS = new Set(['tsc', 'eslint', 'oxlint', 'biome', 'ruff', 'mypy', 'pyright', 'knip', 'tsx-check'])
const UPDATE_FLAGS = new Set(['-u', '--update-snapshots', '--update-snapshot', '--updateSnapshot', '--snapshot-update'])
const GIT_READ_SUBCOMMANDS = new Set(['status', 'diff', 'log', 'show', 'blame', 'ls-files', 'ls-tree', 'rev-parse', 'rev-list', 'describe', 'remote', 'grep', 'shortlog', 'reflog', 'cat-file', 'name-rev', 'merge-base', 'diff-tree', 'for-each-ref', 'fetch', 'version', 'help', 'count-objects', 'check-ignore', 'ls-remote'])
const GIT_LOCAL_SUBCOMMANDS = new Set(['add', 'commit', 'checkout', 'switch', 'restore', 'reset', 'stash', 'merge', 'rebase', 'cherry-pick', 'pull', 'revert', 'apply', 'am', 'mv', 'rm', 'tag', 'branch', 'clean', 'config', 'init', 'submodule', 'worktree', 'notes', 'bisect'])
const GIT_WORKTREE_VALUE_FLAGS = new Set(['-b', '-B', '--reason', '--expire'])
const GIT_PUSH_VALUE_FLAGS = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec'])
const GH_READ_SUBCOMMANDS = new Set(['view', 'list', 'diff', 'checks', 'status', 'ls'])
const GH_MESSAGE_SUBCOMMANDS = new Set(['comment', 'review', 'reply'])
const GH_WRITE_FLAG = /^(-X|--method|-f|-F|--field|--raw-field|--input)$/
const CREDENTIAL_HOME_DIRS = ['.ssh', '.aws', '.config/gh', '.gnupg', 'Library/Keychains']
const CREDENTIAL_HOME_FILES = ['.netrc']

const unique = (classes: ActionClass[]): ActionClass[] => Array.from(new Set(classes))
const isFlag = (token: string) => token.startsWith('-') && token.length > 1
const TRACKED_ENV_NAMES: Record<string, true> = { GIT_DIR: true, GIT_WORK_TREE: true, HUSKY: true, HUSKY_SKIP_HOOKS: true, SKIP_HOOKS: true, CDPATH: true }

/** The most possible directories retained in a scope before its directory becomes unknown. */
export const MAX_DIRECTORIES = 16

type DirectorySet = readonly string[] | null
type DirectoryState = { possible: DirectorySet; certain: DirectorySet }
const UNKNOWN_DIRECTORY = [null] as const
const DIRECTORY_KEYWORDS: Record<string, true> = { '{': true, '!': true, '-': true, if: true, then: true, else: true, elif: true, while: true, until: true, do: true, noglob: true, nocorrect: true }

function joinDirectories(left: DirectorySet, right: DirectorySet): DirectorySet {
  if (left === null || right === null) return null
  if (left === right) return left
  const joined = new Set(left)
  for (const directory of right) {
    joined.add(directory)
    if (joined.size > MAX_DIRECTORIES) return null
  }
  return joined.size === left.length ? left : [...joined]
}

function directoriesEqual(left: DirectorySet, right: DirectorySet): boolean {
  return left === right || (left !== null && right !== null && left.length === right.length &&
    left.every((directory) => right.includes(directory)))
}

function enteredDirectories(target: string, directories: DirectorySet, home: string): DirectorySet {
  const expanded = expandHome(target, home)
  if (isAbsolute(expanded)) return [resolve(expanded)]
  if (directories === null) return null
  return [...new Set(directories.map((directory) => resolvePath(target, directory, home)))]
}

/** Combines one path's classifications without calling a possibly outside write inside. */
function directoryClasses(directories: DirectorySet, classify: (directory: string | null) => ActionClass[]): ActionClass[] {
  const classes: ActionClass[] = []
  for (const directory of directories ?? UNKNOWN_DIRECTORY) append(classes, classify(directory))
  return classes.includes('edit-outside') ? classes.filter((value) => value !== 'edit-inside') : classes
}

/** Recognizes a prefix whose shell subscript may continue across words. */
function startsSubscript(word: ShellWord): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*\[/.test(word.text)
}

/** Preserves directory state for a complete, standalone array element assignment. */
function isLoneSubscriptAssignment(words: ShellWord[], index: number): boolean {
  return index === words.length - 1 && /^[A-Za-z_][A-Za-z0-9_]*\[.*\]\+?=/s.test(words[index].text)
}

function keywordChangesDirectory(words: ShellWord[]): boolean {
  const mainIndex = unwrapWords(words).commandIndex
  let index = 0
  while (index < words.length) {
    while (index < words.length) {
      const current = words[index]
      if (!current.dynamic && (current.text === 'function' || current.text === 'repeat')) index += 2
      else if (!current.dynamic && DIRECTORY_KEYWORDS[current.text] === true) index++
      else if (!current.dynamic && current.text === 'time') {
        index++
        while (index < words.length && !words[index].dynamic && words[index].text === '-p') index++
        if (index < words.length && !words[index].dynamic && words[index].text === '--') index++
      } else if (index > 0 && /^[A-Za-z_][A-Za-z0-9_]*\+?=/s.test(current.text)) index++
      else break
    }
    if (index >= words.length) return false
    const unwrapped = unwrapWords(words, undefined, null, '', index)
    if (unwrapped.unknownWrapperFlag) return index > 0
    const resolvedIndex = unwrapped.commandIndex
    const word = words[resolvedIndex]
    if (resolvedIndex > index && word !== undefined && !word.dynamic &&
      (word.text === 'noglob' || word.text === 'nocorrect')) {
      index = resolvedIndex
      continue
    }
    if (resolvedIndex <= mainIndex || word === undefined) return false
    if (startsSubscript(word) && resolvedIndex + 1 < words.length) return true
    return word.dynamic ? !isLoneSubscriptAssignment(words, resolvedIndex)
      : ['cd', 'pushd', 'popd', 'eval'].includes(basename(word.text))
  }
  return false
}

function append<T>(target: T[], source: readonly T[]): void {
  for (const value of source) target.push(value)
}

function expandHome(path: string, home: string): string {
  if (path === '~' || path === '$HOME' || path === '${HOME}') return home
  for (const prefix of ['~/', '$HOME/', '${HOME}/']) if (path.startsWith(prefix)) return home + path.slice(prefix.length - 1)
  return path
}

function resolvePath(path: string, cwd: string, home: string): string {
  const expanded = expandHome(path, home)
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded)
}

function roots(ctx: ClassifyContext): string[] {
  const paths = [resolve(ctx.worktreePath)]
  for (const root of ctx.handedOffPaths) paths.push(resolve(root))
  return paths
}

function isInside(path: string, rootPaths: string[]): boolean {
  return rootPaths.some((root) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep))
}

function isCredentialPath(path: string, ctx: ClassifyContext, rootPaths: string[] = roots(ctx)): boolean {
  const home = resolve(ctx.home)
  for (const dir of CREDENTIAL_HOME_DIRS) {
    const full = resolve(home, dir)
    if (path === full || path.startsWith(full + sep)) return true
  }
  if (CREDENTIAL_HOME_FILES.some((file) => path === resolve(home, file))) return true
  return basename(path).startsWith('.env') && !isInside(path, rootPaths)
}

type BraceFrame = { open: number; commas: number[]; children: BraceGroup[]; closed: boolean }
type BraceAlternative = { start: number; end: number; children: BraceGroup[] }
type BraceGroup = {
  open: number
  close: number
  commas: number[]
  children: BraceGroup[]
  parent: BraceFrame | null
  count: number
  alternatives?: BraceAlternative[]
}
type BraceRenderRange = {
  start: number
  end: number
  groups: BraceGroup[]
  cursor: number
  groupIndex: number
  closeBrace: boolean
}

function skipBalancedToken(
  text: string,
  openIndex: number,
  open: '(' | '{',
  close: ')' | '}'
): number {
  type Frame = {
    open: '(' | '{'
    close: ')' | '}'
    quote: '' | "'" | '"'
    doubleQuoted: boolean
    comments: boolean
    wordStart: boolean
  }
  const stack: Frame[] = [{
    open, close, quote: '', doubleQuoted: false,
    comments: open === '(' && !(text[openIndex - 1] === '$' && text[openIndex + 1] === '('), wordStart: true
  }]
  let cursor = openIndex + 1

  while (cursor < text.length) {
    const frame = stack[stack.length - 1]!
    const character = text[cursor]!
    if (frame.quote === "'") {
      if (character === "'") frame.quote = ''
      cursor++
      continue
    }
    if (character === '\\') {
      if (text[cursor + 1] !== '\n') frame.wordStart = false
      cursor += 2
      continue
    }
    if (frame.quote === '"' && character === '"') {
      frame.quote = ''
      cursor++
      continue
    }
    if (frame.quote === '' && frame.comments && frame.wordStart && character === '#') {
      const newline = text.indexOf('\n', cursor)
      if (newline < 0) return text.length
      cursor = newline
      continue
    }
    if (frame.quote === '' && (character === '"' || (character === "'" && !frame.doubleQuoted))) {
      frame.quote = character
      frame.wordStart = false
      cursor++
      continue
    }
    if (character === '`' || (frame.quote === '' && !frame.doubleQuoted && character === '$' && text[cursor + 1] === "'")) {
      frame.wordStart = false
      cursor = skipOpaqueToken(text, cursor)!
      continue
    }
    if (character === '$' && text[cursor + 1] === '(') {
      const arithmetic = text[cursor + 2] === '('
      const doubleQuoted = arithmetic && (frame.doubleQuoted || frame.quote === '"')
      frame.wordStart = false
      stack.push({ open: '(', close: ')', quote: '', doubleQuoted, comments: !arithmetic, wordStart: true })
      if (arithmetic) stack.push({ open: '(', close: ')', quote: '', doubleQuoted, comments: false, wordStart: true })
      cursor += arithmetic ? 3 : 2
      continue
    }
    if (character === '$' && text[cursor + 1] === '{') {
      frame.wordStart = false
      stack.push({ open: '{', close: '}', quote: '', doubleQuoted: frame.doubleQuoted || frame.quote === '"', comments: false, wordStart: true })
      cursor += 2
      continue
    }
    if (frame.quote === '"') {
      cursor++
      continue
    }
    if (!frame.doubleQuoted && (character === '<' || character === '>') && text[cursor + 1] === '(') {
      frame.wordStart = false
      stack.push({ open: '(', close: ')', quote: '', doubleQuoted: false, comments: true, wordStart: true })
      cursor += 2
      continue
    }
    if (character === frame.close) {
      stack.pop()
      if (stack.length === 0) return cursor + 1
    } else if (character === frame.open) {
      frame.wordStart = true
      stack.push({ open: frame.open, close: frame.close, quote: '', doubleQuoted: frame.doubleQuoted, comments: frame.comments, wordStart: true })
    } else {
      frame.wordStart = character === ' ' || character === '\t' ||
        character === '\n' || character === ';' || character === '|' || character === '&' ||
        character === '<' || character === '>'
    }
    cursor++
  }

  return text.length
}

function skipOpaqueToken(text: string, start: number): number | null {
  const character = text[start]!
  if (character === '\\') return Math.min(start + 2, text.length)
  if (character === "'" || character === '"') {
    const quote = character
    let cursor = start + 1
    while (cursor < text.length) {
      if (quote === '"' && text[cursor] === '\\') cursor += 2
      else if (text[cursor] === quote) return cursor + 1
      else cursor++
    }
    return text.length
  }
  if (character === '`') {
    let cursor = start + 1
    while (cursor < text.length) {
      if (text[cursor] === '\\') cursor += 2
      else if (text[cursor] === '`') return cursor + 1
      else cursor++
    }
    return text.length
  }
  if (character === '$' && text[start + 1] === "'") {
    let cursor = start + 2
    while (cursor < text.length) {
      if (text[cursor] === '\\') cursor += 2
      else if (text[cursor] === "'") return cursor + 1
      else cursor++
    }
    return text.length
  }
  if (character === '$' && (text[start + 1] === '(' || text[start + 1] === '{')) {
    return skipBalancedToken(
      text,
      start + 1,
      text[start + 1] as '(' | '{',
      text[start + 1] === '(' ? ')' : '}'
    )
  }
  if ((character === '<' || character === '>') && text[start + 1] === '(') {
    return skipBalancedToken(text, start + 1, '(', ')')
  }
  return null
}

function collectBraceCandidates(
  text: string,
  candidates: Set<string>,
  gobble: boolean
): { sawUnmatchedClose: boolean; cutOff: boolean } {
  const stack: BraceFrame[] = []
  const completed: BraceGroup[] = []
  let sawOpenBrace = false
  let sawUnmatchedClose = false

  for (let cursor = 0; cursor < text.length;) {
    const opaqueEnd = skipOpaqueToken(text, cursor)
    if (opaqueEnd !== null) {
      cursor = opaqueEnd
      continue
    }
    const character = text[cursor]!
    if (character === '{') {
      sawOpenBrace = true
      if (stack.length >= MAX_SHELL_DEPTH) return { sawUnmatchedClose, cutOff: true }
      stack.push({ open: cursor, commas: [], children: [], closed: false })
    } else if (character === ',' && stack.length > 0) {
      stack[stack.length - 1]!.commas.push(cursor)
    } else if (character === '}') {
      const frame = stack[stack.length - 1]
      if (frame === undefined) {
        if (sawOpenBrace) sawUnmatchedClose = true
      } else if (!(gobble && stack.length === 1 && frame.commas.length === 0)) {
        stack.pop()
        frame.closed = true
        const parent = stack[stack.length - 1] ?? null
        const group: BraceGroup = {
          open: frame.open,
          close: cursor,
          commas: frame.commas,
          children: frame.children,
          parent,
          count: 1
        }
        parent?.children.push(group)
        completed.push(group)
      }
    }
    cursor++
  }

  const roots: BraceGroup[] = []
  let hasCommaList = false
  for (const group of completed) {
    if (group.commas.length > 0) hasCommaList = true
    if (group.parent === null || !group.parent.closed) roots.push(group)
  }

  const countGroup = (group: BraceGroup): number => {
    for (const child of group.children) countGroup(child)
    if (group.commas.length === 0) {
      let count = 1
      for (const child of group.children) count = Math.min(MAX_BRACE_WORDS + 1, count * child.count)
      group.count = count
      return count
    }

    let childIndex = 0
    let total = 0
    let segmentStart = group.open + 1
    const alternatives: BraceAlternative[] | null =
      group.commas.length < MAX_BRACE_WORDS ? [] : null
    for (let alternativeIndex = 0; alternativeIndex <= group.commas.length; alternativeIndex++) {
      const segmentEnd = group.commas[alternativeIndex] ?? group.close
      const firstChild = childIndex
      let alternativeCount = 1
      while (childIndex < group.children.length && group.children[childIndex]!.open < segmentEnd) {
        alternativeCount = Math.min(
          MAX_BRACE_WORDS + 1,
          alternativeCount * group.children[childIndex]!.count
        )
        childIndex++
      }
      total = Math.min(MAX_BRACE_WORDS + 1, total + alternativeCount)
      if (alternatives !== null) {
        alternatives.push({
          start: segmentStart,
          end: segmentEnd,
          children: group.children.slice(firstChild, childIndex)
        })
      }
      segmentStart = segmentEnd + 1
    }
    group.count = total
    if (total <= MAX_BRACE_WORDS && alternatives !== null) group.alternatives = alternatives
    return total
  }

  let total = 1
  for (const root of roots) {
    countGroup(root)
    total = Math.min(MAX_BRACE_WORDS + 1, total * root.count)
  }
  if (!hasCommaList) return { sawUnmatchedClose, cutOff: false }
  if (total > MAX_BRACE_WORDS) return { sawUnmatchedClose, cutOff: true }

  const chunks: string[] = []
  let ranges: BraceRenderRange[] = [{
    start: 0,
    end: text.length,
    groups: roots,
    cursor: 0,
    groupIndex: 0,
    closeBrace: false
  }]
  const choices: {
    alternatives: BraceAlternative[]
    nextAlternative: number
    chunksLength: number
    ranges: BraceRenderRange[]
  }[] = []
  const makeRange = (alternative: BraceAlternative, closeBrace = false): BraceRenderRange => ({
    start: alternative.start,
    end: alternative.end,
    groups: alternative.children,
    cursor: alternative.start,
    groupIndex: 0,
    closeBrace
  })

  while (true) {
    const range = ranges[ranges.length - 1]!
    if (range.groupIndex < range.groups.length) {
      const group = range.groups[range.groupIndex++]!
      chunks.push(text.slice(range.cursor, group.open))
      range.cursor = group.close + 1
      if (group.commas.length === 0) {
        chunks.push('{')
        ranges.push({
          start: group.open + 1,
          end: group.close,
          groups: group.children,
          cursor: group.open + 1,
          groupIndex: 0,
          closeBrace: true
        })
      } else {
        const alternatives = group.alternatives!
        choices.push({
          alternatives,
          nextAlternative: 1,
          chunksLength: chunks.length,
          ranges: ranges.map((current) => ({ ...current }))
        })
        ranges.push(makeRange(alternatives[0]!))
      }
      continue
    }

    chunks.push(text.slice(range.cursor, range.end))
    ranges.pop()
    if (range.closeBrace) chunks.push('}')
    if (ranges.length !== 0) continue

    candidates.add(chunks.join(''))
    let advanced = false
    while (choices.length > 0) {
      const choice = choices[choices.length - 1]!
      if (choice.nextAlternative < choice.alternatives.length) {
        const alternative = choice.alternatives[choice.nextAlternative++]!
        chunks.length = choice.chunksLength
        ranges = choice.ranges.map((current) => ({ ...current }))
        ranges.push(makeRange(alternative))
        advanced = true
        break
      }
      choices.pop()
    }
    if (!advanced) break
  }

  return { sawUnmatchedClose, cutOff: false }
}

function fixedCredentialPrefix(candidate: string, home: string, stripFlagPrefix: boolean): string {
  let text = candidate
  if (stripFlagPrefix && text.startsWith('-')) {
    const equals = text.indexOf('=')
    if (equals < 0) return ''
    text = text.slice(equals + 1)
  }
  if (text === '') return ''

  const pieces: string[] = []
  let cursor = 0
  if (text.startsWith('~/')) {
    pieces.push(home)
    cursor = 1
  } else if (text === '~') {
    return ''
  } else if (text[0] === '~') {
    const owner = basename(resolve(home))
    if (owner !== '' && (text === `~${owner}` || text.startsWith(`~${owner}/`))) {
      if (text.length === owner.length + 1) return home
      pieces.push(home)
      cursor = owner.length + 1
    } else if (text === '~+') {
      return '.'
    } else if (text.startsWith('~+/')) {
      pieces.push('.')
      cursor = 2
    } else {
      return ''
    }
  }

  const dynamicStopAt = (index: number): boolean => {
    const character = text[index]
    return character === '$' || character === '`' || character === '{' ||
      ((character === '<' || character === '>') && text[index + 1] === '(')
  }

  if (cursor === 0 && text.startsWith('${PWD}')) {
    if (text.length === 6 || dynamicStopAt(6)) return '.'
    if (text[6] !== '/') return ''
    pieces.push('.')
    cursor = 6
  } else if (
    cursor === 0 &&
    text.startsWith('$PWD') &&
    !(/[A-Za-z0-9_]/.test(text[4] ?? ''))
  ) {
    if (text.length === 4 || dynamicStopAt(4)) return '.'
    if (text[4] !== '/') return ''
    pieces.push('.')
    cursor = 4
  }

  let segmentStart = cursor
  while (cursor < text.length) {
    if (text.startsWith('${HOME}', cursor)) {
      pieces.push(text.slice(segmentStart, cursor), home)
      cursor += 7
      segmentStart = cursor
      continue
    }
    if (text.startsWith('$HOME', cursor) && !(/[A-Za-z0-9_]/.test(text[cursor + 5] ?? ''))) {
      pieces.push(text.slice(segmentStart, cursor), home)
      cursor += 5
      segmentStart = cursor
      continue
    }
    if (text.startsWith("$'", cursor)) {
      pieces.push(text.slice(segmentStart, cursor))
      let end = cursor + 2
      while (end < text.length && text[end] !== '\\') end++
      pieces.push(text.slice(cursor + 2, end))
      return pieces.join('')
    }
    if (
      text[cursor] === '$' ||
      text[cursor] === '`' ||
      text[cursor] === '{' ||
      ((text[cursor] === '<' || text[cursor] === '>') && text[cursor + 1] === '(')
    ) {
      pieces.push(text.slice(segmentStart, cursor))
      return pieces.join('')
    }
    cursor++
  }
  pieces.push(text.slice(segmentStart))
  return pieces.join('')
}

/** The most readings one path text may have once a pattern can name `.` or `..`. */
export const MAX_PATTERN_READINGS = 16

type CredentialSegment = string | { pattern: string } | null

function credentialSegment(text: string): CredentialSegment {
  let onlyStars = text.length >= 2
  let pattern = false
  for (let index = 0; index < text.length; index++) {
    const character = text[index]
    if (character !== '*') onlyStars = false
    if ('*?[^~#'.includes(character)) pattern = true
    if ('[^~#'.includes(character)) {
      const end = character === '#' ? Math.max(0, index - 1) : index
      return { pattern: text.slice(0, end) + '*' }
    }
  }
  return onlyStars ? null : pattern ? { pattern: text } : text
}

/** Matches without backtracking; prefix mode admits any suffix after the required name. */
function credentialPatternMatches(pattern: string, name: string, prefix = false): boolean {
  const positions = new Uint8Array(name.length + 1)
  positions[0] = 1
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]
    let active = false
    if (character === '*') {
      for (let position = 1; position <= name.length; position++) {
        positions[position] ||= positions[position - 1]
      }
      active = positions.some(Boolean)
    } else {
      for (let position = name.length; position > 0; position--) {
        positions[position] = positions[position - 1] && (character === '?' || character === name[position - 1]) ? 1 : 0
        active ||= positions[position] === 1
      }
      positions[0] = 0
    }
    if (prefix && positions[name.length]) return true
    if (!active) return false
  }
  return positions[name.length] === 1
}

/** Keeps directory names literal and bounds the shell's alternative dot-directory readings. */
function credentialReadings(text: string, directory: string): CredentialSegment[][] | null {
  const readings: CredentialSegment[][] = [
    isAbsolute(text) ? [] : resolve(directory).split('/').filter(Boolean)
  ]
  for (const part of text.split('/')) {
    if (part === '' || part === '.') continue
    const count = readings.length
    if (part === '..') {
      for (let index = 0; index < count; index++) {
        const reading = readings[index]
        if (reading[reading.length - 1] === null) readings.push(reading.slice(0, -2))
        else reading.pop()
      }
    } else {
      const segment = credentialSegment(part)
      const dot = segment !== null && typeof segment !== 'string' && segment.pattern.startsWith('.')
      const current = dot && credentialPatternMatches(segment.pattern.slice(1), '')
      const parent = dot && credentialPatternMatches(segment.pattern.slice(1), '.')
      for (let index = 0; index < count; index++) {
        const reading = readings[index]
        if (current) readings.push(reading.slice())
        if (parent) {
          if (reading[reading.length - 1] === null) {
            readings.push(reading.slice(), reading.slice(0, -2))
          } else readings.push(reading.slice(0, -1))
        }
        reading.push(segment)
      }
    }
    if (readings.length > MAX_PATTERN_READINGS) return null
    if (part.includes('~')) {
      for (const reading of readings) reading.push(null)
      break
    }
  }
  return readings
}

function credentialSegmentsMatch(reading: CredentialSegment[], target: string[], descendants: boolean): boolean {
  let positions = new Uint8Array(target.length + 1)
  let next = new Uint8Array(target.length + 1)
  positions[0] = 1
  for (const segment of reading) {
    next.fill(0)
    let active = false
    if (segment === null) {
      for (let position = 0; position <= target.length; position++) {
        active ||= positions[position] === 1
        next[position] = active ? 1 : 0
      }
    } else {
      for (let position = 0; position < target.length; position++) {
        if (positions[position] && (typeof segment === 'string'
          ? segment === target[position]
          : credentialPatternMatches(segment.pattern, target[position]))) {
          next[position + 1] = 1
          active = true
        }
      }
    }
    if (descendants && next[target.length]) return true
    if (!active) return false
    const previous = positions
    positions = next
    next = previous
  }
  return positions[target.length] === 1
}

function credentialReadingMatches(reading: CredentialSegment[], ctx: ClassifyContext, rootPaths: string[]): boolean {
  const home = resolve(ctx.home).split('/').filter(Boolean)
  for (const dir of CREDENTIAL_HOME_DIRS) {
    if (credentialSegmentsMatch(reading, home.concat(dir.split('/')), true)) return true
  }
  for (const file of CREDENTIAL_HOME_FILES) {
    if (credentialSegmentsMatch(reading, home.concat(file), false)) return true
  }
  const last = reading[reading.length - 1]
  if (last === undefined || (typeof last === 'string' ? !last.startsWith('.env')
    : last !== null && !credentialPatternMatches(last.pattern, '.env', true))) return false
  const names: string[] = []
  for (const segment of reading) {
    if (typeof segment !== 'string') break
    names.push(segment)
  }
  return !isInside('/' + names.join('/'), rootPaths)
}

function credentialPathText(
  text: string, directory: string, ctx: ClassifyContext, rootPaths: string[]
): 'credential' | 'edit-outside' | null {
  const readings = credentialReadings(text, directory)
  if (readings === null) return 'edit-outside'
  return readings.some((reading) => credentialReadingMatches(reading, ctx, rootPaths)) ? 'credential' : null
}

function wordTouchesCredential(
  word: ShellWord,
  directories: DirectorySet,
  ctx: ClassifyContext,
  rootPaths: string[],
  stripFlagPrefix: boolean
): 'credential' | 'edit-outside' | null {
  if (!word.dynamic) {
    let value = word.text
    if (stripFlagPrefix && value.startsWith('-')) {
      const equals = value.indexOf('=')
      if (equals < 0) return null
      value = value.slice(equals + 1)
    }
    if (value === '') return null
    const expanded = expandHome(value, ctx.home)
    let cutOff = false
    for (const directory of directories ?? UNKNOWN_DIRECTORY) {
      if (directory === null && !isAbsolute(expanded)) continue
      const result = credentialPathText(expanded, directory ?? '/', ctx, rootPaths)
      if (result === 'credential') return result
      cutOff ||= result === 'edit-outside'
      if (isAbsolute(expanded)) break
    }
    return cutOff ? 'edit-outside' : null
  }

  const candidates = new Set([word.text])
  let cutOff = false
  if (word.text.includes('{')) {
    const standard = collectBraceCandidates(word.text, candidates, false)
    cutOff ||= standard.cutOff
    if (standard.sawUnmatchedClose) {
      const gobbled = collectBraceCandidates(word.text, candidates, true)
      cutOff ||= gobbled.cutOff
    }
  }

  for (const candidate of candidates) {
    const prefix = fixedCredentialPrefix(candidate, ctx.home, stripFlagPrefix)
    if (prefix === '') continue
    const absolute = isAbsolute(prefix)
    for (const directory of directories ?? UNKNOWN_DIRECTORY) {
      if (directory === null && !absolute) continue
      const result = credentialPathText(prefix, directory ?? '/', ctx, rootPaths)
      if (result === 'credential') return result
      cutOff ||= result === 'edit-outside'
      if (absolute) break
    }
  }
  return cutOff ? 'edit-outside' : null
}


function isAgentConfigPath(path: string): boolean {
  if (/(^|\/)\.claude\/settings[^/]*\.json$/.test(path)) return true
  if (/(^|\/)\.codex(\/|$)/.test(path)) return true
  if (/(^|\/)\.(pi|omp)\/(.*\/)?extensions(\/|$)/.test(path)) return true
  return basename(path) === 'hooks.json'
}

function readClasses(path: string, ctx: ClassifyContext): ActionClass[] {
  return isCredentialPath(path, ctx) ? ['credential'] : ['read']
}

function writeClasses(rawPath: string, cwd: string, ctx: ClassifyContext, rootPaths: string[] = roots(ctx)): ActionClass[] {
  const expanded = expandHome(rawPath, ctx.home)
  const path = resolvePath(rawPath, cwd, ctx.home)
  const classes: ActionClass[] = []
  if (isCredentialPath(path, ctx, rootPaths)) classes.push('credential')
  if (isAgentConfigPath(path)) classes.push('agent-config')
  classes.push(expanded.includes('$') || !isInside(path, rootPaths) ? 'edit-outside' : 'edit-inside')
  return classes
}

type WrapperTarget = { target: ShellWord; cwd: DirectorySet }
type UnwrappedWords = {
  commandIndex: number
  credential: boolean
  throughXargs: boolean
  dynamicBeforeCommand: boolean
  unknownWrapperFlag: boolean
  execCwd: DirectorySet
  wrapperReads: WrapperTarget[]
  wrapperWrites: WrapperTarget[]
}


function assignmentFromWord(word: ShellWord): WordAssignment | null {
  const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(word.text)
  if (assignment === null) return null
  return {
    name: assignment[1],
    word,
    value: { text: assignment[2], dynamic: word.dynamic || /^~[^/]/.test(assignment[2]), subs: word.subs }
  }
}

function unwrapWords(words: ShellWord[], wrapperAssignments?: WordAssignment[], commandCwd: DirectorySet = null, home = '', start = 0): UnwrappedWords {
  let commandIndex = start
  let credential = false
  let throughXargs = false
  let dynamicBeforeCommand = false
  let unknownWrapperFlag = false
  let execCwd = commandCwd
  const wrapperReads: WrapperTarget[] = []
  const wrapperWrites: WrapperTarget[] = []
  wrappers: while (commandIndex < words.length) {
    const word = words[commandIndex]
    if (word.dynamic) break
    const wrapper = basename(word.text)
    const spec = Object.hasOwn(WRAPPER_SPECS, wrapper) ? WRAPPER_SPECS[wrapper] : undefined
    if (spec === undefined) break
    const afterXargs = throughXargs
    const wrapperIndex = commandIndex
    if (wrapper === 'sudo' || wrapper === 'doas') credential = true
    if (wrapper === 'xargs') throughXargs = true
    let lookup = false
    let lastChdir: ShellWord | undefined
    commandIndex++
    while (commandIndex < words.length) {
      const option = words[commandIndex]
      if (!option.text.startsWith('-')) break
      if (option.text === '--' || option.text === '-') {
        if (option.dynamic || (option.text === '-' && wrapper !== 'env') ||
          (wrapper === 'env' && (option.text === '--' ? words[commandIndex + 1]?.text === '-' : words[commandIndex + 1]?.text.startsWith('-')))) {
          unknownWrapperFlag = true
          break wrappers
        }
        commandIndex++
        break
      }
      if (!option.dynamic && spec.numericIncrement && /^-[+-]?\d+$/.test(option.text)) {
        commandIndex++
        continue
      }
      let flag = ''
      let value: ShellWord | undefined
      if (option.text.startsWith('--')) {
        const equals = option.text.indexOf('=')
        flag = option.text.slice(2, equals < 0 ? undefined : equals)
        const raw = equals < 0 ? '' : option.text.slice(equals + 1)
        if (spec.longFlags?.includes(flag)) {
          if (equals >= 0 || option.dynamic) {
            unknownWrapperFlag = true
            break wrappers
          }
          commandIndex++
        } else if (spec.longOptionalValues?.includes(flag) || spec.longAttachedValues?.includes(flag)) {
          if ((equals < 0 && option.dynamic) || (equals < 0 && spec.longAttachedValues?.includes(flag))) {
            unknownWrapperFlag = true
            break wrappers
          }
          if (equals >= 0 && (option.dynamic || /^~[^/]/.test(raw))) dynamicBeforeCommand = true
          commandIndex++
        } else if (spec.longValues?.includes(flag)) {
          if (equals >= 0) {
            value = { text: raw, dynamic: option.dynamic || /^~[^/]/.test(raw), subs: option.subs }
            commandIndex++
          } else {
            if (option.dynamic || words[commandIndex + 1] === undefined) {
              unknownWrapperFlag = true
              break wrappers
            }
            value = words[commandIndex + 1]
            commandIndex += 2
          }
        } else {
          unknownWrapperFlag = true
          break wrappers
        }
      } else {
        if (option.dynamic) {
          unknownWrapperFlag = true
          break wrappers
        }
        commandIndex++
        for (let j = 1; j < option.text.length; j++) {
          flag = option.text[j]
          if (spec.shortFlags?.includes(flag)) {
            if (wrapper === 'command' && (flag === 'v' || flag === 'V')) lookup = true
            continue
          }
          if (!spec.shortValues?.includes(flag)) {
            unknownWrapperFlag = true
            break wrappers
          }
          const rest = option.text.slice(j + 1)
          if (rest !== '') value = { text: rest, dynamic: /^~[^/]/.test(rest), subs: option.subs }
          else value = words[commandIndex++]
          if (value === undefined) {
            unknownWrapperFlag = true
            break wrappers
          }
          break
        }
      }
      if (value !== undefined) {
        if (value.dynamic) dynamicBeforeCommand = true
        if (flag === spec.chdir || (spec.chdir !== undefined && flag === 'chdir')) lastChdir = value
        if (wrapper === 'time' && (flag === 'o' || flag === 'output')) wrapperWrites.push({ target: value, cwd: execCwd })
        if (wrapper === 'xargs' && (flag === 'a' || flag === 'arg-file')) wrapperReads.push({ target: value, cwd: execCwd })
      }
    }
    if (lookup) {
      commandIndex = wrapperIndex
      break
    }
    if (wrapper === 'env' || wrapper === 'sudo') {
      while (commandIndex < words.length) {
        const option = words[commandIndex]
        const assignment = assignmentFromWord(option)
        if (assignment === null) {
          if (option.dynamic && option.text.includes('=')) {
            unknownWrapperFlag = true
            break wrappers
          }
          break
        }
        if (TRACKED_ENV_NAMES[assignment.name] === true) wrapperAssignments?.push(assignment)
        commandIndex++
      }
    }
    if (lastChdir !== undefined) {
      const target = lastChdir.text
      execCwd = lastChdir.dynamic || target === '' ? null
        : target === '~' || target.startsWith('~/') ? execCwd === null ? null : execCwd.map((directory) => resolve(directory, target))
        : enteredDirectories(target, execCwd, home)
    }
    if (spec.durationOperand && commandIndex < words.length) {
      if (words[commandIndex].dynamic) dynamicBeforeCommand = true
      commandIndex++
    }
    if (afterXargs && commandIndex >= words.length) {
      unknownWrapperFlag = true
      break
    }
  }
  return { commandIndex, credential, throughXargs, dynamicBeforeCommand, unknownWrapperFlag, execCwd, wrapperReads, wrapperWrites }
}

function isArgumentExemptCommand(word: ShellWord | undefined): boolean {
  if (word === undefined || word.dynamic) return false
  const name = word.text.startsWith('/usr/bin/') ? word.text.slice(9) : word.text.startsWith('/bin/') ? word.text.slice(5) : word.text
  return NO_ARGUMENT_EFFECT_CMDS[name] === true
}

function parseSegment(command: ShellCommand, commandCwd: DirectorySet, ctx: ClassifyContext): Parsed {
  const wrapperAssignments: WordAssignment[] = []
  const unwrapped = unwrapWords(command.words, wrapperAssignments, commandCwd, ctx.home)
  const commandWord = unwrapped.unknownWrapperFlag ? undefined : command.words[unwrapped.commandIndex]
  const argWords = commandWord === undefined ? [] : command.words.slice(unwrapped.commandIndex + 1)
  const args: string[] = []
  for (const word of argWords) args.push(word.text)
  const text = commandWord === undefined ? '' : commandWord.text + (args.length === 0 ? '' : ` ${args.join(' ')}`)
  return {
    cmd: commandWord === undefined ? '' : basename(commandWord.text),
    commandIndex: commandWord === undefined ? -1 : unwrapped.commandIndex,
    args,
    argWords,
    text,
    assignments: command.assignments,
    wrapperAssignments,
    credential: unwrapped.credential,
    throughXargs: unwrapped.throughXargs,
    wrapped: unwrapped.commandIndex > 0,
    dynamicCommand: commandWord?.dynamic ?? false,
    dynamicBeforeCommand: unwrapped.dynamicBeforeCommand,
    unknownWrapperFlag: unwrapped.unknownWrapperFlag,
    subscriptBeforeCommand: commandWord !== undefined && startsSubscript(commandWord) && argWords.length > 0,
    loneSubscriptAssignment: isLoneSubscriptAssignment(command.words, unwrapped.commandIndex),
    argumentExempt: isArgumentExemptCommand(commandWord),
    execCwd: unwrapped.execCwd,
    wrapperReads: unwrapped.wrapperReads,
    wrapperWrites: unwrapped.wrapperWrites
  }
}


function matchesCommandList(text: string, list: string[]): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return list.some((entry) => {
    const pattern = entry.replace(/\s+/g, ' ').trim()
    return pattern !== '' && (normalized === pattern || normalized.startsWith(pattern + ' '))
  })
}

function positionals(args: string[], valueFlags: Set<string> = new Set()): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--') {
      for (let j = i + 1; j < args.length; j++) out.push(args[j])
      break
    }
    if (isFlag(args[i])) {
      if (valueFlags.has(args[i])) i++
    } else out.push(args[i])
  }
  return out
}

function positionalWords(args: ShellWord[], valueFlags: Set<string> = new Set()): ShellWord[] {
  const out: ShellWord[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i].text === '--') {
      for (let j = i + 1; j < args.length; j++) out.push(args[j])
      break
    }
    if (isFlag(args[i].text)) {
      if (valueFlags.has(args[i].text)) i++
    } else out.push(args[i])
  }
  return out
}


function scriptClass(name: string | undefined): 'test' | 'build' | null {
  if (!name) return null
  if (/^(test|tests|spec|e2e|coverage)(:|$)/.test(name)) return 'test'
  if (/^(build|typecheck|type-check|tsc|lint|check|compile|types|format:check|fmt:check)(:|$)/.test(name)) return 'build'
  return null
}

function testOrBuild(kind: 'test' | 'build' | null, args: string[]): ActionClass[] {
  if (!kind) return ['other']
  if (kind === 'test' && args.some((arg) => UPDATE_FLAGS.has(arg))) return ['other']
  return [kind]
}

const BUILTIN_DEPLOY_RUNNERS = /^(deploy|migrate|publish|release)([:\-_]|$)/

function isBuiltinDeploy(cmd: string, args: string[]): boolean {
  const sub = positionals(args, PACKAGE_VALUE_FLAGS)
  const first = sub[0]
  if (cmd === 'kubectl') return ['apply', 'rollout', 'replace', 'patch'].includes(first)
  if (cmd === 'helm') return ['upgrade', 'install'].includes(first)
  if (cmd === 'terraform' || cmd === 'tofu') return ['apply', 'destroy'].includes(first)
  if (cmd === 'pulumi') return first === 'up'
  if (cmd === 'fly' || cmd === 'flyctl' || cmd === 'firebase' || cmd === 'wrangler' || cmd === 'cdk' || cmd === 'serverless' || cmd === 'sls') return ['deploy', 'publish'].includes(first)
  if (cmd === 'vercel' || cmd === 'netlify') return first === 'deploy' || args.includes('--prod')
  if (cmd === 'alembic') return first === 'upgrade'
  if (cmd === 'prisma') return first === 'migrate'
  if (cmd === 'rails') return first === 'db:migrate'
  if (PACKAGE_MANAGERS.has(cmd)) {
    if (first === 'publish') return true
    const script = first === 'run' || first === 'run-script' ? sub[1] : first
    return script !== undefined && BUILTIN_DEPLOY_RUNNERS.test(script)
  }
  return false
}

function classifyPackageManager(cmd: string, args: string[]): ActionClass[] {
  const sub = positionals(args, PACKAGE_VALUE_FLAGS)
  const first = sub[0]
  if (first === 'test' || first === 't') return testOrBuild('test', args)
  if (first === 'run' || first === 'run-script') return testOrBuild(scriptClass(sub[1]), args)
  if (first === 'x' || first === 'exec' || first === 'dlx') return classifyTool(sub[1], args.slice(args.indexOf(sub[1]) + 1))
  if (first === 'build' && cmd === 'bun') return ['build']
  if (first === 'install' || first === 'i' || first === 'ci') return sub.length === 1 ? ['build'] : ['other']
  const kind = scriptClass(first)
  return kind && cmd !== 'bun' ? testOrBuild(kind, args) : ['other']
}

function classifyTool(tool: string | undefined, args: string[]): ActionClass[] {
  if (!tool) return ['other']
  if (TEST_RUNNERS.has(tool)) return testOrBuild('test', args)
  if (tool === 'prettier') return args.includes('--write') || args.includes('-w') ? ['edit-inside'] : ['build']
  if (BUILD_TOOLS.has(tool)) return ['build']
  return ['other']
}

/**
 * True when the repository or worktree a git command acts on lies outside every handed-off path.
 * Considers the call's cwd, `-C`, `--git-dir`, `--work-tree`, `-c core.worktree` and environment
 * redirects. A dynamic value or relative path from an unknown cwd counts as outside.
 */
function gitTargetsOutside(cwd: string | null, chdirs: ShellWord[], redirects: ShellWord[], ctx: ClassifyContext): boolean {
  const rootPaths = roots(ctx)
  let gitCwd = cwd
  for (const dir of chdirs) {
    const expanded = expandHome(dir.text, ctx.home)
    if (dir.dynamic || (gitCwd === null && !isAbsolute(expanded))) return true
    gitCwd = resolvePath(dir.text, gitCwd ?? '/', ctx.home)
  }
  if (gitCwd === null || !isInside(gitCwd, rootPaths)) return true
  for (const value of redirects) {
    const expanded = expandHome(value.text, ctx.home)
    if (value.dynamic) return true
    if (cwd === null && !isAbsolute(expanded)) return true
    if (!isInside(resolvePath(value.text, gitCwd, ctx.home), rootPaths)) return true
    if (cwd !== null && !isInside(resolvePath(value.text, cwd, ctx.home), rootPaths)) return true
  }
  return false
}

/**
 * True when a `git worktree add|remove|move` names a path outside every handed-off path.
 * Paths resolve against the directory git runs in after `-C` hops; dynamic values are outside.
 */
function worktreeTargetsOutside(rest: ShellWord[], gitCwd: string | null, ctx: ClassifyContext): boolean {
  const operands = positionalWords(rest, GIT_WORKTREE_VALUE_FLAGS)
  const action = operands[0]?.text
  const end = action === 'remove' ? operands.length : action === 'move' ? Math.min(operands.length, 3) : action === 'add' ? Math.min(operands.length, 2) : 1
  const rootPaths = roots(ctx)
  for (let i = 1; i < end; i++) {
    const target = operands[i]
    const expanded = expandHome(target.text, ctx.home)
    if (target.dynamic || (gitCwd === null && !isAbsolute(expanded))) return true
    if (!isInside(resolvePath(target.text, gitCwd ?? '/', ctx.home), rootPaths)) return true
  }
  return false
}

function classifyGit(args: ShellWord[], env: Map<string, ShellWord>, ctx: ClassifyContext, cwd: string | null, pushDests: string[]): ActionClass[] {
  const classes: ActionClass[] = []
  const chdirs: ShellWord[] = []
  const redirects: ShellWord[] = []
  const textArgs: string[] = []
  for (const arg of args) textArgs.push(arg.text)
  let sub: string | undefined
  let subIndex = -1
  for (let i = 0; i < args.length; i++) {
    const word = args[i]
    const arg = word.text
    if (arg === '-C') {
      if (args[i + 1] !== undefined) chdirs.push(args[++i])
      continue
    }
    if (arg.startsWith('-C') && arg.length > 2) {
      chdirs.push({ text: arg.slice(2), dynamic: word.dynamic, subs: word.subs })
      continue
    }
    const redirect = /^--(?:git-dir|work-tree)(?:=(.*))?$/s.exec(arg)
    if (redirect) {
      const value = redirect[1] === undefined ? args[++i] : { text: redirect[1], dynamic: word.dynamic, subs: word.subs }
      if (value !== undefined && value.text !== '') redirects.push(value)
      continue
    }
    if (arg === '-c') {
      const config = args[i + 1]
      if (config !== undefined && /^core\.hooksPath=/i.test(config.text)) classes.push('skip-hooks')
      const worktree = config === undefined ? null : /^core\.worktree=(.*)$/is.exec(config.text)
      if (worktree && worktree[1] !== '') redirects.push({ text: worktree[1], dynamic: config.dynamic, subs: config.subs })
      i++
      continue
    }
    if (isFlag(arg)) continue
    sub = arg
    subIndex = i
    break
  }
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE']) {
    const value = env.get(name)
    if (value !== undefined && (value.dynamic || value.text !== '')) redirects.push(value)
  }
  const outside = gitTargetsOutside(cwd, chdirs, redirects, ctx)
  const localEdit: ActionClass = outside ? 'edit-outside' : 'edit-inside'
  const restWords = subIndex >= 0 ? args.slice(subIndex + 1) : []
  const rest = subIndex >= 0 ? textArgs.slice(subIndex + 1) : []
  const hooksEnv = ['HUSKY', 'HUSKY_SKIP_HOOKS', 'SKIP_HOOKS'].some((name) => {
    const value = env.get(name)
    return value !== undefined && !value.dynamic && /^(0|1|true)$/.test(value.text)
  })
  if ((hooksEnv && ['commit', 'push', 'merge', 'rebase'].includes(sub ?? '')) || rest.includes('--no-verify') || (sub === 'commit' && rest.includes('-n')) || rest.some((arg) => /core\.hooksPath/i.test(arg))) classes.push('skip-hooks')
  if (sub === undefined) return classes.length > 0 ? classes : ['read']
  if (sub === 'push') {
    append(classes, classifyPush(rest, ctx, pushDests))
    if (outside) classes.push('edit-outside')
    return classes
  }
  if (sub === 'rebase') {
    classes.push('push-force', localEdit)
    return classes
  }
  if (sub === 'ls-remote' || sub === 'clone') {
    classes.push('network-read')
    return classes
  }
  if (GIT_READ_SUBCOMMANDS.has(sub)) {
    classes.push('read')
    return classes
  }
  if (sub === 'worktree') {
    let gitCwd = cwd
    for (const dir of chdirs) {
      const expanded = expandHome(dir.text, ctx.home)
      if (dir.dynamic || (gitCwd === null && !isAbsolute(expanded))) {
        gitCwd = null
        break
      }
      gitCwd = resolvePath(dir.text, gitCwd ?? '/', ctx.home)
    }
    classes.push(outside || worktreeTargetsOutside(restWords, gitCwd, ctx) ? 'edit-outside' : 'edit-inside')
    return classes
  }
  if (GIT_LOCAL_SUBCOMMANDS.has(sub)) {
    classes.push(localEdit)
    return classes
  }
  classes.push('other')
  return classes
}

function classifyPush(args: string[], ctx: ClassifyContext, pushDests: string[]): ActionClass[] {
  const classes: ActionClass[] = []
  const flags = args.filter(isFlag)
  const refspecs = positionals(args, GIT_PUSH_VALUE_FLAGS).slice(1)
  if (flags.some((flag) => flag === '-f' || flag.startsWith('--force'))) classes.push('push-force')
  if (flags.includes('--delete') || flags.includes('-d')) classes.push('remote-delete')
  if (flags.includes('--all') || flags.includes('--mirror')) classes.push('push-default')
  for (const raw of refspecs.length === 0 ? [''] : refspecs) {
    let spec = raw
    if (spec.startsWith('+')) {
      classes.push('push-force')
      spec = spec.slice(1)
    }
    const colon = spec.indexOf(':')
    if (colon === 0) classes.push('remote-delete')
    let dest = (colon >= 0 ? spec.slice(colon + 1) : spec).replace(/^refs\/heads\//, '')
    if (dest === '' || dest === 'HEAD') dest = ctx.ownBranch
    pushDests.push(dest)
    classes.push(dest === ctx.defaultBranch ? 'push-default' : 'push-own')
  }
  return classes
}

function classifyPullRequestCli(cmd: 'gh' | 'glab', args: string[]): ActionClass[] {
  const [group, action] = positionals(args)
  if (group === 'auth') return ['credential']
  if (group === 'api') {
    const writes = args.some((arg) => GH_WRITE_FLAG.test(arg))
    return writes ? ['other'] : ['network-read']
  }
  const prGroup = cmd === 'gh' ? 'pr' : 'mr'
  if (group === prGroup) {
    if (action === 'create') return args.includes('--draft') || args.includes('-d') ? ['pr-draft'] : ['pr-ready']
    if (action === 'ready' || action === 'unready') return action === 'ready' ? ['pr-ready'] : ['pr-draft']
    if (action === 'merge') return ['merge']
    if (action === 'comment' || action === 'review' || action === 'note' || action === 'approve') return ['message-people']
  }
  if ((group === 'issue' || group === prGroup) && action !== undefined && (GH_MESSAGE_SUBCOMMANDS.has(action) || action === 'create' || action === 'note')) return ['message-people']
  if (action !== undefined && GH_READ_SUBCOMMANDS.has(action)) return ['read']
  return ['other']
}

type DownloadOptions = {
  shortFlags: string
  shortValues: string
  longFlags: Record<string, true>
  longValues: Record<string, true>
  files: Record<string, true>
  stdout: Record<string, true>
  directories: Record<string, true>
  remote: Record<string, true>
  opaqueNames: Record<string, true>
  hidden: Record<string, true>
  movedFiles: Record<string, true>
  next: Record<string, true>
  urls: Record<string, true>
  formats: Record<string, true>
}

const DOWNLOAD_OPTIONS: Record<'curl' | 'wget', DownloadOptions> = {
  curl: {
    shortFlags: 'aqfGgI0ik46jlLMn:NZ#pJORSs231BvVh',
    shortValues: 'EKCbcdDFPHmoUQreXYytzTuAwx',
    longFlags: { 'anyauth': true, 'append': true, 'basic': true, 'ca-native': true, 'cert-status': true, 'compressed': true, 'compressed-ssh': true, 'create-dirs': true, 'crlf': true, 'digest': true, 'disable': true, 'disable-eprt': true, 'disable-epsv': true, 'disallow-username-in-url': true, 'doh-cert-status': true, 'doh-insecure': true, 'fail': true, 'fail-early': true, 'fail-with-body': true, 'false-start': true, 'form-escape': true, 'ftp-create-dirs': true, 'ftp-pasv': true, 'ftp-pret': true, 'ftp-skip-pasv-ip': true, 'ftp-ssl-ccc': true, 'ftp-ssl-control': true, 'get': true, 'globoff': true, 'haproxy-protocol': true, 'head': true, 'help': true, 'http0.9': true, 'http1.0': true, 'http1.1': true, 'http2': true, 'http2-prior-knowledge': true, 'http3': true, 'http3-only': true, 'ignore-content-length': true, 'include': true, 'insecure': true, 'ipv4': true, 'ipv6': true, 'junk-session-cookies': true, 'list-only': true, 'location': true, 'location-trusted': true, 'mail-rcpt-allowfails': true, 'manual': true, 'metalink': true, 'negotiate': true, 'netrc': true, 'netrc-optional': true, 'next': true, 'no-alpn': true, 'no-buffer': true, 'no-clobber': true, 'no-keepalive': true, 'no-npn': true, 'no-progress-meter': true, 'no-sessionid': true, 'ntlm': true, 'ntlm-wb': true, 'parallel': true, 'parallel-immediate': true, 'path-as-is': true, 'post301': true, 'post302': true, 'post303': true, 'progress-bar': true, 'proxy-anyauth': true, 'proxy-basic': true, 'proxy-ca-native': true, 'proxy-digest': true, 'proxy-http2': true, 'proxy-insecure': true, 'proxy-negotiate': true, 'proxy-ntlm': true, 'proxy-ssl-allow-beast': true, 'proxy-ssl-auto-client-cert': true, 'proxy-tlsv1': true, 'proxytunnel': true, 'raw': true, 'remote-header-name': true, 'remote-name': true, 'remote-name-all': true, 'remote-time': true, 'remove-on-error': true, 'retry-all-errors': true, 'retry-connrefused': true, 'sasl-ir': true, 'show-error': true, 'silent': true, 'socks5-basic': true, 'socks5-gssapi': true, 'socks5-gssapi-nec': true, 'ssl': true, 'ssl-allow-beast': true, 'ssl-auto-client-cert': true, 'ssl-no-revoke': true, 'ssl-reqd': true, 'ssl-revoke-best-effort': true, 'sslv2': true, 'sslv3': true, 'styled-output': true, 'suppress-connect-headers': true, 'tcp-fastopen': true, 'tcp-nodelay': true, 'tftp-no-options': true, 'tlsv1': true, 'tlsv1.0': true, 'tlsv1.1': true, 'tlsv1.2': true, 'tlsv1.3': true, 'tr-encoding': true, 'trace-ids': true, 'trace-time': true, 'use-ascii': true, 'verbose': true, 'version': true, 'xattr': true },
    longValues: { 'abstract-unix-socket': true, 'alt-svc': true, 'aws-sigv4': true, 'cacert': true, 'capath': true, 'cert': true, 'cert-type': true, 'ciphers': true, 'config': true, 'connect-timeout': true, 'connect-to': true, 'continue-at': true, 'cookie': true, 'cookie-jar': true, 'create-file-mode': true, 'crlfile': true, 'curves': true, 'data': true, 'data-ascii': true, 'data-binary': true, 'data-raw': true, 'data-urlencode': true, 'delegation': true, 'dns-interface': true, 'dns-ipv4-addr': true, 'dns-ipv6-addr': true, 'dns-servers': true, 'doh-url': true, 'dump-header': true, 'egd-file': true, 'engine': true, 'etag-compare': true, 'etag-save': true, 'expect100-timeout': true, 'form': true, 'form-string': true, 'ftp-account': true, 'ftp-alternative-to-user': true, 'ftp-method': true, 'ftp-port': true, 'ftp-ssl-ccc-mode': true, 'happy-eyeballs-timeout-ms': true, 'haproxy-clientip': true, 'header': true, 'hostpubmd5': true, 'hostpubsha256': true, 'hsts': true, 'interface': true, 'ipfs-gateway': true, 'json': true, 'keepalive-time': true, 'key': true, 'key-type': true, 'krb': true, 'libcurl': true, 'limit-rate': true, 'local-port': true, 'login-options': true, 'mail-auth': true, 'mail-from': true, 'mail-rcpt': true, 'max-filesize': true, 'max-redirs': true, 'max-time': true, 'netrc-file': true, 'noproxy': true, 'oauth2-bearer': true, 'output': true, 'output-dir': true, 'parallel-max': true, 'pass': true, 'pinnedpubkey': true, 'preproxy': true, 'proto': true, 'proto-default': true, 'proto-redir': true, 'proxy': true, 'proxy-cacert': true, 'proxy-capath': true, 'proxy-cert': true, 'proxy-cert-type': true, 'proxy-ciphers': true, 'proxy-crlfile': true, 'proxy-header': true, 'proxy-key': true, 'proxy-key-type': true, 'proxy-pass': true, 'proxy-pinnedpubkey': true, 'proxy-service-name': true, 'proxy-tls13-ciphers': true, 'proxy-tlsauthtype': true, 'proxy-tlspassword': true, 'proxy-tlsuser': true, 'proxy-user': true, 'proxy1.0': true, 'pubkey': true, 'quote': true, 'random-file': true, 'range': true, 'rate': true, 'referer': true, 'request': true, 'request-target': true, 'resolve': true, 'retry': true, 'retry-delay': true, 'retry-max-time': true, 'sasl-authzid': true, 'service-name': true, 'socks4': true, 'socks4a': true, 'socks5': true, 'socks5-gssapi-service': true, 'socks5-hostname': true, 'speed-limit': true, 'speed-time': true, 'stderr': true, 'telnet-option': true, 'tftp-blksize': true, 'time-cond': true, 'tls-max': true, 'tls13-ciphers': true, 'tlsauthtype': true, 'tlspassword': true, 'tlsuser': true, 'trace': true, 'trace-ascii': true, 'trace-config': true, 'unix-socket': true, 'upload-file': true, 'url': true, 'url-query': true, 'user': true, 'user-agent': true, 'variable': true, 'write-out': true },
    files: { 'o': true, 'output': true, 'D': true, 'dump-header': true, 'c': true, 'cookie-jar': true, 'trace': true, 'trace-ascii': true, 'stderr': true, 'libcurl': true, 'etag-save': true, 'hsts': true, 'alt-svc': true },
    stdout: { 'o': true, 'output': true, 'D': true, 'dump-header': true, 'c': true, 'cookie-jar': true, 'trace': true, 'trace-ascii': true, 'stderr': true, 'libcurl': true, 'etag-save': true },
    directories: { 'output-dir': true },
    remote: { 'O': true, 'remote-name': true, 'remote-name-all': true },
    opaqueNames: { 'J': true, 'remote-header-name': true },
    hidden: { 'K': true, 'config': true },
    movedFiles: { 'o': true, 'output': true },
    next: { 'next': true, ':': true },
    urls: { 'url': true },
    formats: { 'w': true, 'write-out': true }
  },
  wget: {
    shortFlags: 'qvcNS46drmpx',
    shortValues: 'OPoatTwUnei',
    longFlags: { 'quiet': true, 'verbose': true, 'no-verbose': true, 'continue': true, 'timestamping': true, 'no-clobber': true, 'server-response': true, 'spider': true, 'no-check-certificate': true, 'show-progress': true, 'no-hsts': true, 'no-cache': true, 'no-cookies': true, 'https-only': true, 'inet4-only': true, 'inet6-only': true, 'debug': true, 'no-proxy': true, 'retry-connrefused': true, 'no-dns-cache': true, 'keep-session-cookies': true, 'content-on-error': true, 'no-http-keep-alive': true, 'recursive': true, 'mirror': true, 'page-requisites': true, 'force-directories': true, 'content-disposition': true, 'trust-server-names': true },
    longValues: { 'output-document': true, 'directory-prefix': true, 'output-file': true, 'append-output': true, 'save-cookies': true, 'rejected-log': true, 'hsts-file': true, 'warc-file': true, 'tries': true, 'timeout': true, 'dns-timeout': true, 'connect-timeout': true, 'read-timeout': true, 'wait': true, 'waitretry': true, 'user-agent': true, 'header': true, 'referer': true, 'user': true, 'password': true, 'http-user': true, 'http-password': true, 'limit-rate': true, 'max-redirect': true, 'progress': true, 'load-cookies': true, 'ca-certificate': true, 'certificate': true, 'private-key': true, 'post-data': true, 'post-file': true, 'method': true, 'body-data': true, 'body-file': true, 'secure-protocol': true, 'execute': true, 'input-file': true, 'config': true, 'default-page': true },
    files: { 'O': true, 'output-document': true, 'o': true, 'output-file': true, 'a': true, 'append-output': true, 'save-cookies': true, 'rejected-log': true, 'hsts-file': true, 'warc-file': true },
    stdout: { 'O': true, 'output-document': true },
    directories: { 'P': true, 'directory-prefix': true },
    remote: {},
    opaqueNames: { 'r': true, 'recursive': true, 'm': true, 'mirror': true, 'p': true, 'page-requisites': true, 'x': true, 'force-directories': true, 'i': true, 'input-file': true, 'content-disposition': true, 'trust-server-names': true, 'default-page': true },
    hidden: { 'e': true, 'execute': true, 'config': true },
    movedFiles: {},
    next: {},
    urls: {},
    formats: {}
  }
}

/** The files a curl or wget call writes, as words to judge under each execution directory. A computed word stands for a path the call doesn't show. */
function downloadWrites(cmd: string, words: ShellWord[], throughXargs: boolean): ShellWord[] {
  const curl = cmd === 'curl'
  const table = curl ? DOWNLOAD_OPTIONS.curl : DOWNLOAD_OPTIONS.wget
  const targets: ShellWord[] = []
  const moved: ShellWord[] = []
  const directories: ShellWord[] = []
  const urls: ShellWord[] = []
  let remote = !curl
  let opaqueName = false
  let next = false
  let unreadable = false
  let operands = false
  const option = (name: string, value?: ShellWord) => {
    if (table.remote[name] === true) remote = true
    if (table.opaqueNames[name] === true) opaqueName = true
    if (table.hidden[name] === true) unreadable = true
    if (table.next[name] === true) next = true
    if (value === undefined) return
    if (!curl && table.stdout[name] === true) remote = false
    if (table.directories[name] === true) {
      if (value.dynamic) unreadable = true
      else directories.push(value)
    }
    if (table.urls[name] === true) urls.push(value)
    if (table.formats[name] === true && !value.dynamic && value.text.includes('%output{')) unreadable = true
    if (table.files[name] === true) {
      if (!value.dynamic && value.text === '-' && table.stdout[name] === true) return
      if (table.movedFiles[name] === true) {
        if (/#\d/.test(value.text)) unreadable = true
        moved.push(value)
      } else targets.push(value)
    }
  }
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!
    const text = word.text
    if (operands || !text.startsWith('-')) {
      urls.push(word)
      continue
    }
    if (text === '--') {
      operands = true
      continue
    }
    if (text === '-') continue
    if (text.startsWith('--')) {
      const equals = curl ? -1 : text.indexOf('=')
      const name = text.slice(2, equals < 0 ? undefined : equals)
      if (table.longValues[name] === true) {
        const value = equals < 0 ? words[++i] : { text: text.slice(equals + 1), dynamic: word.dynamic, subs: word.subs }
        if (value === undefined) unreadable = true
        else option(name, value)
      } else if (equals < 0 && (table.longFlags[name] === true || (curl && name.startsWith('no-') && table.longFlags[name.slice(3)] === true))) {
        option(name)
      } else unreadable = true
      continue
    }
    for (let j = 1; j < text.length; j++) {
      const name = text[j]!
      if (table.shortValues.includes(name)) {
        const value = j + 1 < text.length ? { text: text.slice(j + 1), dynamic: word.dynamic, subs: word.subs } : words[++i]
        if (value === undefined) unreadable = true
        else option(name, value)
        break
      }
      if (!table.shortFlags.includes(name)) {
        unreadable = true
        break
      }
      option(name)
    }
  }
  if (remote) {
    if (throughXargs || opaqueName) unreadable = true
    for (const url of urls) {
      const path = url.text.split(/[?#]/, 1)[0]!
      const name = path.slice(path.lastIndexOf('/') + 1)
      if (url.dynamic || (curl && /[{[]/.test(name))) unreadable = true
      else moved.push({ text: name, dynamic: false, subs: [] })
    }
  }
  for (const target of moved) {
    if (target.dynamic || directories.length === 0 || next) targets.push(target)
    if (!target.dynamic) {
      for (const directory of directories) targets.push({ text: `${directory.text}/${target.text}`, dynamic: false, subs: [] })
    }
  }
  if (unreadable) targets.push({ text: '', dynamic: true, subs: [] })
  return targets
}

function classifyDownload(args: string[]): ActionClass[] {
  const mutating = args.some((arg) => /^(-X|--request|-d|--data.*|-F|--form|-T|--upload-file|--json)$/.test(arg) || /^--(post|method)/.test(arg))
  const messaging = args.some((arg) => /hooks\.slack\.com|slack\.com\/api\/chat\./.test(arg))
  if (messaging && mutating) return ['message-people']
  return mutating ? ['other'] : ['network-read']
}

const longOptionIs = (arg: string, ...words: string[]) => {
  if (!arg.startsWith('--')) return false
  const name = arg.slice(2).split('=')[0]
  return name !== '' && words.some((word) => word.startsWith(name))
}
const shortClusterHas = (arg: string, letters: string) => new RegExp(`^-[a-zA-Z0-9]*[${letters}]`).test(arg)

/** awk programs can run commands (`system`, pipes, `getline`) and write files (`print >`), so only a plain inline program counts as a read. */
function awkIsReadOnly(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') return !AWK_UNSAFE_PROGRAM.test(args[i + 1] ?? '')
    if (arg === '-F' || arg === '-v') {
      i++
      continue
    }
    if (/^-[Fv]./.test(arg)) continue
    if (isFlag(arg)) return false
    return !AWK_UNSAFE_PROGRAM.test(arg)
  }
  return false
}
const AWK_UNSAFE_PROGRAM = /system|getline|[|>@]/

/**
 * Scans a sed script and returns false for anything that can execute or write: the `e`, `w` and
 * `W` commands and the `e` and `w` flags of `s`. Unknown syntax counts as unsafe.
 */
function sedScriptIsReadOnly(script: string): boolean {
  const skipDelimited = (from: number, delim: string): number => {
    for (let i = from; i < script.length; i++) {
      if (script[i] === '\\') i++
      else if (script[i] === delim) return i + 1
    }
    return -1
  }
  const skipLine = (from: number): number => {
    const end = script.indexOf('\n', from)
    return end < 0 ? script.length : end
  }
  let i = 0
  while (i < script.length) {
    const c = script[i]
    if (/[\s;{}!0-9$,~+IM]/.test(c)) i++
    else if (c === '/' || c === '\\') {
      const delim = c === '/' ? '/' : script[i + 1]
      if (delim === undefined) return false
      const next = skipDelimited(c === '/' ? i + 1 : i + 2, delim)
      if (next < 0) return false
      i = next
    } else if (c === 's' || c === 'y') {
      const delim = script[i + 1]
      if (delim === undefined || /[\s\\\n]/.test(delim)) return false
      const afterRegex = skipDelimited(i + 2, delim)
      const afterReplacement = afterRegex < 0 ? -1 : skipDelimited(afterRegex, delim)
      if (afterReplacement < 0) return false
      i = afterReplacement
      if (c === 's') {
        const flags = /^[a-zA-Z0-9]*/.exec(script.slice(i))?.[0] ?? ''
        if (/[ew]/.test(flags)) return false
        i += flags.length
      }
    } else if ('pdDnNgGhHxlqQ=zFP'.includes(c)) i++
    else if ('aicrR'.includes(c)) i = skipLine(i + 1)
    else if (c === ':' || c === 'b' || c === 't' || c === 'T') {
      const stop = /[;\n]/.exec(script.slice(i + 1))
      i = stop === null ? script.length : i + 1 + stop.index
    } else return false
  }
  return true
}

function sedIsReadOnly(args: string[]): boolean {
  const scripts: string[] = []
  const operands: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') {
      for (let j = i + 1; j < args.length; j++) operands.push(args[j])
      break
    }
    if (arg.startsWith('--')) {
      const [name, value] = [arg.slice(2).split('=')[0], arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : undefined]
      if (name === 'expression') scripts.push(value ?? args[++i] ?? '')
      else if (!['quiet', 'silent', 'regexp-extended', 'separate', 'unbuffered', 'null-data', 'posix', 'debug', 'sandbox'].includes(name)) return false
    } else if (isFlag(arg)) {
      for (let j = 1; j < arg.length; j++) {
        const letter = arg[j]
        if (letter === 'e') {
          scripts.push(arg.slice(j + 1) || (args[++i] ?? ''))
          break
        }
        if (!'nErsuzb'.includes(letter)) return false
      }
    } else operands.push(arg)
  }
  if (scripts.length === 0) {
    const [script] = operands
    if (script === undefined) return false
    scripts.push(script)
  }
  return scripts.every(sedScriptIsReadOnly)
}

const READ_INVOCATION_GUARDS: Record<string, (args: string[]) => boolean> = {
  sort: (args) => !args.some((arg) => shortClusterHas(arg, 'o') && !arg.startsWith('--') || longOptionIs(arg, 'output', 'compress-program')),
  uniq: (args) => positionals(args, new Set(['-f', '-s', '-w', '--skip-fields', '--skip-chars', '--check-chars'])).length <= 1,
  tree: (args) => !args.some((arg) => (shortClusterHas(arg, 'o') && !arg.startsWith('--')) || longOptionIs(arg, 'output')),
  yq: (args) => !args.some((arg) => (shortClusterHas(arg, 'is') && !arg.startsWith('--')) || longOptionIs(arg, 'inplace', 'split-exp') || arg.includes('system')),
  file: (args) => !args.some((arg) => (shortClusterHas(arg, 'C') && !arg.startsWith('--')) || longOptionIs(arg, 'compile')),
  diff: (args) => !args.some((arg) => (shortClusterHas(arg, 'l') && !arg.startsWith('--')) || longOptionIs(arg, 'paginate')),
  rg: (args) => !args.some((arg) => /^--(pre|hostname-bin)(=|$)/.test(arg)),
  ag: (args) => !args.some((arg) => longOptionIs(arg, 'pager')),
  date: (args) => !args.some((arg) => /^-[ur]*s/.test(arg) || longOptionIs(arg, 'set')),
  xxd: (args) => positionals(args, new Set(['-c', '-g', '-l', '-s', '-o', '-n', '-b'])).length <= 1
}

/**
 * True when this invocation of a read-only command cannot run another program or write a file.
 * False sends the call to judgment as `other`.
 */
function readInvocationIsSafe(cmd: string, args: string[]): boolean {
  return READ_INVOCATION_GUARDS[cmd]?.(args) ?? true
}

function writeTargets(parsed: Parsed): ShellWord[] {
  const { cmd, args, argWords } = parsed
  const operands = positionalWords(argWords)
  if (cmd === 'sed' || cmd === 'perl') {
    const inPlaceIndex = args.findIndex((arg) => /^-[a-zA-Z]*i/.test(arg) || arg === '--in-place')
    if (inPlaceIndex < 0) return []
    if (args[inPlaceIndex + 1] === '' && operands[0]?.text === '') operands.shift()
    return operands.slice(1)
  }
  if (WRITE_SKIP_FIRST_CMDS.has(cmd)) return operands.slice(1)
  if (WRITE_ALL_CMDS.has(cmd)) return operands
  if (WRITE_DEST_CMDS.has(cmd)) {
    const targetFlag = args.findIndex((arg) => arg === '-t' || arg === '--target-directory')
    if (targetFlag >= 0 && argWords[targetFlag + 1] !== undefined) return [argWords[targetFlag + 1]]
    const target = operands[operands.length - 1]
    return target === undefined ? [] : [target]
  }
  return []
}

function isWriteCommand(cmd: string, args: string[]): boolean {
  if (cmd === 'sed' || cmd === 'perl') return args.some((arg) => /^-[a-zA-Z]*i/.test(arg) || arg === '--in-place')
  return WRITE_ALL_CMDS.has(cmd) || WRITE_SKIP_FIRST_CMDS.has(cmd) || WRITE_DEST_CMDS.has(cmd)
}
type Analysis = {
  classes: ActionClass[]
  parts: string[]
  pushDests: string[]
  unreadable?: boolean
  directories?: DirectoryState
  cwdChanged?: boolean
  env?: Map<string, ShellWord>
  envChanges?: Set<string>
  nonDirectoryRead?: boolean
}

/** A tracked assignment cannot clear uncertainty introduced by an unfollowed search-path reference. */
const UNKNOWN_SEARCH_PATH: ShellWord = { text: '', dynamic: true, subs: [] }
const SEARCH_PATH_NAME = /cdpath|\$\{![^}]*=|@P\}/i

function namesSearchPath(command: ShellCommand, cmd: string, commandIndex: number, wrapperAssignments: readonly WordAssignment[]): boolean {
  for (const assignment of command.assignments) {
    if (assignment.name === 'CDPATH') continue
    if (SEARCH_PATH_NAME.test(assignment.name) || SEARCH_PATH_NAME.test(assignment.value.text)) return true
  }
  for (let index = 0; index < command.words.length; index++) {
    const word = command.words[index]
    if (word.text.startsWith('CDPATH=') &&
      ((cmd === 'export' && index > commandIndex) || wrapperAssignments.some((assignment) => assignment.word === word))) continue
    if (SEARCH_PATH_NAME.test(word.text)) return true
  }
  for (const redirect of command.redirects) {
    if ((redirect.kind !== 'heredoc' || redirect.target.dynamic) && SEARCH_PATH_NAME.test(redirect.target.text)) return true
  }
  return false
}

const DECLARATION_SETTERS: Record<string, true> = {
  declare: true, typeset: true, local: true, readonly: true, export: true, private: true
}
const NAME_SETTERS: Record<string, true> = {
  read: true, readarray: true, mapfile: true, getopts: true, getln: true, vared: true,
  compgen: true, zstyle: true, zformat: true, zparseopts: true, zregexparse: true
}
const DECLARATION_PREFIX_KEYWORDS: Record<string, true> = {
  '{': true, '!': true, if: true, then: true, else: true, elif: true, while: true,
  until: true, do: true, time: true
}
const PLAIN_WORD = /^[A-Za-z0-9_+:-]*$/
const NAMED_VALUE = /^[A-Za-z_][A-Za-z0-9_]*(?:\+=|=)/
const READABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const DECLARATION_NAME_FLAG = /^[+-][A-Za-z]*n[A-Za-z]*$/
const OPERAND_START = /^[A-Za-z0-9_%\\\/.,:=#'" ]/


function isReadableName(word: ShellWord | undefined): boolean {
  return word !== undefined && !word.dynamic && READABLE_NAME.test(word.text)
}

function hasOperandStart(word: ShellWord): boolean {
  return word.text === '' || OPERAND_START.test(word.text)
}

function setsUnreadName(command: ShellCommand, commandIndex: number): boolean {
  const words = command.words
  const commandWord = words[commandIndex]
  if (commandWord !== undefined) {
    if (commandWord.dynamic) return true
    const text = commandWord.text
    if (text !== '[' && text !== '[[' && !text.includes('/') &&
      (text.includes('$') || text.includes('*') || text.includes('?') || text.includes('['))) return true
  }

  let commandPrefixEnd = 0
  if (command.assignments.length === 0) {
    while (commandPrefixEnd < words.length) {
      const prefix = words[commandPrefixEnd]
      if (prefix.dynamic || DECLARATION_PREFIX_KEYWORDS[prefix.text] !== true) break
      commandPrefixEnd++
    }
  }

  let hasNonPlainAfter = false
  let hasInvalidDeclarationAfter = false
  let hasComputedAfter = false
  let hasNamerefFlagAfter = false
  let printfUnknownFromNext = false
  let printfUnknownFromTwoAhead = false
  let printUnknownFromNext = false
  let setUnknownFromNext = false

  for (let index = words.length - 1; index >= 0; index--) {
    const word = words[index]
    const text = word.text
    const plain = !word.dynamic && PLAIN_WORD.test(text)
    const flag = plain && text.length > 1 && (text[0] === '-' || text[0] === '+')
    const terminator = !word.dynamic && (text === '--' || text === '-')
    const nextWord = words[index + 1]

    if (!word.dynamic) {
      if (DECLARATION_SETTERS[text] === true &&
        (hasInvalidDeclarationAfter || hasNamerefFlagAfter ||
          (hasComputedAfter && !(command.assignments.length === 0 && index === commandPrefixEnd)))) return true
      if (NAME_SETTERS[text] === true && hasNonPlainAfter) return true
      if (text === 'printf' && printfUnknownFromNext) return true
      if (text === 'print' && printUnknownFromNext) return true
      if (text === 'set' && setUnknownFromNext) return true
      if (text === 'eval' && index !== commandIndex) return true
      if (text === 'zmodload') return true
    }

    const currentPrintfUnknown: boolean = terminator ? false :
      plain && text === '-v'
        ? nextWord === undefined ? false : isReadableName(nextWord) ? printfUnknownFromTwoAhead : true
        : plain && text.startsWith('-v') && text.length > 2
          ? printfUnknownFromNext
          : !hasOperandStart(word)
    const currentPrintUnknown: boolean = terminator ? false :
      printUnknownFromNext || (flag
        ? text.endsWith('v') && nextWord !== undefined && !isReadableName(nextWord)
        : !hasOperandStart(word))
    const currentSetUnknown: boolean = terminator ? false :
      setUnknownFromNext || (flag
        ? text.endsWith('A') && nextWord !== undefined && !isReadableName(nextWord)
        : !hasOperandStart(word))

    printfUnknownFromTwoAhead = printfUnknownFromNext
    printfUnknownFromNext = currentPrintfUnknown
    printUnknownFromNext = currentPrintUnknown
    setUnknownFromNext = currentSetUnknown
    if (word.dynamic) hasComputedAfter = true
    if (!plain) hasNonPlainAfter = true
    if (!plain && !NAMED_VALUE.test(text)) hasInvalidDeclarationAfter = true
    if (plain && DECLARATION_NAME_FLAG.test(text)) hasNamerefFlagAfter = true
  }
  return false
}


function setTrackedValue(env: Map<string, ShellWord>, name: string, value: ShellWord): void {
  if (name === 'CDPATH' && env.get(name) === UNKNOWN_SEARCH_PATH) return
  env.set(name, value)
}

function unknownGitValue(value: ShellWord): ShellWord {
  return value.dynamic ? value : { text: value.text, dynamic: true, subs: value.subs }
}

function commandEnvironment(parsed: Parsed, inherited: Map<string, ShellWord>): Map<string, ShellWord> {
  const env = new Map(inherited)
  for (const assignment of parsed.assignments) {
    if (TRACKED_ENV_NAMES[assignment.name] === true) setTrackedValue(env, assignment.name, assignment.value)
  }
  for (const assignment of parsed.wrapperAssignments) {
    setTrackedValue(env, assignment.name, assignment.value)
  }
  return env
}

function analyzeCommand(command: string, startDirectories: DirectorySet, ctx: ClassifyContext, depth = 0, inheritedEnv: Map<string, ShellWord> = new Map()): Analysis {
  if (depth > 4) return { classes: ['other', 'edit-outside'], parts: [], pushDests: [], unreadable: true }
  const script = parseShell(command, { home: ctx.home })
  if (script === null) return { classes: ['other', 'edit-outside'], parts: [], pushDests: [], unreadable: true }
  const rootPaths = roots(ctx)

  const scopeDownloads = new Array(script.parents.length).fill(false) as boolean[]
  const scopeCommands = new Map<number, ShellCommand>()
  const recordScopes = (word: ShellWord, owner: ShellCommand) => {
    for (const scope of word.subs) scopeCommands.set(scope, owner)
  }
  for (const shellCommand of script.commands) {
    const unwrapped = unwrapWords(shellCommand.words)
    const word = unwrapped.unknownWrapperFlag ? undefined : shellCommand.words[unwrapped.commandIndex]
    if (word !== undefined && !word.dynamic && DOWNLOAD_CMDS.has(basename(word.text))) scopeDownloads[shellCommand.scope] = true
    for (const word of shellCommand.words) recordScopes(word, shellCommand)
    for (const assignment of shellCommand.assignments) recordScopes(assignment.value, shellCommand)
    for (const redirect of shellCommand.redirects) recordScopes(redirect.target, shellCommand)
  }
  for (let scope = scopeDownloads.length - 1; scope > 0; scope--) {
    if (scopeDownloads[scope]) scopeDownloads[script.parents[scope]] = true
  }

  const classes: ActionClass[] = []
  const parts: string[] = []
  const pushDests: string[] = []
  const envChanges = new Set<string>()
  let cwdChanged = false
  let nonDirectoryRead = false
  const environments = new Map<number, Map<string, ShellWord>>([[0, new Map(inheritedEnv)]])
  const environmentFor = (scope: number): Map<string, ShellWord> => {
    const existing = environments.get(scope)
    if (existing !== undefined) return existing
    const env = new Map(environmentFor(script.parents[scope]))
    environments.set(scope, env)
    return env
  }
  const pipelineDownloads = new Map<number, boolean>()
  const directories = new Map<number, DirectoryState>([[0, { possible: startDirectories, certain: startDirectories }]])
  const directoryFor = (scope: number): DirectoryState => {
    const existing = directories.get(scope)
    if (existing !== undefined) return existing
    const parent = directoryFor(script.parents[scope])
    const owner = scopeCommands.get(scope)
    if (owner === undefined) parent.certain = parent.possible
    const start = owner?.sep === '&&' ? parent.certain : parent.possible
    const state = { possible: start, certain: start }
    directories.set(scope, state)
    return state
  }
  for (const shellCommand of script.commands) {
    const shellEnv = environmentFor(shellCommand.scope)
    const state = directoryFor(shellCommand.scope)
    const commandCwd = shellCommand.sep === '&&' ? state.certain : state.possible
    const previousCertain = state.certain
    let cwd = commandCwd
    let possible = state.possible
    let downloadInPipeline = pipelineDownloads.get(shellCommand.scope) ?? false
    if (shellCommand.sep !== '|') downloadInPipeline = false

    const parsed = parseSegment(shellCommand, commandCwd, ctx)
    const { cmd, args } = parsed
    if (!parsed.dynamicCommand && DOWNLOAD_CMDS.has(cmd)) {
      for (const target of downloadWrites(cmd, parsed.argWords, parsed.throughXargs)) parsed.wrapperWrites.push({ target, cwd: parsed.execCwd })
    }
    const commandIndex = parsed.commandIndex
    if (namesSearchPath(shellCommand, cmd, commandIndex, parsed.wrapperAssignments) ||
      setsUnreadName(shellCommand, commandIndex)) {
      shellEnv.set('CDPATH', UNKNOWN_SEARCH_PATH)
      if (shellCommand.scope === 0) envChanges.add('CDPATH')
    }
    if (cmd === '') {
      for (const assignment of parsed.assignments) {
        if (TRACKED_ENV_NAMES[assignment.name] !== true) continue
        setTrackedValue(shellEnv, assignment.name, shellCommand.detached ? unknownGitValue(assignment.value) : assignment.value)
        if (shellCommand.scope === 0) envChanges.add(assignment.name)
      }
      for (const assignment of parsed.wrapperAssignments) {
        setTrackedValue(shellEnv, assignment.name, shellCommand.detached ? unknownGitValue(assignment.value) : assignment.value)
        if (shellCommand.scope === 0) envChanges.add(assignment.name)
      }
    } else if (cmd === 'export') {
      for (const word of parsed.argWords) {
        const assignment = assignmentFromWord(word)
        if (assignment === null || TRACKED_ENV_NAMES[assignment.name] !== true) continue
        setTrackedValue(shellEnv, assignment.name, shellCommand.detached ? unknownGitValue(assignment.value) : assignment.value)
        if (shellCommand.scope === 0) envChanges.add(assignment.name)
      }
    }

    const partClasses: ActionClass[] = []
    const isShell = !parsed.dynamicCommand && SHELLS.has(cmd)
    const isShellConsumer = isShell || cmd === 'eval' || cmd === 'source' || cmd === '.'
    if (isShellConsumer && !parsed.dynamicCommand) {
      let nestedDownload = false
      for (const word of shellCommand.words) {
        for (const scope of word.subs) if (scopeDownloads[scope]) nestedDownload = true
      }
      for (const redirect of shellCommand.redirects) {
        for (const scope of redirect.target.subs) if (scopeDownloads[scope]) nestedDownload = true
      }
      if (nestedDownload) partClasses.push('pipe-to-shell')
    }
    if (isShell && downloadInPipeline) partClasses.push('pipe-to-shell')

    let nestedNonDirectoryRead = false
    const commandFlag = isShell ? args.findIndex((arg) => /^-[a-zA-Z]*c$/.test(arg)) : -1
    const writeTargetWords = !parsed.dynamicCommand && isWriteCommand(cmd, args) ? writeTargets(parsed) : []
    let commandAllowed: boolean | undefined
    if (parsed.credential) partClasses.push('credential')
    if (parsed.unknownWrapperFlag || parsed.subscriptBeforeCommand) {
      partClasses.push('other', 'edit-outside')
      cwd = possible = null
    } else if (parsed.dynamicCommand) {
      partClasses.push('other')
      if (!parsed.loneSubscriptAssignment) cwd = possible = null
    } else if (cmd === 'cd' || cmd === 'pushd' || cmd === 'popd') {
      let target: ShellWord | undefined
      let targetCount = 0
      let invalid = shellCommand.detached || cmd === 'popd'
      if (cmd === 'cd') {
        for (const word of parsed.argWords) {
          if (word.text === '-L' || word.text === '-P' || word.text === '--') continue
          target = word
          targetCount++
        }
        if (targetCount > 1) invalid = true
      } else if (cmd === 'pushd') {
        target = parsed.argWords[0]
        targetCount = parsed.argWords.length
        if (targetCount !== 1) invalid = true
      }
      if (target !== undefined && (target.dynamic || target.text.startsWith('-') || target.text.startsWith('+'))) invalid = true
      let cdpath = shellEnv.get('CDPATH')
      if (cdpath !== UNKNOWN_SEARCH_PATH) {
        for (const assignment of parsed.assignments) if (assignment.name === 'CDPATH') cdpath = assignment.value
        for (const assignment of parsed.wrapperAssignments) if (assignment.name === 'CDPATH') cdpath = assignment.value
      }
      if (target !== undefined && cdpath !== undefined && (cdpath.dynamic || cdpath.text !== '') &&
        !isAbsolute(expandHome(target.text, ctx.home)) && target.text !== '.' && target.text !== '..' &&
        !target.text.startsWith('./') && !target.text.startsWith('../')) invalid = true
      if (invalid) {
        cwd = possible = null
        partClasses.push('other')
      } else {
        const entered = enteredDirectories(target?.text ?? ctx.home, parsed.execCwd, ctx.home)
        cwd = parsed.wrapped ? joinDirectories(commandCwd, entered) : entered
        possible = joinDirectories(possible, cwd)
        partClasses.push('read')
      }
    } else if (isShell && commandFlag >= 0 && args[commandFlag + 1] !== undefined) {
      const body = parsed.argWords[commandFlag + 1]
      const inner = analyzeCommand(body.text, parsed.execCwd, ctx, depth + 1, commandEnvironment(parsed, shellEnv))
      if (inner.unreadable) return { classes: ['other', 'edit-outside'], parts: [], pushDests: [], unreadable: true }
      nestedNonDirectoryRead = inner.nonDirectoryRead ?? false
      append(partClasses, inner.classes)
      append(parts, inner.parts)
      append(pushDests, inner.pushDests)
    } else if (isShell) {
      if (!downloadInPipeline) partClasses.push('other')
    } else if (cmd === 'eval' && args.length > 0) {
      const dynamicEval = parsed.argWords.some((word) => word.dynamic)
      const inner = analyzeCommand(args.join(' '), parsed.execCwd, ctx, depth + 1, commandEnvironment(parsed, shellEnv))
      if (inner.unreadable) return { classes: ['other', 'edit-outside'], parts: [], pushDests: [], unreadable: true }
      nestedNonDirectoryRead = inner.nonDirectoryRead ?? false
      if (shellCommand.scope === 0 && inner.cwdChanged) cwdChanged = true
      if (shellCommand.detached) {
        if (inner.cwdChanged) {
          cwd = null
          partClasses.push('other')
        }
      } else {
        const final = inner.directories ?? { possible: null, certain: null }
        cwd = parsed.wrapped ? joinDirectories(commandCwd, final.possible) : final.certain
        possible = joinDirectories(possible, final.possible)
      }
      if (shellCommand.detached && inner.cwdChanged && !inner.nonDirectoryRead) {
        for (const actionClass of inner.classes) {
          if (actionClass !== 'read') partClasses.push(actionClass)
        }
      } else {
        append(partClasses, inner.classes)
      }
      append(parts, inner.parts)
      append(pushDests, inner.pushDests)
      if (dynamicEval) {
        partClasses.push('other')
        cwd = possible = null
        shellEnv.set('CDPATH', UNKNOWN_SEARCH_PATH)
        if (shellCommand.scope === 0) envChanges.add('CDPATH')
      } else {
        const changedNames = new Set(inner.envChanges ?? [])
        for (const assignment of parsed.assignments) {
          if (TRACKED_ENV_NAMES[assignment.name] === true) changedNames.add(assignment.name)
        }
        for (const assignment of parsed.wrapperAssignments) changedNames.add(assignment.name)
        if (shellCommand.detached) {
          for (const name of changedNames) {
            const value = inner.env?.get(name) ?? shellEnv.get(name)
            if (value !== undefined) shellEnv.set(name, unknownGitValue(value))
          }
        } else {
          for (const [name, value] of inner.env ?? []) shellEnv.set(name, value)
        }
        if (shellCommand.scope === 0) {
          for (const name of changedNames) envChanges.add(name)
        }
      }
    } else if (cmd !== '') {
      parts.push(parsed.text)
      if (cmd === 'git') {
        let first = true
        append(partClasses, directoryClasses(parsed.execCwd, (directory) => {
          const result = classifyMainCommand(parsed, ctx, directory, shellEnv, first ? pushDests : [])
          first = false
          return result
        }))
      } else {
        append(partClasses, classifyMainCommand(parsed, ctx, null, shellEnv, pushDests))
      }
    }
    let countedDynamic = parsed.dynamicBeforeCommand
    if (!countedDynamic && !parsed.dynamicCommand && cmd !== 'eval' && cmd !== 'cd' && cmd !== 'pushd' && cmd !== 'popd' &&
      !parsed.argumentExempt) {
      const bodyIndex = isShell && commandFlag >= 0 ? commandFlag + 1 : -1
      let writeTargetIndex = 0
      for (let i = 0; i < parsed.argWords.length; i++) {
        const word = parsed.argWords[i]
        const isWriteTarget = writeTargetWords[writeTargetIndex] === word
        if (isWriteTarget) writeTargetIndex++
        if (!word.dynamic || i === bodyIndex || isWriteTarget) continue
        commandAllowed ??= matchesCommandList(parsed.text, ctx.allowCommands)
        if (!commandAllowed) {
          countedDynamic = true
          break
        }
      }
    }
    if (countedDynamic) partClasses.push('other')
    if (parsed.throughXargs && cmd !== '') {
      const xargsShellBody = isShell && commandFlag >= 0
      if (isWriteCommand(cmd, args) || xargsShellBody || cmd === 'eval') partClasses.push('edit-outside')
      else if (!parsed.argumentExempt) {
        commandAllowed ??= matchesCommandList(parsed.text, ctx.allowCommands)
        if (!commandAllowed) partClasses.push('other')
      }
    }
    if (keywordChangesDirectory(shellCommand.words)) cwd = possible = null

    if (!parsed.dynamicCommand && DOWNLOAD_CMDS.has(cmd)) downloadInPipeline = true
    pipelineDownloads.set(shellCommand.scope, downloadInPipeline)

    for (const word of parsed.argWords) {
      const credentialClass = wordTouchesCredential(word, parsed.execCwd, ctx, rootPaths, true)
      if (credentialClass !== null) partClasses.push(credentialClass)
    }

    if (!parsed.dynamicCommand && isWriteCommand(cmd, args)) {
      for (const target of writeTargetWords) {
        if (target.dynamic) partClasses.push('edit-outside')
        else append(partClasses, directoryClasses(parsed.execCwd, (directory) => directory === null && !isAbsolute(expandHome(target.text, ctx.home)) ? ['edit-outside'] : writeClasses(target.text, directory ?? '/', ctx, rootPaths)))
      }
    }
    for (const { target, cwd: wrapperCwd } of parsed.wrapperWrites) {
      if (!target.dynamic && ['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty'].includes(target.text)) continue
      if (target.dynamic) {
        partClasses.push('edit-outside')
        const credentialClass = wordTouchesCredential(target, wrapperCwd, ctx, rootPaths, false)
        if (credentialClass !== null) partClasses.push(credentialClass)
      } else append(partClasses, directoryClasses(wrapperCwd, (directory) => directory === null && !isAbsolute(expandHome(target.text, ctx.home)) ? ['edit-outside'] : writeClasses(target.text, directory ?? '/', ctx, rootPaths)))
    }
    for (const { target, cwd: wrapperCwd } of parsed.wrapperReads) {
      const credentialClass = wordTouchesCredential(target, wrapperCwd, ctx, rootPaths, false)
      if (credentialClass !== null) partClasses.push(credentialClass)
    }
    for (const redirect of shellCommand.redirects) {
      const target = redirect.target
      if (redirect.kind === 'read') {
        if (target.dynamic) partClasses.push('other')
        const credentialClass = wordTouchesCredential(target, commandCwd, ctx, rootPaths, false)
        if (credentialClass !== null) partClasses.push(credentialClass)
        continue
      }
      if (redirect.kind !== 'write') continue
      if (!target.dynamic && ['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty'].includes(target.text)) continue
      if (target.dynamic) {
        partClasses.push('edit-outside')
        const credentialClass = wordTouchesCredential(target, commandCwd, ctx, rootPaths, false)
        if (credentialClass !== null) partClasses.push(credentialClass)
      } else {
        append(partClasses, directoryClasses(commandCwd, (directory) => directory === null && !isAbsolute(expandHome(target.text, ctx.home)) ? ['edit-outside'] : writeClasses(target.text, directory ?? '/', ctx, rootPaths)))
      }
    }

    if (shellCommand.detached && cmd === 'eval' && cwd === null) possible = null
    const certain = shellCommand.sep === '||' ? joinDirectories(previousCertain, cwd) : cwd
    if (shellCommand.scope === 0 && (!directoriesEqual(certain, commandCwd) || !directoriesEqual(possible, state.possible))) cwdChanged = true
    if (nestedNonDirectoryRead || (!isShell && cmd !== 'eval' && cmd !== 'cd' && cmd !== 'pushd' && cmd !== 'popd' && partClasses.includes('read'))) {
      nonDirectoryRead = true
    }
    append(classes, partClasses)
    directories.set(shellCommand.scope, { possible, certain })
  }
  return { classes, parts, pushDests, directories: directoryFor(0), cwdChanged, env: environmentFor(0), envChanges, nonDirectoryRead }
}

function classifyMainCommand(parsed: Parsed, ctx: ClassifyContext, cwd: string | null, shellEnv: Map<string, ShellWord>, pushDests: string[]): ActionClass[] {
  const { cmd, args, text } = parsed
  if (parsed.dynamicCommand) return ['other']
  const deploy = matchesCommandList(text, ctx.deployCommands) || isBuiltinDeploy(cmd, args)
  if (deploy) return ['deploy']
  let classes: ActionClass[]
  if (cmd === 'git') classes = classifyGit(parsed.argWords, commandEnvironment(parsed, shellEnv), ctx, cwd, pushDests)
  else if (cmd === 'gh' || cmd === 'glab') classes = classifyPullRequestCli(cmd, args)
  else if (DOWNLOAD_CMDS.has(cmd)) classes = classifyDownload(args)
  else if (cmd === 'security') classes = ['credential']
  else if (MESSAGE_CMDS.has(cmd)) classes = ['message-people']
  else if (PACKAGE_MANAGERS.has(cmd)) classes = classifyPackageManager(cmd, args)
  else if (cmd === 'bunx' || cmd === 'npx') classes = classifyTool(positionals(args)[0], args.slice(1))
  else if (cmd === 'make') classes = testOrBuild(scriptClass(positionals(args)[0]), args)
  else if (cmd === 'cargo' || cmd === 'go') classes = classifyCargoOrGo(args)
  else if (cmd === 'python' || cmd === 'python3') classes = args[0] === '-m' && (args[1] === 'pytest' || args[1] === 'unittest') ? testOrBuild('test', args) : ['other']
  else if (cmd === 'find') classes = args.some((arg) => FIND_UNSAFE_PRIMARY.test(arg)) ? ['other'] : ['read']
  else if (AWK_CMDS.has(cmd)) classes = awkIsReadOnly(args) ? ['read'] : ['other']
  else if (cmd === 'sed' && !isWriteCommand(cmd, args)) classes = sedIsReadOnly(args) ? ['read'] : ['other']
  else if (READ_CMDS.has(cmd)) classes = readInvocationIsSafe(cmd, args) ? ['read'] : ['other']
  else if (isWriteCommand(cmd, args)) classes = []
  else classes = classifyTool(cmd, args)
  if (classes.length === 1 && classes[0] === 'other' && matchesCommandList(text, ctx.allowCommands)) return ['build']
  return classes
}

function classifyCargoOrGo(args: string[]): ActionClass[] {
  const sub = positionals(args)[0]
  if (sub === 'test') return testOrBuild('test', args)
  if (sub !== undefined && ['build', 'check', 'vet', 'clippy', 'fmt', 'doc'].includes(sub)) return ['build']
  return ['other']
}

function shellCommandOf(input: unknown): { command: string; cwd: string | null } | null {
  if (typeof input === 'string') return { command: input, cwd: null }
  if (typeof input !== 'object' || input === null) return null
  const record = input as Record<string, unknown>
  const raw = record.command ?? record.cmd
  const cwd = typeof record.workdir === 'string' ? record.workdir : typeof record.cwd === 'string' ? record.cwd : null
  if (typeof raw === 'string') return { command: raw, cwd }
  if (Array.isArray(raw) && raw.every((item) => typeof item === 'string')) {
    const argv = raw as string[]
    if (argv.length >= 3 && SHELLS.has(basename(argv[0])) && /^-[a-zA-Z]*c$/.test(argv[1])) return { command: argv[2], cwd }
    return { command: argv.map((arg) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`)).join(' '), cwd }
  }
  return null
}

function pathOf(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return null
  const record = input as Record<string, unknown>
  for (const key of PATH_KEYS) if (typeof record[key] === 'string' && record[key] !== '') return record[key] as string
  return null
}

function patchPaths(input: unknown): string[] {
  let text: string | null = null
  if (typeof input === 'string') text = input
  else if (typeof input === 'object' && input !== null) {
    const record = input as Record<string, unknown>
    const candidate = record.input ?? record.patch ?? record.command
    text = typeof candidate === 'string' ? candidate : Array.isArray(candidate) ? candidate.filter((item) => typeof item === 'string').join('\n') : null
  }
  if (text === null) return []
  return Array.from(text.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm), (match) => match[1].trim())
}

function analyzeCall(call: ToolCall, ctx: ClassifyContext): Analysis {
  const tool = call.toolName.toLowerCase()
  if (SHELL_TOOLS.has(tool)) {
    const shell = shellCommandOf(call.toolInput)
    if (shell === null || shell.command.trim() === '') return { classes: ['other'], parts: [], pushDests: [] }
    return analyzeCommand(shell.command, [shell.cwd ?? call.cwd], ctx)
  }
  if (tool === 'apply_patch') {
    const paths = patchPaths(call.toolInput)
    if (paths.length === 0) return { classes: ['other'], parts: [], pushDests: [] }
    return { classes: paths.flatMap((path) => writeClasses(path, call.cwd, ctx)), parts: [], pushDests: [] }
  }
  if (READ_TOOLS.has(tool)) {
    const path = pathOf(call.toolInput)
    return { classes: path === null ? ['read'] : readClasses(resolvePath(path, call.cwd, ctx.home), ctx), parts: [], pushDests: [] }
  }
  if (WRITE_TOOLS.has(tool)) {
    const path = pathOf(call.toolInput)
    return { classes: path === null ? ['other'] : writeClasses(path, call.cwd, ctx), parts: [], pushDests: [] }
  }
  if (NETWORK_TOOLS.has(tool)) return { classes: ['network-read'], parts: [], pushDests: [] }
  return { classes: ['other'], parts: [], pushDests: [] }
}

/**
 * Maps a tool call onto the action classes the gate decides on.
 *
 * Unreadable shell text and unknown wrapper options return `other` and `edit-outside`.
 * Computed words that no other rule accounts for add `other`; ordinary `xargs` commands
 * add `other` unless exempt, while write and shell `-c`/`eval` commands add `edit-outside`.
 * A computed command word or an array element assignment before a command leaves
 * the shell directory unknown; the latter also returns `other` and `edit-outside`.
 * A computed argument or redirect word whose non-empty fixed prefix resolves
 * under an active directory to a credential path adds `credential`; brace expansion
 * cut off by the 64-word or 32-depth limit without proving it adds `edit-outside`.
 * Path patterns in words or fixed prefixes add `credential` if any reading can name a credential path.
 * More than 16 dot-directory readings adds `edit-outside` unless another path text proves `credential`.
 * A relative write target with an unknown cwd returns `edit-outside`.
 * A file a `curl` or `wget` call writes is a write target; an unreadable written path returns `edit-outside`.
 * Paths are judged under every possible shell directory; a write is inside only
 * when it is inside under each. A `cd` is certain only through its `&&` list.
 * Never returns an empty list: `['other']` means nothing matched. A compound Bash
 * command yields the union of every part's classes, so one risky part is never
 * hidden by a safe one. File tools classify by their path resolved against
 * `call.cwd` and the handed-off paths. Never throws.
 */
export function classifyCall(call: ToolCall, ctx: ClassifyContext): ActionClass[] {
  try {
    const classes = unique(analyzeCall(call, ctx).classes)
    return classes.length > 0 ? classes : ['other']
  } catch {
    return ['other']
  }
}

/**
 * The normalized text of each command a Bash-style call runs, with wrappers like
 * `sudo` and `env` stripped and `bash -c` bodies expanded. Empty for file tools.
 * Segments with unknown wrapper options are omitted rather than inventing a command.
 */
export function commandParts(call: ToolCall, ctx: ClassifyContext): string[] {
  try {
    return analyzeCall(call, ctx).parts
  } catch {
    return []
  }
}

/**
 * The destination branch of every `git push` a Bash-style call runs, `HEAD` and an empty
 * destination resolved to `ctx.ownBranch`. Empty for any other call.
 */
export function pushDestinations(call: ToolCall, ctx: ClassifyContext): string[] {
  try {
    return analyzeCall(call, ctx).pushDests
  } catch {
    return []
  }
}
