import { isReservedLaunchEnv, type LaunchHook, type LaunchHookInput } from '@quirky/protocol'

export type RunLaunchHooksOptions = {
  plugins: {
    contributions(filter: { kind: string }): Array<{ id: string; plugin: string; data: Record<string, unknown> }>
    resolveImplementation(id: string): Promise<unknown>
  }
  input: Omit<LaunchHookInput, 'env' | 'args' | 'jsonArgs'>
  /** Bounds each hook's resolve and call together. */
  timeoutMs: number
  warn(pluginId: string, message: string): void
}

export type LaunchAdditions = { env: Record<string, string | null>; args: string[] }

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

class HookTimedOut extends Error {}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isCleanString(value: unknown): value is string {
  return typeof value === 'string' && !value.includes('\0')
}

function isCleanArgs(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isCleanString)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const JSON_OPTION = /^--[A-Za-z0-9][A-Za-z0-9_-]*$/

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function cloneJsonValue(value: unknown, ancestors: WeakSet<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite number')
    return value
  }
  if (typeof value !== 'object') throw new Error('non-JSON value')
  if (ancestors.has(value)) throw new Error('circular value')

  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value)
      for (const key of keys) {
        if (key === 'length') continue
        if (
          typeof key !== 'string' ||
          !/^(0|[1-9]\d*)$/.test(key) ||
          Number(key) >= value.length
        ) {
          throw new Error('non-JSON array property')
        }
      }
      const copy: unknown[] = []
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw new Error('non-JSON array item')
        copy.push(cloneJsonValue(descriptor.value, ancestors))
      }
      return copy
    }

    if (!isPlainRecord(value)) throw new Error('non-plain object')
    const copy: Record<string, unknown> = {}
    for (const key of Reflect.ownKeys(value)) {
      if (
        typeof key !== 'string' ||
        key === '__proto__' ||
        key === 'prototype' ||
        key === 'constructor'
      ) {
        throw new Error('prototype-dangerous object key')
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw new Error('non-JSON object property')
      copy[key] = cloneJsonValue(descriptor.value, ancestors)
    }
    return copy
  } finally {
    ancestors.delete(value)
  }
}

function cloneJsonObject(value: unknown): Record<string, unknown> {
  if (!isPlainRecord(value)) throw new Error('expected a JSON object')
  return cloneJsonValue(value, new WeakSet()) as Record<string, unknown>
}

function mergeJsonObjects(earlier: Record<string, unknown>, later: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...earlier }
  for (const [key, value] of Object.entries(later)) {
    const previous = earlier[key]
    merged[key] = isPlainRecord(previous) && isPlainRecord(value) ? mergeJsonObjects(previous, value) : value
  }
  return merged
}

function freezeJson(value: unknown): void {
  if (!isRecord(value) && !Array.isArray(value)) return
  for (const child of Array.isArray(value) ? value : Object.values(value)) freezeJson(child)
  Object.freeze(value)
}

function jsonArgsSnapshot(jsonArgs: Map<string, Record<string, unknown>>): LaunchHookInput['jsonArgs'] {
  const snapshot: Record<string, Record<string, unknown>> = {}
  for (const [option, value] of jsonArgs) snapshot[option] = value
  freezeJson(snapshot)
  return snapshot
}

function applyJsonArgs(
  hookId: string,
  agent: string,
  value: unknown,
  accumulated: Map<string, Record<string, unknown>>,
  warnings: string[]
): void {
  if (!isPlainRecord(value)) {
    warnings.push(`launch hook ${hookId} returned invalid JSON args`)
    return
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !JSON_OPTION.test(key)) {
      warnings.push(`launch hook ${hookId} returned invalid JSON argument ${String(key)}`)
      continue
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      warnings.push(`launch hook ${hookId} returned invalid JSON argument ${key}`)
      continue
    }
    let contribution: Record<string, unknown>
    try {
      contribution = cloneJsonObject(descriptor.value)
    } catch {
      warnings.push(`launch hook ${hookId} returned invalid JSON argument ${key}`)
      continue
    }
    if (agent === 'shell') {
      warnings.push(`launch hook ${hookId} returned JSON args for a shell session, which take none`)
      continue
    }
    const previous = accumulated.get(key)
    accumulated.set(key, previous ? mergeJsonObjects(previous, contribution) : contribution)
  }
}

/** `work` receives `hasTimedOut`, so a step that has not started yet can be skipped once the deadline has passed. */
function timeBound<T>(work: (hasTimedOut: () => boolean) => Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  let expired = false
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true
      reject(new HookTimedOut())
    }, ms)
  })
  return Promise.race([work(() => expired), timeout]).finally(() => clearTimeout(timer))
}

/**
 * Runs the launch hooks that apply to `input.agent`, one at a time in ID order, and returns their
 * env additions, ordinary args and serialized JSON argument pairs. JSON pairs follow all ordinary
 * args. A failed hook contributes nothing; invalid patch entries are warned and dropped.
 * Never rejects.
 */
export async function runLaunchHooks(options: RunLaunchHooksOptions): Promise<LaunchAdditions> {
  const { plugins, input, timeoutMs, warn } = options
  const env = new Map<string, string | null>()
  const args: string[] = []
  const jsonArgs = new Map<string, Record<string, unknown>>()

  const hooks = plugins
    .contributions({ kind: 'launch-hook' })
    .filter((hook) => hook.data.agents === undefined || (Array.isArray(hook.data.agents) && hook.data.agents.includes(input.agent)))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  for (const hook of hooks) {
    const launch: LaunchHookInput = {
      ...input,
      env: Object.freeze(Object.fromEntries([...env].filter((entry): entry is [string, string] => entry[1] !== null))),
      args: Object.freeze([...args]),
      jsonArgs: jsonArgsSnapshot(jsonArgs)
    }
    let patch: unknown
    try {
      patch = await timeBound(async (hasTimedOut) => {
        const implementation = (await plugins.resolveImplementation(hook.id)) as LaunchHook
        if (hasTimedOut()) throw new HookTimedOut()
        return implementation(launch)
      }, timeoutMs)
    } catch (error) {
      warn(
        hook.plugin,
        error instanceof HookTimedOut
          ? `launch hook ${hook.id} timed out after ${timeoutMs} ms`
          : `launch hook ${hook.id} failed: ${messageOf(error)}`
      )
      continue
    }

    const warnings: string[] = []
    const additions = new Map<string, string | null>()
    let extraArgs: string[] = []
    try {
      if (patch !== undefined && patch !== null) {
        if (!isRecord(patch) || (patch.env != null && !isRecord(patch.env))) throw new Error('returned something other than a patch object')
        for (const [name, value] of Object.entries(patch.env ?? {})) {
          if (!ENV_NAME.test(name) || !(value === null || isCleanString(value))) {
            warnings.push(`launch hook ${hook.id} set invalid variable ${name}`)
          } else if (isReservedLaunchEnv(name)) {
            warnings.push(`launch hook ${hook.id} tried to set reserved variable ${name}`)
          } else {
            additions.set(name, value)
          }
        }
        if (patch.args !== undefined) {
          if (!isCleanArgs(patch.args)) warnings.push(`launch hook ${hook.id} returned invalid args`)
          else if (input.agent === 'shell') warnings.push(`launch hook ${hook.id} returned args for a shell session, which take none`)
          else extraArgs = [...patch.args]
        }
        try {
          const jsonPatch = patch.jsonArgs
          if (jsonPatch !== undefined) applyJsonArgs(hook.id, input.agent, jsonPatch, jsonArgs, warnings)
        } catch (error) {
          warnings.push(`launch hook ${hook.id} returned invalid JSON args: ${messageOf(error)}`)
        }
      }
    } catch (error) {
      warn(hook.plugin, `launch hook ${hook.id} failed: ${messageOf(error)}`)
      continue
    }
    for (const message of warnings) warn(hook.plugin, message)
    for (const [name, value] of additions) env.set(name, value)
    args.push(...extraArgs)
  }

  for (const [option, value] of jsonArgs) {
    const serialized = JSON.stringify(value)
    if (serialized !== undefined) args.push(option, serialized)
  }
  return { env: Object.fromEntries(env), args }
}
