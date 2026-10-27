import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { hookCommand } from '../hook-command.ts'
import { InstallError, type InstallEnv, type Installer } from '../types.ts'
import { claudeDefinition } from './claude-json.ts'
import { REAL_HOME_SKIPPED, dirOverride, isRealHomeInTest, serializeJson, tildePath, writeFileAtomic } from './common.ts'
import { assertNoForeign, ownedStatus, removeOwned, writeOwned, type OwnedFile } from './files-owned.ts'
import { commitParts, findRegion, readText, snapshot, splitText, type TextLines } from './files-region.ts'
import { HERMES_PLUGIN_NAME, hermesInitSource, hermesManifest } from './sources/hermes.ts'
import { YamlShapeError, enablePlugin, readEnablement, restoreConfig } from './yaml-lines.ts'

const DSH_START = '# >>> quirky-managed-dsh-hooks'
const DSH_END = '# <<< quirky-managed-dsh-hooks'
const DSH_EMPTY_NOTE = '# quirky: the file held an empty sequence ([]) before install'
const DSH_ROW_ID = 'quirky-agent-hooks'
const DSH_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']

function dshPatchPath(target: InstallEnv): string {
  return join(dirOverride(target.env.DSH_HOME, join(target.home, '.dsh')), 'cordis.patch.yml')
}

function dshHooksPath(target: InstallEnv): string {
  return join(target.quirkyHome, 'agent-hooks', 'dsh-hooks.json')
}

function dshHooksText(): string {
  const hooks = Object.fromEntries(DSH_EVENTS.map((event) => [event, [claudeDefinition(hookCommand('dsh'), {})]]))
  return serializeJson({ hooks })
}

function yamlQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function dshBlock(hooksPath: string, replacedEmptySequence: boolean): string[] {
  return [
    DSH_START,
    ...(replacedEmptySequence ? [DSH_EMPTY_NOTE] : []),
    '- insert:',
    `    - id: ${DSH_ROW_ID}`,
    "      name: '@deepseek-ai/dsh-hooks-claude-code'",
    '      config:',
    `        configPath: ${yamlQuote(hooksPath)}`,
    DSH_END
  ]
}

const isBodyLine = (line: string): boolean => line.trim() !== '' && !line.trim().startsWith('#')

const withoutComment = (line: string): string => {
  const hash = line.indexOf('#')
  return (hash === -1 ? line : line.slice(0, hash)).trim()
}

function isEmptyFlowSequence(lines: readonly string[]): boolean {
  const body = lines.filter(isBodyLine)
  return body.length === 1 && withoutComment(body[0]!) === '[]'
}

const unparseableDsh = (path: string, home: string): InstallError => new InstallError(`Could not parse ${tildePath(path, home)}`)

/** The patch file's rows; throws InstallError unless the text is valid YAML holding a sequence (or nothing). */
function dshRows(lines: readonly string[], path: string, home: string): unknown[] {
  let document: unknown
  try {
    document = Bun.YAML.parse(lines.join('\n'))
  } catch {
    throw unparseableDsh(path, home)
  }
  if (document === null) return []
  if (!Array.isArray(document)) throw unparseableDsh(path, home)
  return document
}

const isQuirkyRow = (row: unknown): boolean =>
  typeof row === 'object' && row !== null && Array.isArray((row as { insert?: unknown }).insert) && (row as { insert: unknown[] }).insert.some((entry) => (entry as { id?: unknown } | null)?.id === DSH_ROW_ID)

/** Refuses an edit whose result parses to anything but the original rows plus Quirky's own entry, e.g. an appended entry that lands in a second YAML document. */
function assertDshEdit(before: readonly string[], after: readonly string[], path: string, home: string): void {
  const kept = (lines: readonly string[]): unknown[] => dshRows(lines, path, home).filter((row) => !isQuirkyRow(row))
  if (!isDeepStrictEqual(kept(before), kept(after))) throw unparseableDsh(path, home)
}

/** dsh's patch file is a YAML sequence: appending an entry to a flow sequence, or to a mapping, would break it. */
function assertDshShape(lines: readonly string[], path: string, home: string): void {
  const fail = (): never => {
    throw unparseableDsh(path, home)
  }
  dshRows(lines, path, home)
  const body = lines.filter(isBodyLine)
  if (body.length === 0 || isEmptyFlowSequence(lines)) return
  if (body[0]!.trimStart().startsWith('[')) fail()
  for (const line of body) {
    if (/^\s*\t/.test(line)) fail()
    if (line.length - line.trimStart().length > 0 || /^-(\s|$)/.test(line) || /^(---|\.\.\.)\s*$/.test(line)) continue
    fail()
  }
}

function readDsh(path: string, home: string): { text: string | null; parts: TextLines } {
  const text = readText(path, home)
  const parts = splitText(text ?? '')
  assertDshShape(parts.lines, path, home)
  return { text, parts }
}

/**
 * dsh composes a home-level `cordis.patch.yml` over every profile. Quirky owns one marked entry
 * in it that points dsh's Claude-hook bridge at a hooks file Quirky generates.
 */
export const dshInstaller: Installer = {
  agent: 'dsh',
  source: 'dsh',
  files: (target) => [dshPatchPath(target), dshHooksPath(target)],
  install(target) {
    if (isRealHomeInTest(target.home)) return { changed: [], message: REAL_HOME_SKIPPED }
    const patchPath = dshPatchPath(target)
    const hooksPath = dshHooksPath(target)
    const { text, parts } = readDsh(patchPath, target.home)
    const original = snapshot(parts)
    const region = findRegion(parts.lines, DSH_START, DSH_END)
    if (region) {
      const wasEmpty = parts.lines.slice(region.start, region.end).includes(DSH_EMPTY_NOTE)
      parts.lines.splice(region.start, region.end - region.start + 1, ...dshBlock(hooksPath, wasEmpty))
    } else {
      const wasEmpty = isEmptyFlowSequence(parts.lines)
      if (wasEmpty) {
        // `- entry` after `[]` is a parse error, so the token goes and remove puts it back
        parts.lines = parts.lines.flatMap((line) => {
          if (withoutComment(line) !== '[]') return [line]
          return line.trim() === '[]' ? [] : [line.replace('[]', '')]
        })
      }
      parts.lines.push(...dshBlock(hooksPath, wasEmpty))
      parts.finalNewline = true
    }
    assertDshEdit(original.lines, parts.lines, patchPath, target.home)
    const hooksText = dshHooksText()
    const hooksChanged = !existsSync(hooksPath) || readFileSync(hooksPath, 'utf8') !== hooksText
    if (hooksChanged) writeFileAtomic(hooksPath, hooksText)
    const patchChanged = commitParts(patchPath, text, original, parts)
    return { changed: [...(patchChanged ? [patchPath] : []), ...(hooksChanged ? [hooksPath] : [])] }
  },
  remove(target) {
    if (isRealHomeInTest(target.home)) return { changed: [], message: REAL_HOME_SKIPPED }
    const patchPath = dshPatchPath(target)
    const hooksPath = dshHooksPath(target)
    const { text, parts } = readDsh(patchPath, target.home)
    const region = findRegion(parts.lines, DSH_START, DSH_END)
    let patchChanged = false
    if (region) {
      const original = snapshot(parts)
      const wasEmpty = parts.lines.slice(region.start, region.end).includes(DSH_EMPTY_NOTE)
      parts.lines.splice(region.start, region.end - region.start + 1)
      if (wasEmpty) parts.lines.push('[]')
      assertDshEdit(original.lines, parts.lines, patchPath, target.home)
      patchChanged = commitParts(patchPath, text, original, parts)
    }
    const hooksChanged = existsSync(hooksPath)
    if (hooksChanged) rmSync(hooksPath, { force: true })
    return { changed: [...(patchChanged ? [patchPath] : []), ...(hooksChanged ? [hooksPath] : [])] }
  },
  status(target) {
    try {
      const { parts } = readDsh(dshPatchPath(target), target.home)
      const hooksPath = dshHooksPath(target)
      const region = findRegion(parts.lines, DSH_START, DSH_END)
      if (!region || !existsSync(hooksPath) || readFileSync(hooksPath, 'utf8') !== dshHooksText()) return 'not-installed'
      const wasEmpty = parts.lines.slice(region.start, region.end).includes(DSH_EMPTY_NOTE)
      const found = parts.lines.slice(region.start, region.end + 1).map((line) => line.trim())
      return found.join('\n') === dshBlock(hooksPath, wasEmpty).map((line) => line.trim()).join('\n') ? 'installed' : 'not-installed'
    } catch (error) {
      if (error instanceof InstallError) return { error: error.message }
      throw error
    }
  }
}

function hermesHome(target: InstallEnv): string {
  return dirOverride(target.env.HERMES_HOME, join(target.home, '.hermes'))
}

function hermesConfigPath(target: InstallEnv): string {
  return join(hermesHome(target), 'config.yaml')
}

function hermesPluginDir(target: InstallEnv): string {
  return join(hermesHome(target), 'plugins', HERMES_PLUGIN_NAME)
}

function hermesPluginFiles(target: InstallEnv): OwnedFile[] {
  const dir = hermesPluginDir(target)
  return [
    { path: join(dir, 'plugin.yaml'), content: hermesManifest() },
    { path: join(dir, '__init__.py'), content: hermesInitSource() }
  ]
}

function unreadableConfig(path: string, home: string): InstallError {
  return new InstallError(`Could not parse ${tildePath(path, home)}`)
}

/**
 * Hermes loads a plugin directory named in `plugins.enabled` of its `config.yaml`. The directory
 * is Quirky's; the config is edited line by line and restored on remove.
 */
export const hermesInstaller: Installer = {
  agent: 'hermes',
  source: 'hermes',
  files: (target) => [...hermesPluginFiles(target).map((file) => file.path), hermesConfigPath(target)],
  install(target) {
    if (isRealHomeInTest(target.home)) return { changed: [], message: REAL_HOME_SKIPPED }
    const configPath = hermesConfigPath(target)
    const text = readText(configPath, target.home)
    const parts = splitText(text ?? '')
    const original = snapshot(parts)
    try {
      const next = enablePlugin(parts.lines, HERMES_PLUGIN_NAME)
      if (next.length !== parts.lines.length || next.some((line, index) => line !== parts.lines[index])) {
        parts.lines = next
        parts.finalNewline = true
      }
    } catch (error) {
      if (error instanceof YamlShapeError) throw unreadableConfig(configPath, target.home)
      throw error
    }
    const files = hermesPluginFiles(target)
    assertNoForeign(files, target.home)
    const changed = writeOwned(files)
    if (commitParts(configPath, text, original, parts)) changed.push(configPath)
    return { changed }
  },
  remove(target) {
    if (isRealHomeInTest(target.home)) return { changed: [], message: REAL_HOME_SKIPPED }
    const configPath = hermesConfigPath(target)
    const text = readText(configPath, target.home)
    const changed: string[] = []
    if (text !== null) {
      const parts = splitText(text)
      const original = snapshot(parts)
      parts.lines = restoreConfig(parts.lines, HERMES_PLUGIN_NAME)
      if (commitParts(configPath, text, original, parts)) changed.push(configPath)
    }
    return { changed: [...removeOwned(hermesPluginFiles(target), [hermesPluginDir(target)]), ...changed] }
  },
  status(target) {
    try {
      const text = readText(hermesConfigPath(target), target.home)
      const { enabled, disabled } = readEnablement(splitText(text ?? '').lines, HERMES_PLUGIN_NAME)
      const owned = ownedStatus(hermesPluginFiles(target), target.home)
      if (owned !== 'installed') return owned
      return enabled && !disabled ? 'installed' : 'not-installed'
    } catch (error) {
      if (error instanceof YamlShapeError) return { error: unreadableConfig(hermesConfigPath(target), target.home).message }
      if (error instanceof InstallError) return { error: error.message }
      throw error
    }
  }
}
