import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import type { Dirent, Stats } from 'node:fs'
import { extname, join, relative, resolve, sep } from 'node:path'
import type { UiModel, UiSlotEntry } from '@quirky/protocol'
import { discoverCaptureTargets } from '../ui-review/capture'
import type { CaptureTarget } from '../ui-review/contracts'
import type { CliCommandDeclaration, Evidence, Exclusion, Inventory, PluginContributions, PluginInventory, SourceFile } from './contracts'

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs', '.html', '.htm', '.svg', '.css', '.scss', '.sass', '.less'])
const EXCLUDED_DIRECTORIES = new Set(['node_modules', 'vendor', 'dist', 'build', 'coverage', '.git', 'test', 'tests', '__tests__', '__test__', '_test', '_tests', 'fixture', 'fixtures', '__fixtures__', '_fixtures'])
const SLOT_KINDS: readonly UiSlotEntry['kind'][] = ['view', 'panel', 'sidebar-section', 'activity-item', 'status-bar', 'overlay', 'settings-section']
const LEGACY_COMPATIBILITY_DEFINITION = 'packages/ui/src/design-system/compatibility-tokens.css'
const AVATAR_EXCLUSION: Exclusion = { plugin: 'quirky.avatar', reason: 'paused-unmerged', branch: 'zpyoung/avatar-plugin', pr: 305, steerDate: '2026-11-13' }
const PLUGIN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const COVERAGE_FRAGMENT_NAME = /^[a-z0-9][a-z0-9-]*\.json$/

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function pathFromRoot(repoRoot: string, absolutePath: string): string {
  return relative(repoRoot, absolutePath).split(sep).join('/')
}

function evidence(code: string, message: string): Evidence {
  return { code, message }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function shouldSkipPath(path: string): boolean {
  const parts = path.split(/[\\/]/)
  if (parts.some((part) => EXCLUDED_DIRECTORIES.has(part.toLowerCase()))) return true
  const file = parts.at(-1) ?? ''
  return /(?:^|[.-])(?:test|spec|fixture|fixtures)\.[^.]+$/i.test(file)
}

function isProductionSource(path: string): boolean {
  return !shouldSkipPath(path) && SOURCE_EXTENSIONS.has(extname(path).toLowerCase())
}

function snapshotDigest(files: ReadonlyMap<string, string>): string {
  const hash = createHash('sha256')
  for (const [file, content] of [...files].sort(([left], [right]) => compareText(left, right))) {
    const pathBytes = Buffer.from(file, 'utf8')
    const contentBytes = Buffer.from(content, 'utf8')
    hash.update(String(pathBytes.byteLength))
    hash.update(':')
    hash.update(pathBytes)
    hash.update(':')
    hash.update(String(contentBytes.byteLength))
    hash.update(':')
    hash.update(contentBytes)
    hash.update('\n')
  }
  return hash.digest('hex')
}

function readProductionTree(
  root: string,
  repoRoot: string,
  snapshots: Map<string, string>,
  failures: Evidence[]
): SourceFile[] {
  const rootFile = pathFromRoot(repoRoot, root)
  try {
    const rootStat = lstatSync(root)
    if (rootStat.isSymbolicLink()) {
      failures.push(evidence('source-symlink', `Production source root is a symlink at ${rootFile}`))
      snapshots.set(rootFile, '[symlink]')
      return []
    }
    if (!rootStat.isDirectory()) {
      failures.push(evidence('source-unreadable', `Production source root is not a directory: ${rootFile}`))
      snapshots.set(rootFile, '[unreadable]')
      return []
    }
  } catch (error) {
    failures.push(evidence('source-unreadable', `Cannot inspect production source root ${rootFile}: ${errorMessage(error)}`))
    snapshots.set(rootFile, '[unreadable]')
    return []
  }
  const sources: SourceFile[] = []
  const visit = (directory: string, relativeDirectory: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) => compareText(left.name, right.name))
    } catch (error) {
      const file = pathFromRoot(repoRoot, directory)
      const message = `Cannot read production source directory ${file}: ${errorMessage(error)}`
      failures.push(evidence('source-unreadable', message))
      snapshots.set(file, '[unreadable]')
      return
    }

    for (const entry of entries) {
      const childRelative = relativeDirectory ? join(relativeDirectory, entry.name) : entry.name
      if (relativeDirectory.length === 0 && (entry.name === 'ui-scoreboard.json' || entry.name === 'ui-scoreboard')) continue
      if (shouldSkipPath(childRelative)) continue
      const absolute = join(directory, entry.name)
      const file = pathFromRoot(repoRoot, absolute)
      if (entry.isSymbolicLink()) {
        failures.push(evidence('source-symlink', `Production source tree contains a symlink at ${file}`))
        snapshots.set(file, '[symlink]')
        continue
      }
      if (entry.isDirectory()) {
        visit(absolute, childRelative)
        continue
      }
      if (entry.isFile()) {
        if (!SOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue
        try {
          const content = readFileSync(absolute, 'utf8')
          sources.push({ file, content })
          snapshots.set(file, content)
        } catch (error) {
          failures.push(evidence('source-unreadable', `Cannot read production source ${file}: ${errorMessage(error)}`))
          snapshots.set(file, '[unreadable]')
        }
        continue
      }
      if (SOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        failures.push(evidence('source-unreadable', `Production source is not a readable regular file: ${file}`))
        snapshots.set(file, '[unreadable]')
      }
    }
  }

  visit(root, '')
  return sources.sort((left, right) => compareText(left.file, right.file))
}

function readCoverageFile(
  repoRoot: string,
  directory: string,
  hasUi: boolean,
  targets: readonly string[],
  snapshots: Map<string, string>,
  failures: Evidence[]
): SourceFile | undefined {
  const absolute = join(repoRoot, 'plugins', directory, 'ui-scoreboard.json')
  const file = pathFromRoot(repoRoot, absolute)
  let stat: Stats
  try {
    stat = lstatSync(absolute)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    failures.push(evidence('plugin-coverage-unreadable', `Cannot inspect plugin coverage file ${file}: ${errorMessage(error)}`))
    snapshots.set(file, '[unreadable]')
    return undefined
  }

  if (!hasUi && targets.length === 0) {
    failures.push(evidence('unexpected-coverage-file', `Coverage file has no UI entry or targets in ${file}`))
  }
  if (stat.isSymbolicLink()) {
    failures.push(evidence('source-symlink', `Plugin coverage file is a symlink: ${file}`))
    snapshots.set(file, '[symlink]')
    return undefined
  }
  if (!stat.isFile()) {
    failures.push(evidence('invalid-coverage-file', `Plugin coverage path is not a regular file: ${file}`))
    snapshots.set(file, '[unreadable]')
    return undefined
  }

  try {
    const content = readFileSync(absolute, 'utf8')
    snapshots.set(file, content)
    return { file, content }
  } catch (error) {
    failures.push(evidence('plugin-coverage-unreadable', `Cannot read plugin coverage file ${file}: ${errorMessage(error)}`))
    snapshots.set(file, '[unreadable]')
    return undefined
  }
}

function readCoverageFragments(
  repoRoot: string,
  directory: string,
  hasUi: boolean,
  targets: readonly string[],
  snapshots: Map<string, string>,
  failures: Evidence[]
): SourceFile[] | undefined {
  const absolute = join(repoRoot, 'plugins', directory, 'ui-scoreboard')
  const file = pathFromRoot(repoRoot, absolute)
  let stat: Stats
  try {
    stat = lstatSync(absolute)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    failures.push(evidence('plugin-coverage-unreadable', `Cannot inspect plugin coverage directory ${file}: ${errorMessage(error)}`))
    snapshots.set(file, '[unreadable]')
    return undefined
  }

  if (!hasUi && targets.length === 0) {
    failures.push(evidence('unexpected-coverage-file', `Coverage directory has no UI entry or targets in ${file}`))
  }
  if (stat.isSymbolicLink()) {
    failures.push(evidence('source-symlink', `Plugin coverage directory is a symlink: ${file}`))
    snapshots.set(file, '[symlink]')
    return undefined
  }
  if (!stat.isDirectory()) {
    failures.push(evidence('invalid-coverage-file', `Plugin coverage path is not a directory: ${file}`))
    snapshots.set(file, '[unreadable]')
    return undefined
  }

  let entries: Dirent[]
  try {
    entries = readdirSync(absolute, { withFileTypes: true }).sort((left, right) => compareText(left.name, right.name))
  } catch (error) {
    failures.push(evidence('plugin-coverage-unreadable', `Cannot read plugin coverage directory ${file}: ${errorMessage(error)}`))
    snapshots.set(file, '[unreadable]')
    return []
  }

  const fragments: SourceFile[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const entryAbsolute = join(absolute, entry.name)
    const entryFile = pathFromRoot(repoRoot, entryAbsolute)
    let entryStat: Stats
    try {
      entryStat = lstatSync(entryAbsolute)
    } catch (error) {
      failures.push(evidence('plugin-coverage-unreadable', `Cannot inspect plugin coverage entry ${entryFile}: ${errorMessage(error)}`))
      snapshots.set(entryFile, '[unreadable]')
      continue
    }

    if (entryStat.isSymbolicLink()) {
      failures.push(evidence('source-symlink', `Plugin coverage entry is a symlink: ${entryFile}`))
      snapshots.set(entryFile, '[symlink]')
      continue
    }
    if (!entryStat.isFile() || !COVERAGE_FRAGMENT_NAME.test(entry.name)) {
      failures.push(evidence('invalid-coverage-file', `Plugin coverage entry must be a regular lowercase .json fragment file: ${entryFile}`))
      snapshots.set(entryFile, '[unreadable]')
      continue
    }

    try {
      const content = readFileSync(entryAbsolute, 'utf8')
      snapshots.set(entryFile, content)
      fragments.push({ file: entryFile, content })
    } catch (error) {
      failures.push(evidence('plugin-coverage-unreadable', `Cannot read plugin coverage fragment ${entryFile}: ${errorMessage(error)}`))
      snapshots.set(entryFile, '[unreadable]')
    }
  }
  return fragments
}


function fullMethodId(pluginId: string, methodId: string): string {
  return methodId.includes('/') ? methodId : `${pluginId}/${methodId}`
}

function contributionMethodIds(pluginId: string, entries: unknown): string[] {
  if (!Array.isArray(entries)) return []
  const ids: string[] = []
  for (const rawEntry of entries) {
    const id = record(rawEntry)?.id
    if (typeof id === 'string' && id.trim().length > 0) ids.push(fullMethodId(pluginId, id))
  }
  return ids
}

function parsePluginContributions(pluginId: string, contributions: Record<string, unknown> | undefined): PluginContributions {
  const rawCommands = contributions?.command
  const commands = Array.isArray(rawCommands)
    ? rawCommands.flatMap((rawEntry) => {
      const id = record(rawEntry)?.id
      return typeof id === 'string' && id.trim().length > 0 ? [`command:${pluginId}/${id}`] : []
    })
    : []
  const cliCommands: CliCommandDeclaration[] = []
  const rawCliCommands = contributions?.['cli-command']
  if (Array.isArray(rawCliCommands)) {
    for (const rawEntry of rawCliCommands) {
      const entry = record(rawEntry)
      if (entry === undefined) continue
      const id = entry.id
      if (typeof id !== 'string' || id.trim().length === 0) continue
      const rawMethods = Array.isArray(entry.methods)
        ? entry.methods
        : typeof entry.method === 'string' ? [entry.method] : []
      const methods = rawMethods
        .filter((method): method is string => typeof method === 'string' && method.trim().length > 0)
        .map((method) => fullMethodId(pluginId, method))
      cliCommands.push({
        id,
        ...(typeof entry.words === 'string' ? { words: entry.words } : {}),
        methods
      })
    }
  }
  return {
    methods: contributionMethodIds(pluginId, contributions?.method),
    commands,
    cliCommands
  }
}

function gitEnvironment(repoRoot: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: repoRoot,
    QUIRKY_HOME: repoRoot,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1'
  }
}

function runGit(repoRoot: string, args: string[]): { exitCode: number; stdout: string; stderr: string } {
  try {
    const result = Bun.spawnSync(['git', ...args], { cwd: repoRoot, env: gitEnvironment(repoRoot) })
    return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
  } catch (error) {
    return { exitCode: 1, stdout: '', stderr: errorMessage(error) }
  }
}

function gitText(repoRoot: string, args: string[]): string | undefined {
  const result = runGit(repoRoot, args)
  return result.exitCode === 0 ? result.stdout.trim() : undefined
}

function productionPath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/')
  const parts = normalized.split('/')
  if (parts[0] === 'plugins' && parts.length >= 3) {
    if (parts[2] === 'ui-scoreboard') return true
    if (parts.length === 3 && (parts[2] === 'quirky-plugin.json' || parts[2] === 'ui-scoreboard.json')) return true
    return isProductionSource(parts.slice(2).join('/'))
  }
  if ((parts[0] === 'packages' || parts[0] === 'apps') && parts.length >= 4 && parts[2] === 'src') {
    return isProductionSource(parts.slice(3).join('/'))
  }
  return false
}

function collectDirty(repoRoot: string, failures: Evidence[]): boolean {
  const changed = runGit(repoRoot, ['diff', '--name-only', '--no-renames', '-z', 'HEAD'])
  const untracked = runGit(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z'])
  if (changed.exitCode !== 0 || untracked.exitCode !== 0) {
    const message = changed.exitCode !== 0 ? changed.stderr.trim() : untracked.stderr.trim()
    failures.push(evidence('git-source-status', `Cannot determine production source changes: ${message || 'git command failed'}`))
    return false
  }
  const paths = [...changed.stdout.split('\0'), ...untracked.stdout.split('\0')]
  return paths.some((path) => path.length > 0 && productionPath(path))
}

function makeUiModel(): { model: UiModel; slots: Record<UiSlotEntry['kind'], UiSlotEntry[]> } {
  const model: UiModel = {
    sidebarSections: [], statusBars: [], activityItems: [], panels: [], settingsSections: [], views: [], overlays: [],
    commands: [], keybindings: [], settings: [], menuItems: [], themes: [],
    theme: { chosen: 'default', active: 'default' }, modules: {}
  }
  return {
    model,
    slots: {
      view: model.views,
      panel: model.panels,
      'sidebar-section': model.sidebarSections,
      'activity-item': model.activityItems,
      'status-bar': model.statusBars,
      overlay: model.overlays,
      'settings-section': model.settingsSections
    }
  }
}

function parseManifest(
  repoRoot: string,
  manifestPath: string,
  directory: string,
  raw: string,
  snapshots: Map<string, string>,
  failures: Evidence[],
  slotEntries: Record<UiSlotEntry['kind'], UiSlotEntry[]>,
  targetIds: Map<string, string[]>,
  seenTargetIds: Set<string>
): PluginInventory {
  const file = pathFromRoot(repoRoot, manifestPath)
  snapshots.set(file, raw)
  let manifest: Record<string, unknown> | undefined
  try {
    manifest = record(JSON.parse(raw))
    if (manifest === undefined) throw new Error('expected a JSON object')
  } catch (error) {
    failures.push(evidence('invalid-plugin-manifest', `Cannot parse ${file}: ${errorMessage(error)}`))
  }
  if (manifest === undefined) {
    const coverage = readCoverageFile(repoRoot, directory, false, [], snapshots, failures)
    const coverageFragments = readCoverageFragments(repoRoot, directory, false, [], snapshots, failures)
    return {
      id: directory,
      directory: `plugins/${directory}`,
      hasUi: false,
      targets: [],
      sources: [],
      ...(coverage === undefined ? {} : { coverage }),
      ...(coverageFragments === undefined ? {} : { coverageFragments })
    }
  }

  const declaredId = manifest?.id
  const id = typeof declaredId === 'string' && PLUGIN_ID.test(declaredId) ? declaredId : directory
  if (typeof declaredId !== 'string' || !PLUGIN_ID.test(declaredId)) {
    failures.push(evidence('invalid-plugin-id', `Plugin manifest has an invalid id in ${file}`))
  } else if (declaredId !== directory) {
    failures.push(evidence('plugin-directory-mismatch', `Plugin manifest id ${declaredId} does not match directory ${directory}`))
  }

  const uiValue = manifest?.ui
  const hasUi = typeof uiValue === 'string' && uiValue.trim().length > 0
  if (uiValue !== undefined && !hasUi) failures.push(evidence('invalid-plugin-ui', `Plugin UI entry must be a non-empty string in ${file}`))

  const contributions = manifest?.contributes
  if (contributions !== undefined && record(contributions) === undefined) {
    failures.push(evidence('invalid-render-contributions', `Plugin render contributions must be an object in ${file}`))
  }
  const contributionRecord = record(contributions)
  for (const kind of SLOT_KINDS) {
    const entries = contributionRecord?.[kind]
    if (entries === undefined) continue
    if (!Array.isArray(entries)) {
      failures.push(evidence('invalid-render-contributions', `Contribution ${kind} must be an array in ${file}`))
      continue
    }
    for (const rawEntry of entries) {
      const entry = record(rawEntry)
      const entryId = entry?.id
      if (typeof entryId !== 'string' || entryId.trim().length === 0) {
        failures.push(evidence('invalid-render-contribution-id', `Contribution ${kind} has an invalid id in ${file}`))
        continue
      }
      const targetId = `${kind}:${id}/${entryId}`
      if (seenTargetIds.has(targetId)) {
        failures.push(evidence('duplicate-target-id', `Duplicate UI capture target ID ${targetId}`))
        continue
      }
      seenTargetIds.add(targetId)
      const order = typeof entry?.order === 'number' ? entry.order : 100
      const title = typeof entry?.title === 'string' ? entry.title : entryId
      slotEntries[kind].push({ id: targetId, plugin: id, kind, title, order, module: null })
      const pluginTargets = targetIds.get(id) ?? []
      pluginTargets.push(targetId)
      targetIds.set(id, pluginTargets)
    }
  }

  const pluginTargets = targetIds.get(id) ?? []
  const pluginContributions = parsePluginContributions(id, contributionRecord)
  const coverage = readCoverageFile(repoRoot, directory, hasUi, pluginTargets, snapshots, failures)
  const coverageFragments = readCoverageFragments(repoRoot, directory, hasUi, pluginTargets, snapshots, failures)
  return {
    id,
    directory: `plugins/${directory}`,
    hasUi,
    targets: pluginTargets,
    sources: [],
    contributions: pluginContributions,
    ...(coverage === undefined ? {} : { coverage }),
    ...(coverageFragments === undefined ? {} : { coverageFragments })
  }
}


function discoverPlugins(
  repoRoot: string,
  snapshots: Map<string, string>,
  failures: Evidence[]
): { plugins: PluginInventory[]; targetIds: Map<string, string[]>; model: UiModel; discoveryComplete: boolean; avatarPresent: boolean } {
  const pluginsRoot = join(repoRoot, 'plugins')
  const { model, slots } = makeUiModel()
  const plugins: PluginInventory[] = []
  const targetIds = new Map<string, string[]>()
  const seenTargetIds = new Set<string>()
  let entries: Dirent[]
  try {
    const rootStat = lstatSync(pluginsRoot)
    if (rootStat.isSymbolicLink()) {
      failures.push(evidence('source-symlink', 'Immediate plugin root is a symlink: plugins'))
      return { plugins, targetIds, model, discoveryComplete: false, avatarPresent: false }
    }
    if (!rootStat.isDirectory()) throw new Error('Immediate plugin root is not a directory')
    entries = readdirSync(pluginsRoot, { withFileTypes: true }).sort((left, right) => compareText(left.name, right.name))
  } catch (error) {
    failures.push(evidence('plugin-discovery-failed', `Cannot read immediate plugin directory plugins: ${errorMessage(error)}`))
    return { plugins, targetIds, model, discoveryComplete: false, avatarPresent: false }
  }

  let avatarPresent = false
  for (const entry of entries) {
    if (entry.name === 'quirky.avatar' && (entry.isDirectory() || entry.isSymbolicLink())) {
      const avatarManifest = join(pluginsRoot, entry.name, 'quirky-plugin.json')
      try {
        lstatSync(avatarManifest)
        avatarPresent = true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') avatarPresent = true
      }
    }
    if (entry.isSymbolicLink()) {
      failures.push(evidence('source-symlink', `Immediate plugin directory is a symlink: plugins/${entry.name}`))
      if (entry.name !== 'quirky.avatar' || avatarPresent) {
        plugins.push({ id: entry.name, directory: `plugins/${entry.name}`, hasUi: false, targets: [], sources: [] })
      }
      continue
    }
    if (!entry.isDirectory()) continue

    const directoryRoot = join(pluginsRoot, entry.name)
    const manifestPath = join(directoryRoot, 'quirky-plugin.json')
    let manifestStat: Stats
    try {
      manifestStat = lstatSync(manifestPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      failures.push(evidence('plugin-manifest-unreadable', `Cannot inspect plugin manifest plugins/${entry.name}/quirky-plugin.json: ${errorMessage(error)}`))
      plugins.push({ id: entry.name, directory: `plugins/${entry.name}`, hasUi: false, targets: [], sources: [] })
      continue
    }
    if (entry.name === 'quirky.avatar') avatarPresent = true
    if (manifestStat.isSymbolicLink()) {
      const file = `plugins/${entry.name}/quirky-plugin.json`
      failures.push(evidence('source-symlink', `Plugin manifest is a symlink: ${file}`))
      snapshots.set(file, '[symlink]')
      plugins.push({ id: entry.name, directory: `plugins/${entry.name}`, hasUi: false, targets: [], sources: [] })
      continue
    }
    if (!manifestStat.isFile()) {
      failures.push(evidence('invalid-plugin-manifest', `Plugin manifest is not a regular file: plugins/${entry.name}/quirky-plugin.json`))
      plugins.push({ id: entry.name, directory: `plugins/${entry.name}`, hasUi: false, targets: [], sources: [] })
      continue
    }

    let raw: string
    try {
      raw = readFileSync(manifestPath, 'utf8')
    } catch (error) {
      const file = `plugins/${entry.name}/quirky-plugin.json`
      failures.push(evidence('plugin-manifest-unreadable', `Cannot read plugin manifest ${file}: ${errorMessage(error)}`))
      snapshots.set(file, '[unreadable]')
      plugins.push({ id: entry.name, directory: `plugins/${entry.name}`, hasUi: false, targets: [], sources: [] })
      continue
    }
    plugins.push(parseManifest(repoRoot, manifestPath, entry.name, raw, snapshots, failures, slots, targetIds, seenTargetIds))
  }

  for (const kind of SLOT_KINDS) {
    slots[kind].sort((left, right) => left.order - right.order || compareText(left.id, right.id))
  }
  return { plugins, targetIds, model, discoveryComplete: true, avatarPresent }
}

function scanWorkspaceSources(repoRoot: string, snapshots: Map<string, string>, failures: Evidence[]): void {
  for (const workspace of ['packages', 'apps']) {
    const workspaceRoot = join(repoRoot, workspace)
    let entries: Dirent[]
    try {
      const workspaceStat = lstatSync(workspaceRoot)
      if (workspaceStat.isSymbolicLink()) {
        const file = pathFromRoot(repoRoot, workspaceRoot)
        failures.push(evidence('source-symlink', `Production source workspace is a symlink at ${file}`))
        snapshots.set(file, '[symlink]')
        continue
      }
      if (!workspaceStat.isDirectory()) throw new Error(`${workspace} source workspace is not a directory`)
      entries = readdirSync(workspaceRoot, { withFileTypes: true }).sort((left, right) => compareText(left.name, right.name))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && workspace === 'apps') continue
      failures.push(evidence('source-unreadable', `Cannot read production source workspace ${workspace}: ${errorMessage(error)}`))
      continue
    }
    for (const entry of entries) {
      if (EXCLUDED_DIRECTORIES.has(entry.name.toLowerCase())) continue
      const packagePath = join(workspaceRoot, entry.name)
      const srcPath = join(packagePath, 'src')
      if (entry.isSymbolicLink()) {
        failures.push(evidence('source-symlink', `Production source workspace contains a symlink at ${pathFromRoot(repoRoot, packagePath)}`))
        snapshots.set(pathFromRoot(repoRoot, packagePath), '[symlink]')
        continue
      }
      if (!entry.isDirectory()) continue
      let srcStat: Stats
      try {
        srcStat = lstatSync(srcPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        failures.push(evidence('source-unreadable', `Cannot inspect production source root ${pathFromRoot(repoRoot, srcPath)}: ${errorMessage(error)}`))
        snapshots.set(pathFromRoot(repoRoot, srcPath), '[unreadable]')
        continue
      }
      if (srcStat.isSymbolicLink()) {
        const file = pathFromRoot(repoRoot, srcPath)
        failures.push(evidence('source-symlink', `Production source root is a symlink at ${file}`))
        snapshots.set(file, '[symlink]')
      } else if (srcStat.isDirectory()) {
        readProductionTree(srcPath, repoRoot, snapshots, failures)
      } else {
        failures.push(evidence('source-unreadable', `Production source root is not a directory: ${pathFromRoot(repoRoot, srcPath)}`))
      }
    }
  }

  const uiSourceRoot = join(repoRoot, 'packages/ui/src')
  try {
    const stat = lstatSync(uiSourceRoot)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      failures.push(evidence('source-unreadable', 'Required shared UI source root is not a directory: packages/ui/src'))
    }
  } catch (error) {
    failures.push(evidence('source-unreadable', `Required shared UI source root is unavailable: ${errorMessage(error)}`))
  }
}

/** Collects plugin surfaces and a source snapshot for one scoreboard run. */
export function collectInventory(repoRoot: string): Inventory {
  const root = resolve(repoRoot)
  const failures: Evidence[] = []
  const snapshots = new Map<string, string>()
  const discovered = discoverPlugins(root, snapshots, failures)
  if (discovered.avatarPresent) failures.push(evidence('paused-plugin-present', 'Paused plugin quirky.avatar is present in the scanned repository'))

  if (discovered.plugins.length === 0) failures.push(evidence('empty-plugin-inventory', 'No immediate plugin manifests were discovered'))
  const ids = new Set<string>()
  for (const plugin of discovered.plugins) {
    if (ids.has(plugin.id)) failures.push(evidence('duplicate-plugin-id', `Duplicate plugin ID ${plugin.id}`))
    ids.add(plugin.id)
    const sourceRoot = join(root, plugin.directory)
    plugin.sources = readProductionTree(sourceRoot, root, snapshots, failures)
    plugin.targets = (discovered.targetIds.get(plugin.id) ?? []).slice().sort(compareText)
  }

  scanWorkspaceSources(root, snapshots, failures)
  const sharedSources = [...snapshots]
    .filter(([file, content]) => file.startsWith('packages/ui/src/') && file !== LEGACY_COMPATIBILITY_DEFINITION && content !== '[unreadable]' && content !== '[symlink]')
    .map(([file, content]) => ({ file, content }))
    .sort((left, right) => compareText(left.file, right.file))

  const commitResult = gitText(root, ['rev-parse', 'HEAD'])
  const commit = commitResult ?? ''
  if (commitResult === undefined) failures.push(evidence('git-commit-unavailable', 'Cannot determine repository commit with git rev-parse HEAD'))
  const dirty = collectDirty(root, failures)

  return {
    repoRoot: root,
    commit,
    sourceDigest: snapshotDigest(snapshots),
    dirty,
    plugins: discovered.plugins.sort((left, right) => compareText(left.id, right.id)),
    targets: discoverTargets(discovered.model, failures),
    sharedSources,
    exclusions: discovered.discoveryComplete && !discovered.avatarPresent ? [AVATAR_EXCLUSION] : [],
    failures
  }
}

function discoverTargets(model: UiModel, failures: Evidence[]): CaptureTarget[] {
  try {
    return discoverCaptureTargets(model)
  } catch (error) {
    failures.push(evidence('invalid-capture-targets', errorMessage(error)))
    const empty = makeUiModel().model
    return discoverCaptureTargets(empty)
  }
}
