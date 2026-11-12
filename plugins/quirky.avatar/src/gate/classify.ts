import { basename, isAbsolute, resolve, sep } from 'node:path'
import type { ActionClass, ClassifyContext, ToolCall } from '../contracts'
import { parseShell, type ShellCommand, type ShellWord } from './shell'

type ShellAssignment = ShellCommand['assignments'][number]
type Parsed = {
  cmd: string
  args: string[]
  argWords: ShellWord[]
  text: string
  assignments: readonly ShellAssignment[]
  wrapperAssignments: ShellAssignment[]
  credential: boolean
  throughXargs: boolean
  dynamicCommand: boolean
  dynamicBeforeCommand: boolean
}

const READ_TOOLS = new Set(['read', 'notebookread', 'view', 'glob', 'grep', 'ls', 'find', 'todowrite', 'taskcreate', 'taskget', 'taskupdate', 'tasklist', 'taskoutput', 'enterplanmode', 'exitplanmode'])
const WRITE_TOOLS = new Set(['edit', 'write', 'multiedit', 'notebookedit', 'str_replace_editor', 'create'])
const NETWORK_TOOLS = new Set(['webfetch', 'websearch'])
const SHELL_TOOLS = new Set(['bash', 'shell', 'local_shell', 'exec_command', 'container.exec', 'run_shell_command'])
const PATH_KEYS = ['file_path', 'path', 'notebook_path', 'filePath', 'file']

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish'])
const WRAPPERS = new Set(['sudo', 'doas', 'nohup', 'time', 'command', 'exec', 'builtin', 'nice', 'ionice', 'stdbuf', 'xargs', 'env', 'timeout'])
const NO_ARGUMENT_EFFECT_CMDS: Record<string, true> = { echo: true, printf: true, true: true, false: true, test: true, '[': true, basename: true, dirname: true, sleep: true }
const WRAPPER_VALUE_FLAGS: Partial<Record<string, Readonly<Record<string, true>>>> = {
  sudo: { '-u': true, '-g': true, '-h': true, '-p': true, '-C': true, '-T': true, '-R': true, '-D': true, '-r': true, '-t': true, '--user': true, '--group': true, '--host': true, '--prompt': true, '--close-from': true, '--command-timeout': true, '--chroot': true, '--chdir': true, '--role': true, '--type': true },
  doas: { '-u': true, '-C': true },
  xargs: { '-I': true, '-L': true, '-P': true, '-n': true, '-s': true, '-E': true }
}
const READ_CMDS = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'pwd', 'echo', 'printf', 'which', 'whereis', 'type', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'sort', 'uniq', 'cut', 'tr', 'diff', 'cmp', 'stat', 'file', 'tree', 'jq', 'yq', 'basename', 'dirname', 'realpath', 'readlink', 'true', 'false', 'test', '[', 'date', 'whoami', 'uname', 'id', 'column', 'fmt', 'nl', 'tac', 'od', 'xxd', 'hexdump', 'md5sum', 'shasum', 'sha256sum', 'du', 'df', 'cd', 'pushd', 'popd', 'sleep', 'ps', 'lsof'])
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
const GIT_ENV_NAMES = new Set(['GIT_DIR', 'GIT_WORK_TREE', 'HUSKY', 'HUSKY_SKIP_HOOKS', 'SKIP_HOOKS'])

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

type UnwrappedWords = { commandIndex: number; credential: boolean; throughXargs: boolean; dynamicBeforeCommand: boolean }


function assignmentFromWord(word: ShellWord): ShellAssignment | null {
  const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(word.text)
  if (assignment === null) return null
  return {
    name: assignment[1],
    value: { text: assignment[2], dynamic: word.dynamic || /^~[^/]/.test(assignment[2]), subs: word.subs }
  }
}

function unwrapWords(words: ShellWord[], wrapperAssignments?: ShellAssignment[]): UnwrappedWords {
  let commandIndex = 0
  let credential = false
  let throughXargs = false
  let dynamicBeforeCommand = false
  while (commandIndex < words.length) {
    const word = words[commandIndex]
    if (word.dynamic) break
    const wrapper = basename(word.text)
    if (!WRAPPERS.has(wrapper)) break
    if (wrapper === 'sudo' || wrapper === 'doas') credential = true
    if (wrapper === 'xargs') throughXargs = true
    commandIndex++
    while (commandIndex < words.length) {
      const option = words[commandIndex]
      const assignment = wrapper === 'env' ? assignmentFromWord(option) : null
      if (assignment === null && (option.dynamic || !isFlag(option.text))) break
      if (assignment !== null && GIT_ENV_NAMES.has(assignment.name)) wrapperAssignments?.push(assignment)
      const takesValue = WRAPPER_VALUE_FLAGS[wrapper]?.[option.text] === true
      if (takesValue && words[commandIndex + 1]?.dynamic) dynamicBeforeCommand = true
      commandIndex += takesValue ? 2 : 1
    }
    if (wrapper === 'timeout' && commandIndex < words.length) {
      if (words[commandIndex].dynamic) dynamicBeforeCommand = true
      commandIndex++
    }
  }
  return { commandIndex, credential, throughXargs, dynamicBeforeCommand }
}

function parseSegment(command: ShellCommand): Parsed {
  const wrapperAssignments: ShellAssignment[] = []
  const unwrapped = unwrapWords(command.words, wrapperAssignments)
  const commandWord = command.words[unwrapped.commandIndex]
  const argWords = commandWord === undefined ? [] : command.words.slice(unwrapped.commandIndex + 1)
  const args: string[] = []
  for (const word of argWords) args.push(word.text)
  const text = commandWord === undefined ? '' : commandWord.text + (args.length === 0 ? '' : ` ${args.join(' ')}`)
  return {
    cmd: commandWord === undefined ? '' : basename(commandWord.text),
    args,
    argWords,
    text,
    assignments: command.assignments,
    wrapperAssignments,
    credential: unwrapped.credential,
    throughXargs: unwrapped.throughXargs,
    dynamicCommand: commandWord?.dynamic ?? false,
    dynamicBeforeCommand: unwrapped.dynamicBeforeCommand
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
  cwd?: string | null
  cwdChanged?: boolean
  env?: Map<string, ShellWord>
  envChanges?: Set<string>
  nonDirectoryRead?: boolean
}

function unknownGitValue(value: ShellWord): ShellWord {
  return value.dynamic ? value : { text: value.text, dynamic: true, subs: value.subs }
}

function commandEnvironment(parsed: Parsed, inherited: Map<string, ShellWord>): Map<string, ShellWord> {
  const env = new Map(inherited)
  for (const assignment of parsed.assignments) {
    if (GIT_ENV_NAMES.has(assignment.name)) env.set(assignment.name, assignment.value)
  }
  for (const assignment of parsed.wrapperAssignments) {
    env.set(assignment.name, assignment.value)
  }
  return env
}

function analyzeCommand(command: string, startCwd: string | null, ctx: ClassifyContext, depth = 0, inheritedEnv: Map<string, ShellWord> = new Map()): Analysis {
  if (depth > 4) return { classes: ['other', 'edit-outside'], parts: [], pushDests: [], unreadable: true }
  const script = parseShell(command, { home: ctx.home })
  if (script === null) return { classes: ['other', 'edit-outside'], parts: [], pushDests: [], unreadable: true }
  const rootPaths = roots(ctx)

  const scopeDownloads = new Array(script.parents.length).fill(false) as boolean[]
  for (const shellCommand of script.commands) {
    const commandIndex = unwrapWords(shellCommand.words).commandIndex
    const word = shellCommand.words[commandIndex]
    if (word !== undefined && !word.dynamic && DOWNLOAD_CMDS.has(basename(word.text))) scopeDownloads[shellCommand.scope] = true
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
  const directories = new Map<number, string | null>([[0, startCwd]])
  const directoryFor = (scope: number): string | null => {
    if (directories.has(scope)) return directories.get(scope)!
    const directory = directoryFor(script.parents[scope])
    directories.set(scope, directory)
    return directory
  }
  for (const shellCommand of script.commands) {
    const shellEnv = environmentFor(shellCommand.scope)
    const commandCwd = directoryFor(shellCommand.scope)
    let cwd = commandCwd
    let downloadInPipeline = pipelineDownloads.get(shellCommand.scope) ?? false
    if (shellCommand.sep !== '|') downloadInPipeline = false

    const parsed = parseSegment(shellCommand)
    const { cmd, args } = parsed
    if (cmd === '') {
      for (const assignment of parsed.assignments) {
        if (!GIT_ENV_NAMES.has(assignment.name)) continue
        shellEnv.set(assignment.name, shellCommand.detached ? unknownGitValue(assignment.value) : assignment.value)
        if (shellCommand.scope === 0) envChanges.add(assignment.name)
      }
      for (const assignment of parsed.wrapperAssignments) {
        shellEnv.set(assignment.name, shellCommand.detached ? unknownGitValue(assignment.value) : assignment.value)
        if (shellCommand.scope === 0) envChanges.add(assignment.name)
      }
    } else if (cmd === 'export') {
      for (const word of parsed.argWords) {
        const assignment = assignmentFromWord(word)
        if (assignment === null || !GIT_ENV_NAMES.has(assignment.name)) continue
        shellEnv.set(assignment.name, shellCommand.detached ? unknownGitValue(assignment.value) : assignment.value)
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
    if (parsed.dynamicCommand) {
      partClasses.push('other')
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
      if (invalid) {
        cwd = null
        partClasses.push('other')
      } else if (cmd === 'cd' && target === undefined) {
        cwd = resolve(ctx.home)
        partClasses.push('read')
      } else {
        const expanded = expandHome(target!.text, ctx.home)
        if (cwd !== null || isAbsolute(expanded)) cwd = resolvePath(target!.text, cwd ?? '/', ctx.home)
        partClasses.push('read')
      }
    } else if (isShell && commandFlag >= 0 && args[commandFlag + 1] !== undefined) {
      const body = parsed.argWords[commandFlag + 1]
      const inner = analyzeCommand(body.text, cwd, ctx, depth + 1, commandEnvironment(parsed, shellEnv))
      if (inner.unreadable) return { classes: ['other', 'edit-outside'], parts: [], pushDests: [], unreadable: true }
      nestedNonDirectoryRead = inner.nonDirectoryRead ?? false
      append(partClasses, inner.classes)
      append(parts, inner.parts)
      append(pushDests, inner.pushDests)
    } else if (isShell) {
      if (!downloadInPipeline) partClasses.push('other')
    } else if (cmd === 'eval' && args.length > 0) {
      const dynamicEval = parsed.argWords.some((word) => word.dynamic)
      const inner = analyzeCommand(args.join(' '), cwd, ctx, depth + 1, commandEnvironment(parsed, shellEnv))
      if (inner.unreadable) return { classes: ['other', 'edit-outside'], parts: [], pushDests: [], unreadable: true }
      nestedNonDirectoryRead = inner.nonDirectoryRead ?? false
      if (!dynamicEval && shellCommand.scope === 0 && inner.cwdChanged) cwdChanged = true
      if (shellCommand.detached && !dynamicEval) {
        if (inner.cwdChanged) {
          cwd = null
          partClasses.push('other')
        }
      } else if (!dynamicEval) {
        cwd = inner.cwd === undefined ? null : inner.cwd
      }
      if (shellCommand.detached && !dynamicEval && inner.cwdChanged && !inner.nonDirectoryRead) {
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
      } else {
        const changedNames = new Set(inner.envChanges ?? [])
        for (const assignment of parsed.assignments) {
          if (GIT_ENV_NAMES.has(assignment.name)) changedNames.add(assignment.name)
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
      append(partClasses, classifyMainCommand(parsed, ctx, cwd, shellEnv, pushDests))
    }
    let countedDynamic = parsed.dynamicBeforeCommand
    if (!countedDynamic && !parsed.dynamicCommand && cmd !== 'eval' && cmd !== 'cd' && cmd !== 'pushd' && cmd !== 'popd' &&
      NO_ARGUMENT_EFFECT_CMDS[cmd] !== true) {
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
      else if (NO_ARGUMENT_EFFECT_CMDS[cmd] !== true) {
        commandAllowed ??= matchesCommandList(parsed.text, ctx.allowCommands)
        if (!commandAllowed) partClasses.push('other')
      }
    }

    if (!parsed.dynamicCommand && DOWNLOAD_CMDS.has(cmd)) downloadInPipeline = true
    pipelineDownloads.set(shellCommand.scope, downloadInPipeline)

    for (const word of parsed.argWords) {
      if (word.dynamic) continue
      const equals = word.text.indexOf('=')
      const value = word.text.startsWith('-') ? (equals >= 0 ? word.text.slice(equals + 1) : '') : word.text
      if (value === '') continue
      const expanded = expandHome(value, ctx.home)
      if (cwd === null && !isAbsolute(expanded)) continue
      if (isCredentialPath(resolvePath(value, cwd ?? '/', ctx.home), ctx, rootPaths)) partClasses.push('credential')
    }

    if (!parsed.dynamicCommand && isWriteCommand(cmd, args)) {
      for (const target of writeTargetWords) {
        if (target.dynamic) partClasses.push('edit-outside')
        else append(partClasses, cwd === null && !isAbsolute(expandHome(target.text, ctx.home)) ? ['edit-outside'] : writeClasses(target.text, cwd ?? '/', ctx, rootPaths))
      }
    }
    for (const redirect of shellCommand.redirects) {
      const target = redirect.target
      if (redirect.kind === 'read') {
        if (target.dynamic) partClasses.push('other')
        else {
          const expanded = expandHome(target.text, ctx.home)
          if (commandCwd !== null || isAbsolute(expanded)) {
            if (isCredentialPath(resolvePath(target.text, commandCwd ?? '/', ctx.home), ctx, rootPaths)) partClasses.push('credential')
          }
        }
        continue
      }
      if (redirect.kind !== 'write') continue
      if (!target.dynamic && ['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty'].includes(target.text)) continue
      if (target.dynamic || (commandCwd === null && !isAbsolute(expandHome(target.text, ctx.home)))) partClasses.push('edit-outside')
      else append(partClasses, writeClasses(target.text, commandCwd ?? '/', ctx, rootPaths))
    }

    if (shellCommand.scope === 0 && cwd !== commandCwd) cwdChanged = true
    if (nestedNonDirectoryRead || (!isShell && cmd !== 'eval' && cmd !== 'cd' && cmd !== 'pushd' && cmd !== 'popd' && partClasses.includes('read'))) {
      nonDirectoryRead = true
    }
    append(classes, partClasses)
    directories.set(shellCommand.scope, cwd)
  }
  return { classes, parts, pushDests, cwd: directoryFor(0), cwdChanged, env: environmentFor(0), envChanges, nonDirectoryRead }
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
    return analyzeCommand(shell.command, shell.cwd ?? call.cwd, ctx)
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
 * Unreadable shell text returns `other` and `edit-outside`. Computed words that no
 * other rule accounts for add `other`; ordinary `xargs` commands add `other`
 * unless exempt, while write and shell `-c`/`eval` commands add `edit-outside`.
 * A relative write target with an unknown cwd returns `edit-outside`.
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
