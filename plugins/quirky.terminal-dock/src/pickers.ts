import * as BunRuntime from 'bun'
import { YAML } from 'bun'
import { constants } from 'node:fs'
import type { Dirent } from 'node:fs'
import { lstat, open, realpath, readdir } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { PluginContext, Session } from '@quirky/protocol'
import type { PickerItem } from './types.ts'

// Bun 1.4 exports JSONC at runtime, but the installed module types omit it.
const JSONC = (BunRuntime as typeof BunRuntime & {
  JSONC: { parse(text: string): unknown }
}).JSONC

const MAX_RESULTS = 100
const MAX_VISITED_ENTRIES = 5_000
const MAX_DEPTH = 8
const MAX_METADATA_BYTES = 16 * 1024
const MAX_CONFIG_BYTES = 64 * 1024
const MAX_OMP_CUSTOM_DIRECTORIES = 64
const MAX_LAUNCH_ARGUMENT_BYTES = 64 * 1024
const PRUNED_DIRECTORIES: Readonly<Record<string, true>> = {
  '.git': true,
  '.cache': true,
  build: true,
  coverage: true,
  dist: true,
  node_modules: true,
  target: true,
  vendor: true
}
const COMMAND_EXTENSION: Readonly<Record<'markdown' | 'toml', string>> = { markdown: '.md', toml: '.toml' }
const CLAUDE_AGENTS: Readonly<Record<string, true>> = { claude: true, 'claude-agent-teams': true, openclaude: true }
const CODEX_AGENTS: Readonly<Record<string, true>> = { codex: true }
const OPENCODE_AGENTS: Readonly<Record<string, true>> = { opencode: true, opencode2: true }
const ZCODE_AGENTS: Readonly<Record<string, true>> = { zcode: true }
const GEMINI_AGENTS: Readonly<Record<string, true>> = { gemini: true }
type BuiltinCommand = { name: string; description: string }
const COMMON_COMMANDS: readonly BuiltinCommand[] = [
  { name: 'clear', description: 'Clear the conversation' },
  { name: 'help', description: 'Show available commands' }
]
const CLAUDE_COMMANDS: readonly BuiltinCommand[] = [
  { name: 'clear', description: 'Clear conversation history' },
  { name: 'compact', description: 'Summarize and compact the conversation' },
  { name: 'init', description: 'Initialize a CLAUDE.md' },
  { name: 'review', description: 'Review the current changes' },
  { name: 'help', description: 'Show available commands' }
]
const OPENCLAUDE_COMMANDS: readonly BuiltinCommand[] = [
  ...CLAUDE_COMMANDS,
  { name: 'context', description: 'Show context usage' }
]
const CODEX_COMMANDS: readonly BuiltinCommand[] = [
  { name: 'model', description: 'Choose the model and reasoning effort' },
  { name: 'ide', description: 'Include IDE context' },
  { name: 'permissions', description: 'Choose what Codex is allowed to do' },
  { name: 'keymap', description: 'Remap TUI shortcuts' },
  { name: 'vim', description: 'Toggle Vim mode' },
  { name: 'experimental', description: 'Toggle experimental features' },
  { name: 'approve', description: 'Approve one auto-review retry' },
  { name: 'memories', description: 'Configure memory use' },
  { name: 'skills', description: 'Manage and use skills' },
  { name: 'import', description: 'Import setup from Claude Code' },
  { name: 'hooks', description: 'View lifecycle hooks' },
  { name: 'review', description: 'Review the current changes' },
  { name: 'rename', description: 'Rename the current thread' },
  { name: 'new', description: 'Start a new chat' },
  { name: 'archive', description: 'Archive this session and exit' },
  { name: 'delete', description: 'Delete this session and exit' },
  { name: 'resume', description: 'Resume a saved chat' },
  { name: 'fork', description: 'Fork the current chat' },
  { name: 'app', description: 'Continue in Codex Desktop' },
  { name: 'init', description: 'Create an AGENTS.md file' },
  { name: 'compact', description: 'Compact the conversation' },
  { name: 'plan', description: 'Switch to Plan mode' },
  { name: 'goal', description: 'Set or view the goal' },
  { name: 'agent', description: 'Switch the active agent thread' },
  { name: 'side', description: 'Start a side conversation' },
  { name: 'copy', description: 'Copy the last response as markdown' },
  { name: 'raw', description: 'Toggle raw scrollback mode' },
  { name: 'diff', description: 'Show the working diff' },
  { name: 'mention', description: 'Mention a file' },
  { name: 'status', description: 'Show session configuration and usage' },
  { name: 'usage', description: 'View account usage' },
  { name: 'title', description: 'Configure the terminal title' },
  { name: 'statusline', description: 'Configure the status line' },
  { name: 'theme', description: 'Choose a syntax highlighting theme' },
  { name: 'pets', description: 'Choose or hide the terminal pet' },
  { name: 'mcp', description: 'List configured MCP tools' },
  { name: 'plugins', description: 'Browse plugins' },
  { name: 'logout', description: 'Log out of Codex' },
  { name: 'exit', description: 'Exit Codex' },
  { name: 'feedback', description: 'Send logs to maintainers' },
  { name: 'ps', description: 'List background terminals' },
  { name: 'stop', description: 'Stop all background terminals' },
  { name: 'clear', description: 'Clear the terminal and start a new chat' },
  { name: 'personality', description: 'Choose a communication style' },
  { name: 'subagents', description: 'Switch the active agent thread' }
]
const OMP_COMMANDS: readonly BuiltinCommand[] = [
  { name: 'model', description: 'Open the model selector in Terminal' },
  { name: 'switch', description: 'Open the temporary model selector in Terminal' },
  { name: 'plan', description: 'Toggle plan mode' },
  { name: 'compact', description: 'Compact conversation context' },
  { name: 'clear', description: 'Clear context while keeping the session' },
  { name: 'new', description: 'Start a new session' },
  { name: 'resume', description: 'Resume a session in Terminal' },
  { name: 'fork', description: 'Fork from a previous message in Terminal' },
  { name: 'branch', description: 'Rewind to a previous message in Terminal' },
  { name: 'tree', description: 'Browse the session tree in Terminal' },
  { name: 'session', description: 'Show session information and controls' },
  { name: 'rename', description: 'Rename the session' },
  { name: 'context', description: 'Show estimated context usage' },
  { name: 'usage', description: 'Show provider usage and limits' },
  { name: 'fast', description: 'Toggle priority service tier' },
  { name: 'tools', description: 'Show tools visible to the agent' },
  { name: 'jobs', description: 'Show background jobs' },
  { name: 'git', description: 'Open the Git viewer in Terminal' },
  { name: 'export', description: 'Export the session to HTML' },
  { name: 'settings', description: 'Open settings in Terminal' },
  { name: 'extensions', description: 'Open the extension dashboard in Terminal' },
  { name: 'hotkeys', description: 'Show keyboard shortcuts in Terminal' }
]
const ZCODE_COMMANDS: readonly BuiltinCommand[] = [
  { name: 'goal', description: 'Show or set the current session goal' },
  { name: 'compact', description: 'Compact the current conversation context' }
]
const VERIFIED_COMMANDS: Readonly<Record<string, readonly BuiltinCommand[]>> = {
  claude: CLAUDE_COMMANDS,
  'claude-agent-teams': CLAUDE_COMMANDS,
  openclaude: OPENCLAUDE_COMMANDS,
  codex: CODEX_COMMANDS,
  grok: [],
  omp: OMP_COMMANDS,
  opencode: COMMON_COMMANDS,
  opencode2: COMMON_COMMANDS,
  zcode: ZCODE_COMMANDS,
  gemini: COMMON_COMMANDS
}
const GROK_AGENTS: Readonly<Record<string, true>> = { grok: true }
const OMP_AGENTS: Readonly<Record<string, true>> = { omp: true }

type Root = { path: string; boundary: string; maxDepth?: number }
type CommandRoot = { root: Root; format: 'markdown' | 'toml' }
type AgentLayout = {
  commands: CommandRoot[]
  skills: Root[]
  skillPrefix: '/' | '$' | '/skill:'
  requireSkillMetadata?: 'description' | 'name-and-description'
}
type WalkBudget = { visited: number; truncated: boolean }
type WalkFile = { absolutePath: string; relativePath: string }
type Walker = (file: WalkFile) => Promise<boolean | void>
type Frontmatter = { name?: string; description?: string }

function roots(cwd: string, home: string, workspace: string, userHome: string, paths: string[]): Root[] {
  return paths.map((path) => ({ path: join(cwd, path), boundary: workspace })).concat(
    paths.map((path) => ({ path: join(home, path), boundary: userHome }))
  )
}
type OmpEnvironment = Readonly<Record<string, string | undefined>>

function ompAgentDirectory(
  home: string,
  environment: OmpEnvironment = process.env,
  profileOverride: string | null = null
): string {
  const explicit = environment.OMP_CODING_AGENT_DIR?.trim()
  if (explicit && isAbsolute(explicit)) {
    const root = resolve(explicit)
    const name = basename(root).toLowerCase()
    return name === 'sessions' ? dirname(root) : name === '.omp' ? join(root, 'agent') : root
  }
  const piAgent = environment.PI_CODING_AGENT_DIR?.trim()
  if (piAgent) return resolve(piAgent)
  const config = environment.PI_CONFIG_DIR?.trim()
  const configRoot = config ? (isAbsolute(config) ? resolve(config) : join(home, config)) : join(home, '.omp')
  const profile = (profileOverride ?? environment.OMP_PROFILE ?? environment.PI_PROFILE)?.trim()
  const validProfile = profile && profile !== 'default' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(profile) ? profile : null
  return join(configRoot, ...(validProfile ? ['profiles', validProfile] : []), 'agent')
}

type ConfigRead = { found: boolean; valid: boolean; value?: unknown }

function asConfigRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

async function readConfigFile(path: string): Promise<ConfigRead> {
  let handle: FileHandle | undefined
  let found = false
  try {
    const before = await lstat(path)
    found = true
    if (!before.isFile() || before.size > MAX_CONFIG_BYTES) return { found, valid: false }
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    const opened = await handle.stat()
    if (!opened.isFile() || opened.size > MAX_CONFIG_BYTES) return { found, valid: false }

    const buffer = Buffer.allocUnsafe(Math.min(opened.size + 1, MAX_CONFIG_BYTES + 1))
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null)
      if (bytesRead === 0) break
      length += bytesRead
    }
    const after = await handle.stat()
    if (after.size !== opened.size || length !== opened.size) return { found, valid: false }
    const content = buffer.subarray(0, length).toString('utf8')
    const extension = extname(path).toLowerCase()
    const value = extension === '.json' || extension === '.jsonc'
      ? JSONC.parse(content)
      : YAML.parse(content)
    return { found, valid: true, value }
  } catch (error) {
    const code = filesystemError(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') return { found: false, valid: false }
    return { found: true, valid: false }
  } finally {
    await handle?.close()
  }
}

async function readFirstOmpConfig(paths: string[]): Promise<ConfigRead> {
  for (const path of paths) {
    const result = await readConfigFile(path)
    if (result.found) return result
  }
  return { found: false, valid: false }
}

function configFileCandidates(directory: string, includeLegacyJson = true): string[] {
  return [
    join(directory, 'config.yml'),
    join(directory, 'config.yaml'),
    ...(includeLegacyJson ? [join(directory, 'config.json'), join(directory, 'config.jsonc')] : [])
  ]
}

function tokenizeLaunchArguments(text: string): string[] | null {
  if (text.length > MAX_LAUNCH_ARGUMENT_BYTES) return null
  const tokens: string[] = []
  let current = ''
  let inToken = false
  let quote: '"' | "'" | null = null
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!
    if (quote === "'") {
      if (character === "'") quote = null
      else current += character
      continue
    }
    if (quote === '"') {
      if (character === '"') quote = null
      else if (character === '\\' && index + 1 < text.length) {
        const next = text[index + 1]!
        if ('$`"\\'.includes(next)) {
          current += next
          index++
        } else if (next === '\n') {
          index++
        } else {
          current += character
        }
      } else current += character
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      inToken = true
    } else if (character === '\\' && index + 1 < text.length) {
      const next = text[index + 1]!
      index++
      if (next !== '\n') {
        current += next
        inToken = true
      }
    } else if (/\s/.test(character)) {
      if (inToken) {
        tokens.push(current)
        current = ''
        inToken = false
      }
    } else {
      current += character
      inToken = true
    }
    if (tokens.length > MAX_OMP_CUSTOM_DIRECTORIES * 16) return null
  }
  if (quote) return null
  if (inToken) tokens.push(current)
  return tokens
}

function launchProfile(args: string): string | null {
  const tokens = tokenizeLaunchArguments(args)
  if (!tokens) return null
  let profile: string | null = null
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!
    if (token === '--') break
    if (token === '--profile') {
      profile = tokens[index + 1] ?? null
      index++
    } else if (token.startsWith('--profile=')) {
      profile = token.slice('--profile='.length)
    }
  }
  return profile && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(profile) ? profile : null
}

function launchConfigPaths(args: string, cwd: string): string[] {
  const tokens = tokenizeLaunchArguments(args)
  if (!tokens) return []
  const paths: string[] = []
  for (let index = 0; index < tokens.length && paths.length < MAX_OMP_CUSTOM_DIRECTORIES; index++) {
    const token = tokens[index]!
    if (token === '--') break
    let path: string | null = null
    if (token === '--config') {
      const next = tokens[index + 1]
      if (next && next !== '--') {
        path = next
        index++
      }
    } else if (token.startsWith('--config=')) {
      path = token.slice('--config='.length)
    }
    if (path?.trim() && path.length <= 4_096) {
      paths.push(resolve(isAbsolute(path) ? path : join(cwd, path)))
    }
  }
  return paths
}

function configuredOmpDirectories(config: ConfigRead): string[] | undefined {
  if (!config.found) return undefined
  if (!config.valid) return []
  const root = asConfigRecord(config.value)
  const skills = asConfigRecord(root?.skills)
  if (!skills || !Object.prototype.hasOwnProperty.call(skills, 'customDirectories')) return undefined
  const value = skills.customDirectories
  if (!Array.isArray(value) || value.length > MAX_OMP_CUSTOM_DIRECTORIES ||
    value.some((path) => typeof path !== 'string' || path.length > 4_096)) return []
  return value.flatMap((path) => typeof path === 'string' && path.trim() ? [path.trim()] : [])
}

function expandOmpDirectory(path: string, cwd: string, home: string): string | null {
  if (path.length > 4_096) return null
  if (path === '~') return resolve(home)
  if (path.startsWith('~/') || path.startsWith('~\\')) return resolve(home, path.slice(2))
  return resolve(isAbsolute(path) ? path : join(cwd, path))
}

async function ompCustomSkillRoots(
  cwd: string,
  home: string,
  environment: OmpEnvironment,
  launchArgs: string
): Promise<Root[]> {
  const configDirectory = environment.PI_CONFIG_DIR?.trim()
  const projectConfigDirectory = configDirectory
    ? (isAbsolute(configDirectory) ? resolve(configDirectory) : resolve(cwd, configDirectory))
    : join(cwd, '.omp')
  const layers: ConfigRead[] = [
    await readFirstOmpConfig(configFileCandidates(ompAgentDirectory(home, environment, launchProfile(launchArgs)))),
    await readFirstOmpConfig([
      ...configFileCandidates(projectConfigDirectory, false),
      join(projectConfigDirectory, 'settings.json')
    ])
  ]
  const overlayFiles = (environment.PI_CONFIG_FILES ?? '').split(delimiter)
    .map((path) => path.trim())
    .filter(Boolean)
    .slice(0, MAX_OMP_CUSTOM_DIRECTORIES)
  for (const path of overlayFiles) {
    layers.push(await readConfigFile(resolve(isAbsolute(path) ? path : join(cwd, path))))
  }
  for (const path of launchConfigPaths(launchArgs, cwd)) {
    layers.push(await readConfigFile(path))
  }

  let configured: string[] = []
  for (const layer of layers) {
    const directories = configuredOmpDirectories(layer)
    if (directories !== undefined) configured = directories
  }
  return configured.flatMap((path): Root[] => {
    const directory = expandOmpDirectory(path, cwd, home)
    return directory ? [{ path: directory, boundary: directory, maxDepth: 1 }] : []
  })
}

function layoutFor(
  agent: string,
  cwd: string,
  home: string,
  workspace: string,
  userHome: string,
  environment: OmpEnvironment = process.env,
  launchProfileName: string | null = null
): AgentLayout {
  if (Object.prototype.hasOwnProperty.call(CLAUDE_AGENTS, agent)) {
    const configuredHome = process.env.CLAUDE_CONFIG_DIR?.trim()
    const claudeHome = configuredHome && isAbsolute(configuredHome) ? resolve(configuredHome) : join(home, '.claude')
    const claudeBoundary = configuredHome && isAbsolute(configuredHome) ? claudeHome : userHome
    return {
      commands: [
        { root: { path: join(cwd, '.claude/commands'), boundary: workspace }, format: 'markdown' },
        { root: { path: join(claudeHome, 'commands'), boundary: claudeBoundary }, format: 'markdown' }
      ],
      skills: [
        ...roots(cwd, home, workspace, userHome, ['.agents/skills']),
        { path: join(cwd, '.claude/skills'), boundary: workspace },
        { path: join(claudeHome, 'skills'), boundary: claudeBoundary }
      ],
      skillPrefix: '/'
    }
  }
  if (Object.prototype.hasOwnProperty.call(CODEX_AGENTS, agent)) {
    return {
      commands: [],
      skills: [
        ...roots(cwd, home, workspace, userHome, ['.agents/skills']),
        { path: join(userHome, '.codex/skills'), boundary: userHome }
      ],
      skillPrefix: '$'
    }
  }
  if (Object.prototype.hasOwnProperty.call(GROK_AGENTS, agent)) {
    const configuredHome = process.env.GROK_HOME?.trim()
    const grokHome = configuredHome && isAbsolute(configuredHome) ? resolve(configuredHome) : join(home, '.grok')
    const grokBoundary = configuredHome && isAbsolute(configuredHome) ? grokHome : userHome
    return {
      commands: [],
      skills: [
        ...roots(cwd, home, workspace, userHome, ['.agents/skills']),
        { path: join(cwd, '.grok/skills'), boundary: workspace },
        { path: join(grokHome, 'skills'), boundary: grokBoundary }
      ],
      skillPrefix: '/'
    }
  }
  if (Object.prototype.hasOwnProperty.call(OMP_AGENTS, agent)) {
    const agentDirectory = ompAgentDirectory(home, environment, launchProfileName)
    const agentBoundary = within(userHome, agentDirectory) ? userHome : agentDirectory
    const configuredRoot = environment.PI_CONFIG_DIR?.trim()
    const projectConfigDirectory = configuredRoot
      ? (isAbsolute(configuredRoot) ? resolve(configuredRoot) : resolve(cwd, configuredRoot))
      : join(cwd, '.omp')
    const projectBoundary = within(workspace, projectConfigDirectory) ? workspace : projectConfigDirectory
    const config = environment.XDG_CONFIG_HOME || join(home, '.config')
    const userConfig = resolve(config)
    const compatibleRoots = roots(cwd, home, workspace, userHome, [
      '.agent/skills',
      '.agents/skills',
      '.claude/skills',
      '.codex/skills'
    ]).map((root) => ({ ...root, maxDepth: 1 }))
    return {
      commands: [],
      skills: [
        { path: join(projectConfigDirectory, 'skills'), boundary: projectBoundary, maxDepth: 1 },
        { path: join(agentDirectory, 'skills'), boundary: agentBoundary, maxDepth: 1 },
        ...compatibleRoots,
        { path: join(cwd, '.opencode/skills'), boundary: workspace, maxDepth: 1 },
        { path: join(userConfig, 'opencode/skills'), boundary: userConfig, maxDepth: 1 },
        { path: join(cwd, '.github/skills'), boundary: workspace, maxDepth: 1 }
      ],
      skillPrefix: '/skill:',
      requireSkillMetadata: 'description'
    }
  }
  if (Object.prototype.hasOwnProperty.call(ZCODE_AGENTS, agent)) {
    return {
      commands: [{ root: { path: join(userHome, '.zcode/commands'), boundary: userHome, maxDepth: 1 }, format: 'markdown' }],
      skills: [
        ...roots(cwd, home, workspace, userHome, ['.agents/skills']).map((root) => ({ ...root, maxDepth: 1 })),
        { path: join(userHome, '.zcode/skills'), boundary: userHome, maxDepth: 1 }
      ],
      skillPrefix: '$',
      requireSkillMetadata: 'name-and-description'
    }
  }
  if (Object.prototype.hasOwnProperty.call(OPENCODE_AGENTS, agent)) {
    const config = process.env.XDG_CONFIG_HOME || join(home, '.config')
    const configuredClaudeHome = process.env.CLAUDE_CONFIG_DIR?.trim()
    const claudeHome = configuredClaudeHome && isAbsolute(configuredClaudeHome) ? resolve(configuredClaudeHome) : join(home, '.claude')
    const claudeBoundary = configuredClaudeHome && isAbsolute(configuredClaudeHome) ? claudeHome : userHome
    const userConfig = resolve(config)
    return {
      commands: [
        { root: { path: join(cwd, '.opencode/command'), boundary: workspace }, format: 'markdown' },
        { root: { path: join(userConfig, 'opencode/command'), boundary: userConfig }, format: 'markdown' }
      ],
      skills: [
        ...roots(cwd, home, workspace, userHome, ['.agents/skills']),
        { path: join(cwd, '.claude/skills'), boundary: workspace },
        { path: join(claudeHome, 'skills'), boundary: claudeBoundary },
        { path: join(cwd, '.opencode/skill'), boundary: workspace },
        { path: join(cwd, '.opencode/skills'), boundary: workspace },
        { path: join(userConfig, 'opencode/skills'), boundary: userConfig }
      ],
      skillPrefix: '/'
    }
  }
  if (Object.prototype.hasOwnProperty.call(GEMINI_AGENTS, agent)) {
    return {
      commands: roots(cwd, home, workspace, userHome, ['.gemini/commands']).map((root) => ({ root, format: 'toml' })),
      skills: roots(cwd, home, workspace, userHome, ['.agents/skills']),
      skillPrefix: '/'
    }
  }
  return { commands: [], skills: [], skillPrefix: '/' }
}

function within(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}

function filesystemError(error: unknown): string | undefined {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') return error.code
  return undefined
}

async function existingRoot(root: Root): Promise<string | null> {
  let info
  try {
    info = await lstat(root.path)
  } catch (error) {
    if (filesystemError(error) === 'ENOENT' || filesystemError(error) === 'ENOTDIR') return null
    throw error
  }
  if (!info.isDirectory()) return null
  const actual = await realpath(root.path)
  const boundary = await realpath(root.boundary)
  if (!within(boundary, actual)) return null
  return actual
}

async function walk(root: Root, budget: WalkBudget, visit: Walker): Promise<void> {
  const absoluteRoot = await existingRoot(root)
  if (absoluteRoot === null || budget.truncated) return

  const pending = [{ path: absoluteRoot, relativePath: '', depth: 0 }]
  while (pending.length > 0 && !budget.truncated) {
    const directory = pending.pop()!
    let entries: Dirent[]
    try {
      entries = await readdir(directory.path, { withFileTypes: true })
    } catch (error) {
      if (filesystemError(error) === 'ENOENT' || filesystemError(error) === 'ENOTDIR') continue
      throw error
    }
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))

    for (const entry of entries) {
      budget.visited += 1
      if (budget.visited > MAX_VISITED_ENTRIES) {
        budget.truncated = true
        break
      }
      if (entry.isSymbolicLink() || (entry.isDirectory() && Object.prototype.hasOwnProperty.call(PRUNED_DIRECTORIES, entry.name))) continue
      const absolutePath = join(directory.path, entry.name)
      const relativePath = directory.relativePath === '' ? entry.name : join(directory.relativePath, entry.name)

      if (entry.isDirectory()) {
        const depthLimit = root.maxDepth ?? MAX_DEPTH
        if (directory.depth >= depthLimit) {
          if (root.maxDepth === undefined) {
            budget.truncated = true
            break
          }
          continue
        }
        const details = await lstat(absolutePath)
        if (!details.isDirectory()) continue
        const actual = await realpath(absolutePath)
        if (within(absoluteRoot, actual)) {
          pending.push({ path: actual, relativePath, depth: directory.depth + 1 })
        }
        continue
      }

      if (!entry.isFile()) continue
      const details = await lstat(absolutePath)
      if (!details.isFile()) continue
      const stop = await visit({ absolutePath, relativePath: relativePath.split(sep).join('/') })
      if (stop === true) {
        budget.truncated = true
        break
      }
    }
  }
}

async function readMetadata(path: string): Promise<string> {
  let handle: FileHandle | undefined
  try {
    const before = await lstat(path)
    if (!before.isFile() || before.size > MAX_METADATA_BYTES) return ''
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    const opened = await handle.stat()
    if (!opened.isFile() || opened.size > MAX_METADATA_BYTES) return ''

    const buffer = Buffer.allocUnsafe(Math.min(opened.size + 1, MAX_METADATA_BYTES + 1))
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null)
      if (bytesRead === 0) break
      length += bytesRead
    }
    const after = await handle.stat()
    if (after.size !== opened.size || length !== opened.size) return ''
    return buffer.subarray(0, length).toString('utf8')
  } catch (error) {
    const code = filesystemError(error)
    if (code === 'ENOENT' || code === 'ELOOP' || code === 'EISDIR') return ''
    throw error
  } finally {
    await handle?.close()
  }
}

function frontmatter(text: string): Frontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  if (!match) return {}
  const result: Frontmatter = {}
  for (const line of match[1]!.split(/\r?\n/)) {
    const field = /^\s*(name|description)\s*:\s*(.*?)\s*$/.exec(line)
    if (!field) continue
    const value = field[2]!.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, (_whole, doubleQuoted: string | undefined, singleQuoted: string | undefined) =>
      doubleQuoted ?? singleQuoted ?? ''
    )
    if (field[1] === 'name') result.name = value
    else result.description = value
  }
  return result
}

function tomlDescription(text: string): string | undefined {
  const match = /^\s*description\s*=\s*(["'])(.*?)\1\s*$/m.exec(text)
  return match?.[2]
}

function validInvocation(value: string): boolean {
  return value.length <= 96 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
}

function commandName(path: string, format: 'markdown' | 'toml'): string | null {
  if (extname(path).toLowerCase() !== COMMAND_EXTENSION[format]) return null
  const withoutExtension = path.slice(0, -COMMAND_EXTENSION[format].length)
  const name = withoutExtension.split('/').join(':')
  return validInvocation(name) ? name : null
}

function skillName(path: string, metadataName: string | undefined, prefix: '/' | '$' | '/skill:'): string | null {
  const fromMetadata = metadataName?.trim()
  if (fromMetadata && validInvocation(fromMetadata)) return fromMetadata
  const folder = dirname(path).split('/').join(':')
  if (folder === '.' || !validInvocation(folder)) return null
  return prefix === '$' || prefix === '/skill:' ? basename(folder) : folder
}

function queryText(query: string, agent?: string): string {
  const trimmed = query.trim()
  if (agent === 'omp' && trimmed.toLowerCase().startsWith('/skill:')) {
    return trimmed.slice('/skill:'.length).toLowerCase()
  }
  return trimmed.replace(/^[\/@$]+/, '').toLowerCase()
}

function matches(value: string, query: string): boolean {
  return query === '' || value.toLowerCase().includes(query)
}

function addItem(
  items: Map<string, PickerItem>,
  item: PickerItem,
  query: string,
  searchText: string
): boolean {
  if (!matches(searchText, query)) return false
  const key = `${item.kind}:${item.id}`
  if (items.has(key)) return false
  if (items.size >= MAX_RESULTS) return true
  items.set(key, item)
  return false
}

function cappedItems(items: Map<string, PickerItem>): PickerItem[] {
  return [...items.values()].sort((left, right) => {
    const labelOrder = left.label.localeCompare(right.label)
    return labelOrder || left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id)
  })
}

async function workspaceRoot(context: PluginContext, session: Session): Promise<string> {
  try {
    const workspace = await realpath(session.cwd)
    const info = await lstat(workspace)
    if (!info.isDirectory()) throw context.error('invalid-params', 'session workspace must be an existing directory')
    return workspace
  } catch (error) {
    if (filesystemError(error) === 'ENOENT' || filesystemError(error) === 'ENOTDIR') {
      throw context.error('invalid-params', 'session workspace is unavailable')
    }
    throw error
  }
}

async function fileItems(workspace: string, query: string): Promise<{ items: PickerItem[]; truncated: boolean }> {
  const budget: WalkBudget = { visited: 0, truncated: false }
  const found = new Map<string, PickerItem>()
  await walk({ path: workspace, boundary: workspace }, budget, async ({ relativePath }) => {
    if (!matches(relativePath, query)) return false
    const item: PickerItem = {
      id: `file:${relativePath}`,
      label: relativePath,
      insert: `@${relativePath.split('/').map(encodeURIComponent).join('/')} `,
      kind: 'file'
    }
    return addItem(found, item, query, relativePath)
  })
  return { items: cappedItems(found), truncated: budget.truncated }
}

async function slashItems(
  session: Session,
  cwd: string,
  home: string,
  workspace: string,
  userHome: string,
  query: string,
  environment: OmpEnvironment
): Promise<{ items: PickerItem[]; truncated: boolean }> {
  const layout = layoutFor(
    String(session.agent),
    cwd,
    home,
    workspace,
    userHome,
    environment,
    launchProfile(session.launch?.args ?? '')
  )
  const budget: WalkBudget = { visited: 0, truncated: false }
  const found = new Map<string, PickerItem>()

  for (const commandRoot of layout.commands) {
    await walk(commandRoot.root, budget, async ({ absolutePath, relativePath }) => {
      const name = commandName(relativePath, commandRoot.format)
      if (!name) return false
      const text = await readMetadata(absolutePath)
      const detail = commandRoot.format === 'toml' ? tomlDescription(text) : frontmatter(text).description
      const item: PickerItem = { id: `command:${name}`, label: name, insert: `/${name} `, kind: 'command' }
      if (detail !== undefined && detail !== '') item.detail = detail
      return addItem(found, item, query, `${name} ${detail ?? ''}`)
    })
    if (budget.truncated) break
  }
  for (const command of VERIFIED_COMMANDS[String(session.agent)] ?? []) {
    const item: PickerItem = {
      id: `command:${command.name}`,
      label: command.name,
      insert: `/${command.name} `,
      kind: 'command',
      detail: command.description
    }
    if (addItem(found, item, query, `${command.name} ${command.description}`)) {
      budget.truncated = true
      break
    }
  }

  const customSkillRoots = String(session.agent) === 'omp'
    ? await ompCustomSkillRoots(cwd, home, environment, session.launch?.args ?? '')
    : []
  const skillRoots = [...customSkillRoots, ...layout.skills]
  for (const root of skillRoots) {
    if (budget.truncated) break
    await walk(root, budget, async ({ absolutePath, relativePath }) => {
      if (basename(relativePath) !== 'SKILL.md') return false
      const text = await readMetadata(absolutePath)
      const metadata = frontmatter(text)
      if (layout.requireSkillMetadata === 'description' && !metadata.description?.trim()) return false
      if (layout.requireSkillMetadata === 'name-and-description' && (!metadata.name?.trim() || !metadata.description?.trim())) return false
      const name = skillName(relativePath, metadata.name, layout.skillPrefix)
      if (!name) return false
      const insert = `${layout.skillPrefix}${name} `
      const item: PickerItem = { id: `skill:${name}`, label: name, insert, kind: 'skill' }
      if (metadata.description !== undefined && metadata.description !== '') item.detail = metadata.description
      return addItem(found, item, query, `${name} ${metadata.description ?? ''}`)
    })
  }

  return { items: cappedItems(found), truncated: budget.truncated }
}

/** Discovers read-only agent commands, local skills or workspace files for the terminal picker. */
export async function pickItems(
  context: PluginContext,
  session: Session,
  kind: 'slash' | 'file',
  query: string
): Promise<{ items: PickerItem[]; truncated: boolean }> {
  if (typeof query !== 'string') throw context.error('invalid-params', 'query must be a string')
  const workspace = await workspaceRoot(context, session)
  if (kind === 'file') return fileItems(workspace, queryText(query))

  const environment: OmpEnvironment = { ...process.env, ...(session.launch?.env ?? {}) }
  const configuredHome = environment.HOME?.trim()
  const home = configuredHome && isAbsolute(configuredHome) ? resolve(configuredHome) : homedir()
  let userHome: string
  try {
    userHome = await realpath(home)
  } catch {
    throw context.error('invalid-params', 'agent home directory is unavailable')
  }
  const cwd = session.cwd
  return slashItems(session, cwd, home, workspace, userHome, queryText(query, String(session.agent)), environment)
}
