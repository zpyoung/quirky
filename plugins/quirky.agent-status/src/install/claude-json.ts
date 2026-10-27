import { join } from 'node:path'
import { hookCommand } from '../hook-command.ts'
import type { InstallEnv, Installer } from '../types.ts'
import { dirOverride, isObject, type JsonObject } from './common.ts'
import { jsonHookInstaller, type PlanEntry } from './json-hooks.ts'

/** A hook event and the tool matcher it is registered with, when the agent wants one. */
export type EventSpec = { event: string; matcher?: string }

export const HOOK_TIMEOUT_SECONDS = 10

export function plain(...events: string[]): EventSpec[] {
  return events.map((event) => ({ event }))
}

export function matched(matcher: string, ...events: string[]): EventSpec[] {
  return events.map((event) => ({ event, matcher }))
}

/** `{matcher?, hooks:[{type, command, timeout}]}`, the entry shape Claude and its relatives share. */
export function claudeDefinition(command: string, spec: Pick<EventSpec, 'matcher'>, timeout = HOOK_TIMEOUT_SECONDS): JsonObject {
  return {
    ...(spec.matcher ? { matcher: spec.matcher } : {}),
    hooks: [{ type: 'command', command, timeout }]
  }
}

export function claudePlan(source: string, events: EventSpec[], timeout = HOOK_TIMEOUT_SECONDS): PlanEntry[] {
  return events.map((spec) => ({ event: spec.event, definition: claudeDefinition(hookCommand(source), spec, timeout) }))
}

export type ClaudeJsonOptions = {
  agent: string
  /** The config file, from the target's home and agent-specific environment. */
  path(target: InstallEnv): string
  events: EventSpec[]
  /** Where the event map sits in the file; `['hooks']` unless the agent nests it deeper. */
  mapPath?: string[]
  /** Hook timeout in the unit the agent reads; seconds unless the agent says otherwise. */
  timeout?: number
  note?: string
  prepare?(doc: JsonObject): void
  isEmpty?(doc: JsonObject): boolean
}

/** An installer for an agent that reads Claude-shaped hook entries from a JSON settings file. */
export function claudeJsonInstaller(options: ClaudeJsonOptions): Installer {
  return jsonHookInstaller({
    agent: options.agent,
    source: options.agent,
    path: options.path,
    mapPath: options.mapPath ?? ['hooks'],
    plan: () => claudePlan(options.agent, options.events, options.timeout),
    note: options.note,
    prepare: options.prepare,
    isEmpty: options.isEmpty
  })
}

const homeFile =
  (...parts: string[]) =>
  (target: InstallEnv) =>
    join(target.home, ...parts)

const TOOL_EVENTS = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest']

/** Claude's events minus SessionEnd, which only Claude 2.1.261+ delivers. */
const OPENCLAUDE_EVENTS = [
  ...plain('SessionStart', 'UserPromptSubmit', 'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop', 'TeammateIdle'),
  ...matched('*', ...TOOL_EVENTS),
  ...plain('PostCompact')
]

const QODER_EVENTS = plain(
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Stop',
  'StopFailure',
  'Notification',
  'PostCompact'
)

const QWEN_CODE_EVENTS = [...QODER_EVENTS.filter((spec) => spec.event !== 'PostCompact'), ...plain('SubagentStart', 'SubagentStop')]

const CODEBUDDY_EVENTS = QODER_EVENTS.filter((spec) => spec.event !== 'PostCompact')

export const openclaudeInstaller = claudeJsonInstaller({
  agent: 'openclaude',
  path: homeFile('.openclaude', 'settings.json'),
  events: OPENCLAUDE_EVENTS
})

export const qoderInstaller = claudeJsonInstaller({
  agent: 'qoder',
  path: homeFile('.qoder', 'settings.json'),
  events: QODER_EVENTS
})

export const qoderCnInstaller = claudeJsonInstaller({
  agent: 'qoder-cn',
  path: homeFile('.qoder-cn', 'settings.json'),
  events: QODER_EVENTS
})

export const qwenCodeInstaller = claudeJsonInstaller({
  agent: 'qwen-code',
  path: homeFile('.qwen', 'settings.json'),
  events: QWEN_CODE_EVENTS
})

export const codebuddyInstaller = claudeJsonInstaller({
  agent: 'codebuddy',
  path: homeFile('.codebuddy', 'settings.json'),
  events: CODEBUDDY_EVENTS
})

export const droidInstaller = claudeJsonInstaller({
  agent: 'droid',
  path: homeFile('.factory', 'settings.json'),
  events: [
    ...plain('SessionStart', 'UserPromptSubmit', 'Stop', 'SubagentStop'),
    ...matched('*', 'PreToolUse', 'PostToolUse', 'PermissionRequest'),
    ...plain('Notification')
  ]
})

export const commandCodeInstaller = claudeJsonInstaller({
  agent: 'command-code',
  path: homeFile('.commandcode', 'settings.json'),
  events: [...matched('.*', 'PreToolUse', 'PostToolUse'), ...plain('Stop')]
})

/** Devin's config.json is read as plain JSON, so a file with comments is reported as unparseable. */
export const devinInstaller = claudeJsonInstaller({
  agent: 'devin',
  path: homeFile('.config', 'devin', 'config.json'),
  events: plain('SessionStart', 'UserPromptSubmit', 'Stop', 'PostCompaction', 'SessionEnd', 'PreToolUse', 'PostToolUse', 'PermissionRequest')
})

/** ZCode ships `hooks.enabled: false`, so setup turns it on when the user hasn't set it either way. */
export const zcodeInstaller = claudeJsonInstaller({
  agent: 'zcode',
  path: homeFile('.zcode', 'cli', 'config.json'),
  mapPath: ['hooks', 'events'],
  events: plain('SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'Stop'),
  prepare(doc) {
    if (doc.hooks === undefined) doc.hooks = { enabled: true }
    else if (isObject(doc.hooks) && doc.hooks.enabled === undefined) doc.hooks.enabled = true
  },
  isEmpty: (doc) => JSON.stringify(doc) === '{"hooks":{"enabled":true}}'
})

export const codexInstaller = claudeJsonInstaller({
  agent: 'codex',
  path: (target) => join(dirOverride(target.env.CODEX_HOME, join(target.home, '.codex')), 'hooks.json'),
  events: plain('SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'Stop', 'Interrupt'),
  note: 'Codex asks you to review these hooks once (/hooks)'
})
