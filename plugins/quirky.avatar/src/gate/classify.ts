import { basename, isAbsolute, resolve, sep } from 'node:path'
import type { ActionClass, ClassifyContext, ToolCall } from '../contracts'

type Separator = '|' | '&&' | '||' | ';'
type Segment = { text: string; sep: Separator | null }
type Token = { text: string; quoted: boolean }
type Parsed = { cmd: string; args: string[]; text: string; envAssignments: string[] }

const READ_TOOLS = new Set(['read', 'notebookread', 'view', 'glob', 'grep', 'ls', 'find', 'todowrite', 'taskcreate', 'taskget', 'taskupdate', 'tasklist', 'taskoutput', 'enterplanmode', 'exitplanmode'])
const WRITE_TOOLS = new Set(['edit', 'write', 'multiedit', 'notebookedit', 'str_replace_editor', 'create'])
const NETWORK_TOOLS = new Set(['webfetch', 'websearch'])
const SHELL_TOOLS = new Set(['bash', 'shell', 'local_shell', 'exec_command', 'container.exec', 'run_shell_command'])
const PATH_KEYS = ['file_path', 'path', 'notebook_path', 'filePath', 'file']

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish'])
const WRAPPERS = new Set(['sudo', 'doas', 'nohup', 'time', 'command', 'exec', 'builtin', 'nice', 'ionice', 'stdbuf', 'xargs', 'env', 'timeout'])
const WRAPPER_VALUE_FLAGS = new Set(['-u', '-g', '-h', '-p', '-C', '-n', '-I', '-L', '-P', '-s', '-k'])
const READ_CMDS = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'pwd', 'echo', 'printf', 'which', 'whereis', 'type', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'awk', 'sort', 'uniq', 'cut', 'tr', 'diff', 'cmp', 'stat', 'file', 'tree', 'jq', 'yq', 'basename', 'dirname', 'realpath', 'readlink', 'true', 'false', 'test', '[', 'date', 'whoami', 'uname', 'id', 'less', 'more', 'column', 'fmt', 'nl', 'tac', 'od', 'xxd', 'hexdump', 'md5sum', 'shasum', 'sha256sum', 'du', 'df', 'cd', 'pushd', 'popd', 'sleep', 'ps', 'lsof'])
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

const unique = (classes: ActionClass[]): ActionClass[] => [...new Set(classes)]
const isFlag = (token: string) => token.startsWith('-') && token.length > 1

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
  return [ctx.worktreePath, ...ctx.handedOffPaths].map((root) => resolve(root))
}

function isInside(path: string, rootPaths: string[]): boolean {
  return rootPaths.some((root) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep))
}

function isCredentialPath(path: string, ctx: ClassifyContext): boolean {
  const home = resolve(ctx.home)
  for (const dir of CREDENTIAL_HOME_DIRS) {
    const full = resolve(home, dir)
    if (path === full || path.startsWith(full + sep)) return true
  }
  if (CREDENTIAL_HOME_FILES.some((file) => path === resolve(home, file))) return true
  return basename(path).startsWith('.env') && !isInside(path, roots(ctx))
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

function writeClasses(rawPath: string, cwd: string, ctx: ClassifyContext): ActionClass[] {
  const expanded = expandHome(rawPath, ctx.home)
  const path = resolvePath(rawPath, cwd, ctx.home)
  const classes: ActionClass[] = []
  if (isCredentialPath(path, ctx)) classes.push('credential')
  if (isAgentConfigPath(path)) classes.push('agent-config')
  classes.push(expanded.includes('$') || !isInside(path, roots(ctx)) ? 'edit-outside' : 'edit-inside')
  return classes
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  let quoted = false
  let started = false
  const flush = () => {
    if (started) tokens.push({ text: cur, quoted })
    cur = ''
    quoted = false
    started = false
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      if (c === quote) quote = null
      else if (c === '\\' && quote === '"' && i + 1 < text.length) cur += text[++i]
      else cur += c
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      quoted = true
      started = true
    } else if (c === '\\' && i + 1 < text.length) {
      cur += text[++i]
      started = true
    } else if (/\s/.test(c)) flush()
    else {
      cur += c
      started = true
    }
  }
  flush()
  return tokens
}

/** Splits on `&&`, `||`, `;`, `|`, newlines and subshell or backtick boundaries, ignoring separators inside quotes. */
function splitCommand(command: string): Segment[] {
  const segments: Segment[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  let sepBefore: Separator | null = null
  let depth = 0
  const flush = (next: Separator) => {
    if (cur.trim()) segments.push({ text: cur.trim(), sep: sepBefore })
    cur = ''
    sepBefore = next
  }
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    const next = command[i + 1]
    if (quote === "'") {
      if (c === "'") quote = null
      cur += c
      continue
    }
    if (c === '\\' && i + 1 < command.length) {
      cur += c + next
      i++
      continue
    }
    if (c === '`') {
      flush(';')
      continue
    }
    if (c === '$' && next === '(') {
      depth++
      flush(';')
      i++
      continue
    }
    if (c === ')' && depth > 0) {
      depth--
      flush(';')
      continue
    }
    if (quote === '"') {
      if (c === '"') quote = null
      cur += c
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      cur += c
    } else if (c === '&' && next === '&') {
      flush('&&')
      i++
    } else if (c === '|' && next === '|') {
      flush('||')
      i++
    } else if (c === '|') flush('|')
    else if (c === ';' || c === '\n') flush(';')
    else if (c === '&' && next !== '>' && command[i - 1] !== '>') flush(';')
    else if (c === '(') {
      depth++
      flush(';')
    } else if (c === ')') flush(';')
    else cur += c
  }
  flush(';')
  return segments
}

/** Separates redirect targets from the words of a command. */
function extractRedirects(tokens: Token[]): { words: string[]; targets: string[] } {
  const words: string[] = []
  const targets: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token.quoted) {
      words.push(token.text)
      continue
    }
    const bare = /^(?:\d*|&)>>?$/.exec(token.text)
    const attached = /^(?:\d*|&)>>?(.+)$/.exec(token.text)
    const target = bare ? tokens[++i]?.text : attached?.[1]
    if (!bare && !attached) words.push(token.text)
    else if (target && !target.startsWith('&') && target !== '/dev/null') targets.push(target)
  }
  return { words, targets }
}

function parseSegment(words: string[]): Parsed {
  const envAssignments: string[] = []
  let rest = words
  for (;;) {
    const head = rest[0]
    if (head === undefined) break
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head)) {
      envAssignments.push(head)
      rest = rest.slice(1)
      continue
    }
    if (!WRAPPERS.has(basename(head))) break
    const wrapper = basename(head)
    rest = rest.slice(1)
    while (rest[0] !== undefined && (isFlag(rest[0]) || (wrapper === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0])))) {
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0])) envAssignments.push(rest[0])
      const takesValue = (wrapper === 'sudo' || wrapper === 'doas' || wrapper === 'xargs') && WRAPPER_VALUE_FLAGS.has(rest[0])
      rest = rest.slice(takesValue ? 2 : 1)
    }
    if (wrapper === 'timeout') rest = rest.slice(1)
  }
  const [cmd = '', ...args] = rest
  return { cmd: basename(cmd), args, text: rest.join(' '), envAssignments }
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
      out.push(...args.slice(i + 1))
      break
    }
    if (isFlag(args[i])) {
      if (valueFlags.has(args[i])) i++
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

const GIT_ENV_REDIRECT = /^(?:GIT_DIR|GIT_WORK_TREE)=(.*)$/s

/**
 * True when the repository or worktree a git command acts on lies outside every handed-off path.
 * Considers the call's cwd, `-C`, `--git-dir`, `--work-tree`, `-c core.worktree` and the
 * `GIT_DIR` / `GIT_WORK_TREE` variables; a value that needs shell expansion counts as outside.
 */
function gitTargetsOutside(cwd: string, chdirs: string[], redirects: string[], ctx: ClassifyContext): boolean {
  const rootPaths = roots(ctx)
  const dynamic = (value: string) => /[$`]/.test(value)
  let gitCwd = cwd
  for (const dir of chdirs) {
    if (dynamic(dir)) return true
    gitCwd = resolvePath(dir, gitCwd, ctx.home)
  }
  if (!isInside(gitCwd, rootPaths)) return true
  return redirects.some((value) => dynamic(value) || !isInside(resolvePath(value, gitCwd, ctx.home), rootPaths) || !isInside(resolvePath(value, cwd, ctx.home), rootPaths))
}

/**
 * True when a `git worktree add|remove|move` names a path outside every handed-off path.
 * Paths resolve against the directory git runs in after `-C` hops; a value needing shell
 * expansion counts as outside.
 */
function worktreeTargetsOutside(rest: string[], gitCwd: string, ctx: ClassifyContext): boolean {
  const [action, ...operands] = positionals(rest, GIT_WORKTREE_VALUE_FLAGS)
  const targets = action === 'remove' ? operands : action === 'move' ? operands.slice(0, 2) : action === 'add' ? operands.slice(0, 1) : []
  const rootPaths = roots(ctx)
  return targets.some((target) => /[$`]/.test(target) || !isInside(resolvePath(target, gitCwd, ctx.home), rootPaths))
}

function classifyGit(args: string[], envAssignments: string[], ctx: ClassifyContext, cwd: string): ActionClass[] {
  const classes: ActionClass[] = []
  const chdirs: string[] = []
  const redirects: string[] = []
  let sub: string | undefined
  let subIndex = -1
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '-C') {
      if (args[i + 1] !== undefined) chdirs.push(args[++i])
      continue
    }
    if (arg.startsWith('-C') && arg.length > 2) {
      chdirs.push(arg.slice(2))
      continue
    }
    const redirect = /^--(?:git-dir|work-tree)(?:=(.*))?$/s.exec(arg)
    if (redirect) {
      const value = redirect[1] ?? args[++i]
      if (value !== undefined && value !== '') redirects.push(value)
      continue
    }
    if (arg === '-c') {
      const config = args[i + 1] ?? ''
      if (/^core\.hooksPath=/i.test(config)) classes.push('skip-hooks')
      const worktree = /^core\.worktree=(.*)$/is.exec(config)
      if (worktree && worktree[1] !== '') redirects.push(worktree[1])
      i++
      continue
    }
    if (isFlag(arg)) continue
    sub = arg
    subIndex = i
    break
  }
  for (const assignment of envAssignments) {
    const value = GIT_ENV_REDIRECT.exec(assignment)?.[1]
    if (value !== undefined && value !== '') redirects.push(value)
  }
  const outside = gitTargetsOutside(cwd, chdirs, redirects, ctx)
  const localEdit: ActionClass = outside ? 'edit-outside' : 'edit-inside'
  const rest = subIndex >= 0 ? args.slice(subIndex + 1) : []
  const hooksEnv = envAssignments.some((a) => /^(HUSKY|HUSKY_SKIP_HOOKS|SKIP_HOOKS)=(0|1|true)$/.test(a))
  if ((hooksEnv && ['commit', 'push', 'merge', 'rebase'].includes(sub ?? '')) || rest.includes('--no-verify') || (sub === 'commit' && rest.includes('-n')) || rest.some((arg) => /core\.hooksPath/i.test(arg))) classes.push('skip-hooks')
  if (sub === undefined) return classes.length ? classes : ['read']
  if (sub === 'push') return [...classes, ...classifyPush(rest, ctx), ...(outside ? ['edit-outside' as const] : [])]
  if (sub === 'rebase') return [...classes, 'push-force', localEdit]
  if (sub === 'ls-remote' || sub === 'clone') return [...classes, 'network-read']
  if (GIT_READ_SUBCOMMANDS.has(sub)) return [...classes, 'read']
  if (sub === 'worktree') {
    const gitCwd = chdirs.reduce((dir, chdir) => resolvePath(chdir, dir, ctx.home), cwd)
    return [...classes, outside || worktreeTargetsOutside(rest, gitCwd, ctx) ? 'edit-outside' : 'edit-inside']
  }
  if (GIT_LOCAL_SUBCOMMANDS.has(sub)) return [...classes, localEdit]
  return [...classes, 'other']
}

function classifyPush(args: string[], ctx: ClassifyContext): ActionClass[] {
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

function writeTargets(parsed: Parsed): string[] {
  const { cmd, args } = parsed
  const operands = positionals(args)
  if (cmd === 'sed' || cmd === 'perl') return args.some((arg) => /^-[a-zA-Z]*i/.test(arg) || arg === '--in-place') ? operands.slice(1) : []
  if (WRITE_SKIP_FIRST_CMDS.has(cmd)) return operands.slice(1)
  if (WRITE_ALL_CMDS.has(cmd)) return operands
  if (WRITE_DEST_CMDS.has(cmd)) {
    const targetFlag = args.findIndex((arg) => arg === '-t' || arg === '--target-directory')
    if (targetFlag >= 0 && args[targetFlag + 1]) return [args[targetFlag + 1]]
    return operands.slice(-1)
  }
  return []
}

function isWriteCommand(cmd: string, args: string[]): boolean {
  if (cmd === 'sed' || cmd === 'perl') return args.some((arg) => /^-[a-zA-Z]*i/.test(arg) || arg === '--in-place')
  return WRITE_ALL_CMDS.has(cmd) || WRITE_SKIP_FIRST_CMDS.has(cmd) || WRITE_DEST_CMDS.has(cmd)
}

type Analysis = { classes: ActionClass[]; parts: string[] }

function analyzeCommand(command: string, startCwd: string, ctx: ClassifyContext, depth = 0, inheritedEnv: string[] = []): Analysis {
  const classes: ActionClass[] = []
  const parts: string[] = []
  if (depth > 4) return { classes: ['other'], parts }
  let cwd = startCwd
  let downloadInPipeline = false
  const shellEnv = [...inheritedEnv]

  if (/\b(?:ba|z|da|k)?sh\b[^|;&\n]*(?:\$\(|<\(|`)\s*(?:curl|wget)\b/.test(command)) classes.push('pipe-to-shell')

  for (const segment of splitCommand(command)) {
    if (segment.sep !== '|') downloadInPipeline = false
    const { words, targets } = extractRedirects(tokenize(segment.text))
    const parsed = parseSegment(words)
    const { cmd, args } = parsed
    if (cmd === '') shellEnv.push(...parsed.envAssignments)
    else if (cmd === 'export') shellEnv.push(...args)
    if (cmd === '' && targets.length === 0) continue

    const partClasses: ActionClass[] = []
    const isShell = SHELLS.has(cmd)
    const commandFlag = isShell ? args.findIndex((arg) => /^-[a-zA-Z]*c$/.test(arg)) : -1

    if (cmd === 'cd' || cmd === 'pushd') {
      const target = positionals(args)[0]
      if (target !== undefined) cwd = resolvePath(target, cwd, ctx.home)
      partClasses.push('read')
    } else if (isShell && commandFlag >= 0 && args[commandFlag + 1] !== undefined) {
      const inner = analyzeCommand(args[commandFlag + 1], cwd, ctx, depth + 1, [...shellEnv, ...parsed.envAssignments])
      partClasses.push(...inner.classes)
      parts.push(...inner.parts)
    } else if (cmd === 'eval' && args.length > 0) {
      const inner = analyzeCommand(args.join(' '), cwd, ctx, depth + 1, [...shellEnv, ...parsed.envAssignments])
      partClasses.push(...inner.classes)
      parts.push(...inner.parts)
    } else if (isShell) {
      partClasses.push(downloadInPipeline ? 'pipe-to-shell' : 'other')
    } else if (cmd !== '') {
      parts.push(parsed.text)
      partClasses.push(...classifyMainCommand(parsed, ctx, cwd, shellEnv))
    }

    if (DOWNLOAD_CMDS.has(cmd)) downloadInPipeline = true

    for (const token of words.slice(1)) {
      const value = token.startsWith('-') ? (token.split('=')[1] ?? '') : token
      if (value !== '' && isCredentialPath(resolvePath(value, cwd, ctx.home), ctx)) partClasses.push('credential')
    }
    if (isWriteCommand(cmd, args)) {
      const targetPaths = writeTargets(parsed)
      for (const path of targetPaths.length > 0 ? targetPaths : [cwd]) partClasses.push(...writeClasses(path, cwd, ctx))
    }
    for (const target of targets) partClasses.push(...writeClasses(target, cwd, ctx))

    classes.push(...partClasses)
  }
  return { classes, parts }
}

function classifyMainCommand(parsed: Parsed, ctx: ClassifyContext, cwd: string, shellEnv: string[]): ActionClass[] {
  const { cmd, args, text, envAssignments } = parsed
  const deploy = matchesCommandList(text, ctx.deployCommands) || isBuiltinDeploy(cmd, args)
  if (deploy) return ['deploy']
  let classes: ActionClass[]
  if (cmd === 'git') classes = classifyGit(args, [...shellEnv, ...envAssignments], ctx, cwd)
  else if (cmd === 'gh' || cmd === 'glab') classes = classifyPullRequestCli(cmd, args)
  else if (DOWNLOAD_CMDS.has(cmd)) classes = classifyDownload(args)
  else if (cmd === 'security') classes = ['credential']
  else if (MESSAGE_CMDS.has(cmd)) classes = ['message-people']
  else if (PACKAGE_MANAGERS.has(cmd)) classes = classifyPackageManager(cmd, args)
  else if (cmd === 'bunx' || cmd === 'npx') classes = classifyTool(positionals(args)[0], args.slice(1))
  else if (cmd === 'make') classes = testOrBuild(scriptClass(positionals(args)[0]), args)
  else if (cmd === 'cargo' || cmd === 'go') classes = classifyCargoOrGo(args)
  else if (cmd === 'python' || cmd === 'python3') classes = args[0] === '-m' && (args[1] === 'pytest' || args[1] === 'unittest') ? testOrBuild('test', args) : ['other']
  else if (cmd === 'find') classes = args.some((arg) => arg === '-delete' || arg === '-exec' || arg === '-execdir') ? ['other'] : ['read']
  else if (READ_CMDS.has(cmd)) classes = ['read']
  else if ((cmd === 'sed' || cmd === 'perl') && !isWriteCommand(cmd, args)) classes = ['read']
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
  return [...text.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)].map((match) => match[1].trim())
}

function analyzeCall(call: ToolCall, ctx: ClassifyContext): Analysis {
  const tool = call.toolName.toLowerCase()
  if (SHELL_TOOLS.has(tool)) {
    const shell = shellCommandOf(call.toolInput)
    if (shell === null || shell.command.trim() === '') return { classes: ['other'], parts: [] }
    return analyzeCommand(shell.command, shell.cwd ?? call.cwd, ctx)
  }
  if (tool === 'apply_patch') {
    const paths = patchPaths(call.toolInput)
    if (paths.length === 0) return { classes: ['other'], parts: [] }
    return { classes: paths.flatMap((path) => writeClasses(path, call.cwd, ctx)), parts: [] }
  }
  if (READ_TOOLS.has(tool)) {
    const path = pathOf(call.toolInput)
    return { classes: path === null ? ['read'] : readClasses(resolvePath(path, call.cwd, ctx.home), ctx), parts: [] }
  }
  if (WRITE_TOOLS.has(tool)) {
    const path = pathOf(call.toolInput)
    return { classes: path === null ? ['other'] : writeClasses(path, call.cwd, ctx), parts: [] }
  }
  if (NETWORK_TOOLS.has(tool)) return { classes: ['network-read'], parts: [] }
  return { classes: ['other'], parts: [] }
}

/**
 * Maps a tool call onto the action classes the gate decides on.
 *
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
