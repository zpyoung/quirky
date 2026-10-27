import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { PluginContext } from '@quirky/protocol'
import { isRecord } from './json'
import { readBoundedConfig } from './bounded-read'

const MAX_ERROR_LENGTH = 500
const SYSTEM_MANAGED_SETTINGS = '/Library/Application Support/ClaudeCode/managed-settings.json'

type ObjectValue = Record<string, unknown>
export type SessionLaunchRecord = { command: string; args: string; env: Record<string, string> }

export type SettingsResolutionInput = {
  cwd: string
  workspaceRoot?: string
  record?: SessionLaunchRecord | null
  env?: Readonly<Record<string, string | null | undefined>>
  model?: unknown
  options?: unknown
  extraArgs?: unknown
}

export type EffectiveClaudeSettings = {
  settings: ObjectValue
  statusLine?: ObjectValue
  configDir: string
  managed: boolean
  errors: string[]
}

type AgentConfig = { env?: Record<string, unknown> }


function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_LENGTH)
}

function ownObject(value: ObjectValue): ObjectValue {
  const output = Object.create(null) as ObjectValue
  for (const [key, child] of Object.entries(value)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new Error(`settings contain prohibited key ${key}`)
    Object.defineProperty(output, key, { value: child, enumerable: true, configurable: true, writable: true })
  }
  return output
}

function mergeObjects(target: ObjectValue, source: ObjectValue): ObjectValue {
  const output = ownObject(target)
  for (const [key, value] of Object.entries(source)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new Error(`settings contain prohibited key ${key}`)
    const previous = output[key]
    Object.defineProperty(
      output,
      key,
      {
        value: isRecord(previous) && isRecord(value) ? mergeObjects(previous, value) : value,
        enumerable: true,
        configurable: true,
        writable: true
      }
    )
  }
  return output
}

async function readSettingsFile(path: string, errors: string[]): Promise<ObjectValue | null> {
  let content: Buffer
  try {
    content = await readBoundedConfig(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    errors.push(`${path}: ${safeError(error)}`)
    return null
  }
  try {
    const parsed: unknown = JSON.parse(content.toString('utf8'))
    if (!isRecord(parsed)) throw new Error('expected a JSON object')
    return ownObject(parsed)
  } catch (error) {
    errors.push(`${path}: ${safeError(error)}`)
    return null
  }
}

function stringEnv(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

async function configuredAgentEnv(context: PluginContext): Promise<Record<string, unknown>> {
  try {
    const agent = (await context.call('quirky.agents/get', { agent: 'claude' })) as AgentConfig
    return isRecord(agent.env) ? agent.env : {}
  } catch {
    return {}
  }
}

export async function claudeConfigDir(context: PluginContext, input: SettingsResolutionInput): Promise<string> {
  const configuredEnv = await configuredAgentEnv(context)
  const configured = stringEnv(input.record?.env?.CLAUDE_CONFIG_DIR)
  const launchEnv = stringEnv(input.env?.CLAUDE_CONFIG_DIR)
  const agentEnv = stringEnv(configuredEnv.CLAUDE_CONFIG_DIR)
  const processEnv = stringEnv(process.env.CLAUDE_CONFIG_DIR)
  const selected = configured ?? launchEnv ?? agentEnv ?? processEnv
  if (selected) return isAbsolute(selected) ? selected : resolve(input.cwd, selected)
  return join(process.env.HOME || homedir(), '.claude')
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export function statusLineIdentity(statusLine: ObjectValue): string {
  return createHash('sha256').update(canonicalJson(statusLine)).digest('hex')
}

/** Read file-backed Claude settings and merge the public user-CLI settings overlay in precedence order. */
export async function resolveClaudeSettings(
  context: PluginContext,
  input: SettingsResolutionInput
): Promise<EffectiveClaudeSettings> {
  const errors: string[] = []
  const configDir = await claudeConfigDir(context, input)
  const workspaceRoot = input.workspaceRoot ?? input.cwd
  const projectDir = join(workspaceRoot, '.claude')
  const managedFiles = [join(configDir, 'managed-settings.json'), SYSTEM_MANAGED_SETTINGS]
  let settings: ObjectValue = Object.create(null) as ObjectValue
  let managed = false
  let managedStatusLine: ObjectValue | undefined

  for (const path of [join(configDir, 'settings.json'), join(projectDir, 'settings.json'), join(projectDir, 'settings.local.json')]) {
    const layer = await readSettingsFile(path, errors)
    if (layer) settings = mergeObjects(settings, layer)
  }

  for (const path of managedFiles) {
    const layer = await readSettingsFile(path, errors)
    if (!layer || !Object.hasOwn(layer, 'statusLine')) continue
    const candidate = layer.statusLine
    if (!isRecord(candidate)) {
      errors.push(`${path}: managed statusLine must be an object`)
      managed = true
      managedStatusLine = undefined
      continue
    }
    managed = true
    managedStatusLine = ownObject(candidate)
  }

  const overlay = (await context.call('quirky.agents/settingsOverlay', {
    agent: 'claude',
    cwd: input.cwd,
    ...(input.record ? { record: input.record } : {}),
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.options === undefined ? {} : { options: input.options }),
    ...(input.extraArgs === undefined ? {} : { extraArgs: input.extraArgs })
  })) as { settings?: unknown }
  const overlaySettings = overlay?.settings
  if (!isRecord(overlaySettings)) throw context.error('invalid-params', 'Claude settings overlay returned an invalid settings object')
  const cliSettings = ownObject(overlaySettings)
  settings = mergeObjects(settings, cliSettings)

  let statusLine: ObjectValue | undefined
  const candidate = managed ? managedStatusLine : settings.statusLine
  if (candidate !== undefined) {
    if (!isRecord(candidate)) {
      errors.push('statusLine: expected an object')
    } else {
      try {
        statusLine = ownObject(candidate)
      } catch (error) {
        errors.push(safeError(error))
      }
    }
  }
  return { settings, ...(statusLine ? { statusLine } : {}), configDir, managed, errors }
}
