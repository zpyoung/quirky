import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { hookCommand } from '../hook-command.ts'
import { InstallError, type InstallEnv, type Installer } from '../types.ts'
import {
  claudeDefinition,
  claudeJsonInstaller,
  codebuddyInstaller,
  codexInstaller,
  commandCodeInstaller,
  devinInstaller,
  droidInstaller,
  HOOK_TIMEOUT_SECONDS,
  matched,
  openclaudeInstaller,
  plain,
  qoderCnInstaller,
  qoderInstaller,
  qwenCodeInstaller,
  zcodeInstaller
} from './claude-json.ts'
import {
  REAL_HOME_SKIPPED,
  dirOverride,
  editJsonFile,
  isRealHomeInTest,
  readJsonFile,
  serializeJson,
  tildePath,
  writeFileAtomic,
  type JsonObject
} from './common.ts'
import { installEventMap, jsonHookInstaller, planInstalled, removeEventMap, type PlanEntry } from './json-hooks.ts'

const GEMINI_TIMEOUT_MS = 10000
const COPILOT_TIMEOUT_SECONDS = 5
const KIRO_TIMEOUT_MS = 10000

export const geminiInstaller = claudeJsonInstaller({
  agent: 'gemini',
  path: (target) => join(target.home, '.gemini', 'settings.json'),
  events: plain('BeforeAgent', 'AfterAgent', 'BeforeTool', 'AfterTool'),
  timeout: GEMINI_TIMEOUT_MS
})

const ANTIGRAVITY_DIRECT_EVENTS = ['PreInvocation', 'PostInvocation', 'Stop']
const ANTIGRAVITY_TOOL_EVENTS = ['PreToolUse', 'PostToolUse']

/** Antigravity reads its hooks from a top-level bundle key, with the command on the entry for lifecycle events. */
export const antigravityInstaller = jsonHookInstaller({
  agent: 'antigravity',
  source: 'antigravity',
  path: (target) => join(target.home, '.gemini', 'config', 'hooks.json'),
  mapPath: ['quirky-status'],
  plan: () => [
    ...ANTIGRAVITY_DIRECT_EVENTS.map((event) => ({
      event,
      definition: { type: 'command', command: hookCommand('antigravity', event), timeout: HOOK_TIMEOUT_SECONDS }
    })),
    ...ANTIGRAVITY_TOOL_EVENTS.map((event) => ({
      event,
      definition: claudeDefinition(hookCommand('antigravity', event), { matcher: '*' })
    }))
  ]
})

const CURSOR_EVENTS = [
  'beforeSubmitPrompt',
  'stop',
  'preToolUse',
  'postToolUse',
  'postToolUseFailure',
  'beforeShellExecution',
  'beforeMCPExecution',
  'afterAgentResponse'
]

/** Cursor requires `version: 1` in hooks.json; a version the user already set is kept. */
function setVersionOne(doc: JsonObject): void {
  if (doc.version === undefined) doc.version = 1
}

const onlyVersionOne = (doc: JsonObject): boolean => JSON.stringify(doc) === '{"version":1}'

export const cursorInstaller = jsonHookInstaller({
  agent: 'cursor',
  source: 'cursor',
  path: (target) => join(target.home, '.cursor', 'hooks.json'),
  mapPath: ['hooks'],
  plan: () =>
    CURSOR_EVENTS.map((event) => ({
      event,
      definition: { command: hookCommand('cursor', event), timeout: HOOK_TIMEOUT_SECONDS }
    })),
  prepare: setVersionOne,
  isEmpty: onlyVersionOne
})

/** The whole file is Quirky's, so remove deletes it. */
export const grokInstaller = claudeJsonInstaller({
  agent: 'grok',
  path: (target) => join(dirOverride(target.env.GROK_HOME, join(target.home, '.grok')), 'hooks', 'quirky-status.json'),
  events: [
    ...plain('SessionStart', 'UserPromptSubmit', 'Stop', 'StopCancelled', 'StopFailure', 'SessionEnd'),
    ...matched('.*', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure'),
    ...plain('Notification')
  ]
})

const COPILOT_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'subagentStart',
  'SubagentStop',
  'PreCompact',
  'Stop',
  'ErrorOccurred',
  'PermissionRequest',
  'Notification'
]

export const copilotInstaller = jsonHookInstaller({
  agent: 'copilot',
  source: 'copilot',
  path: (target) => join(dirOverride(target.env.COPILOT_HOME, join(target.home, '.copilot')), 'hooks', 'quirky.json'),
  mapPath: ['hooks'],
  plan: () =>
    COPILOT_EVENTS.map((event) => ({
      event,
      definition: { type: 'command', bash: hookCommand('copilot', event), timeoutSec: COPILOT_TIMEOUT_SECONDS }
    })),
  prepare: setVersionOne,
  isEmpty: onlyVersionOne
})

const MUSE_EVENTS = [
  'SessionStart',
  'SubagentStart',
  'SessionEnd',
  'Notification',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Stop',
  'StopFailure'
]

/** Muse filters the environment of managed hooks, so the shim's variables must be allowlisted. */
const MUSE_ENV_VARS = ['QUIRKY_SESSION_ID', 'QUIRKY_HOME', 'QUIRKY_HOOK_URL', 'QUIRKY_HOOK_TOKEN']

function museSettingsPath(target: InstallEnv): string {
  return join(dirOverride(target.env.XDG_CONFIG_HOME, join(target.home, '.config')), 'muse', 'settings.json')
}

function museHooksPath(target: InstallEnv): string {
  return join(target.quirkyHome, 'agent-hooks', 'muse-hooks.json')
}

function museHooksText(): string {
  const hooks = Object.fromEntries(MUSE_EVENTS.map((event) => [event, [claudeDefinition(hookCommand('muse'), {})]]))
  return serializeJson({ hooks })
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

/**
 * Muse runs hooks from a file named by `managed_hooks_path` without a trust step, so Quirky owns that
 * file outright and settings.json only points at it. A pointer the user set elsewhere is left alone.
 */
export const museInstaller: Installer = {
  agent: 'muse',
  source: 'muse',
  files: (target) => [museSettingsPath(target), museHooksPath(target)],
  install(target) {
    if (isRealHomeInTest(target.home)) return { changed: [], message: REAL_HOME_SKIPPED }
    const settingsPath = museSettingsPath(target)
    const hooksPath = museHooksPath(target)
    const { doc } = readJsonFile(settingsPath, target.home)
    const pointer = doc.managed_hooks_path
    if (typeof pointer === 'string' && pointer !== hooksPath) {
      return { changed: [], message: `managed_hooks_path points at ${tildePath(pointer, target.home)}; leaving your managed hooks alone` }
    }
    const hooksText = museHooksText()
    const hooksChanged = !existsSync(hooksPath) || readFileSync(hooksPath, 'utf8') !== hooksText
    if (hooksChanged) writeFileAtomic(hooksPath, hooksText)
    const settingsChanged = editJsonFile(
      settingsPath,
      target.home,
      (next) => {
        // Muse rejects a settings file without schema_version
        if (next.schema_version === undefined) next.schema_version = 1
        next.managed_hooks_path = hooksPath
        const names = [...new Set([...stringList(next.managed_hooks_env_vars), ...MUSE_ENV_VARS])]
        if (JSON.stringify(next.managed_hooks_env_vars) !== JSON.stringify(names)) next.managed_hooks_env_vars = names
      },
      { createIfMissing: true }
    )
    return { changed: [...(settingsChanged ? [settingsPath] : []), ...(hooksChanged ? [hooksPath] : [])] }
  },
  remove(target) {
    if (isRealHomeInTest(target.home)) return { changed: [], message: REAL_HOME_SKIPPED }
    const settingsPath = museSettingsPath(target)
    const hooksPath = museHooksPath(target)
    const settingsChanged = editJsonFile(
      settingsPath,
      target.home,
      (next) => {
        if (next.managed_hooks_path !== hooksPath) return
        delete next.managed_hooks_path
        if (next.managed_hooks_env_vars === undefined) return
        const kept = stringList(next.managed_hooks_env_vars).filter((name) => !MUSE_ENV_VARS.includes(name))
        if (kept.length > 0) next.managed_hooks_env_vars = kept
        else delete next.managed_hooks_env_vars
      },
      { createIfMissing: false, isEmpty: (next) => JSON.stringify(next) === '{"schema_version":1}' }
    )
    const hooksChanged = existsSync(hooksPath)
    if (hooksChanged) rmSync(hooksPath, { force: true })
    return { changed: [...(settingsChanged ? [settingsPath] : []), ...(hooksChanged ? [hooksPath] : [])] }
  },
  status(target) {
    try {
      const { doc, text } = readJsonFile(museSettingsPath(target), target.home)
      const hooksPath = museHooksPath(target)
      if (text === null || doc.managed_hooks_path !== hooksPath) return 'not-installed'
      if (!existsSync(hooksPath) || readFileSync(hooksPath, 'utf8') !== museHooksText()) return 'not-installed'
      const names = stringList(doc.managed_hooks_env_vars)
      return MUSE_ENV_VARS.every((name) => names.includes(name)) ? 'installed' : 'not-installed'
    } catch (error) {
      if (error instanceof InstallError) return { error: error.message }
      throw error
    }
  }
}

const KIRO_EVENTS: { event: string; matcher?: string }[] = [
  { event: 'agentSpawn' },
  { event: 'userPromptSubmit' },
  { event: 'preToolUse', matcher: '*' },
  { event: 'postToolUse', matcher: '*' },
  { event: 'stop' }
]

const KIRO_NO_AGENTS = 'no Kiro agents to patch'

function kiroPlan(): PlanEntry[] {
  const command = hookCommand('kiro')
  return KIRO_EVENTS.map(({ event, matcher }) => ({
    event,
    definition: { ...(matcher ? { matcher } : {}), command, timeout_ms: KIRO_TIMEOUT_MS }
  }))
}

/** Kiro has no global hook file, so every agent config the user owns is patched; Quirky never creates one. */
function kiroAgentFiles(target: InstallEnv): string[] {
  const dir = join(dirOverride(target.env.KIRO_HOME, join(target.home, '.kiro')), 'agents')
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => join(dir, name))
  } catch {
    return []
  }
}

function kiroPatch(target: InstallEnv, edit: (doc: JsonObject) => void): { changed: string[]; skipped: string[] } {
  const changed: string[] = []
  const skipped: string[] = []
  for (const file of kiroAgentFiles(target)) {
    try {
      if (editJsonFile(file, target.home, edit, { createIfMissing: false, isEmpty: () => false })) changed.push(file)
    } catch (error) {
      if (!(error instanceof InstallError)) throw error
      skipped.push(file)
    }
  }
  return { changed, skipped }
}

function kiroMessage(target: InstallEnv, skipped: string[]): { message?: string } {
  return skipped.length > 0 ? { message: `skipped ${skipped.map((file) => tildePath(file, target.home)).join(', ')} (could not parse)` } : {}
}

export const kiroInstaller: Installer = {
  agent: 'kiro',
  source: 'kiro',
  files: kiroAgentFiles,
  install(target) {
    if (isRealHomeInTest(target.home)) return { changed: [], message: REAL_HOME_SKIPPED }
    if (kiroAgentFiles(target).length === 0) return { changed: [], message: KIRO_NO_AGENTS }
    const plan = kiroPlan()
    const { changed, skipped } = kiroPatch(target, (doc) => installEventMap(doc, ['hooks'], plan))
    return { changed, ...kiroMessage(target, skipped) }
  },
  remove(target) {
    if (isRealHomeInTest(target.home)) return { changed: [], message: REAL_HOME_SKIPPED }
    const { changed, skipped } = kiroPatch(target, (doc) => removeEventMap(doc, ['hooks']))
    return { changed, ...kiroMessage(target, skipped) }
  },
  status(target) {
    const plan = kiroPlan()
    const verdicts: boolean[] = []
    for (const file of kiroAgentFiles(target)) {
      try {
        verdicts.push(planInstalled(readJsonFile(file, target.home).doc, ['hooks'], plan))
      } catch (error) {
        if (!(error instanceof InstallError)) throw error
      }
    }
    return verdicts.length > 0 && verdicts.every(Boolean) ? 'installed' : 'not-installed'
  }
}

/** Every installer whose agent keeps its hooks in a JSON file. */
export const JSON_INSTALLERS: Installer[] = [
  openclaudeInstaller,
  qoderInstaller,
  qoderCnInstaller,
  qwenCodeInstaller,
  codebuddyInstaller,
  codexInstaller,
  geminiInstaller,
  antigravityInstaller,
  cursorInstaller,
  droidInstaller,
  commandCodeInstaller,
  grokInstaller,
  copilotInstaller,
  devinInstaller,
  museInstaller,
  zcodeInstaller,
  kiroInstaller
]
