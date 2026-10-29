import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

export class SettingsError extends Error {}
const MAX_SETTINGS_BYTES = 4 * 1024 * 1024
const READ_CHUNK_BYTES = 64 * 1024

export type ParsedSettingsArguments = {
  args: string[]
  settings: Record<string, unknown>
  found: boolean
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function cloneJsonValue(value: unknown, ancestors: WeakSet<object>, source: string): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new SettingsError(`${source} contains a non-finite number`)
    return value
  }
  if (typeof value !== 'object') throw new SettingsError(`${source} contains a non-JSON value`)
  if (ancestors.has(value)) throw new SettingsError(`${source} contains a circular value`)

  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      for (const key of Reflect.ownKeys(value)) {
        if (key === 'length') continue
        if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) {
          throw new SettingsError(`${source} contains a non-JSON array property`)
        }
      }
      const copy: unknown[] = []
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
          throw new SettingsError(`${source} contains a non-JSON array item`)
        }
        copy.push(cloneJsonValue(descriptor.value, ancestors, source))
      }
      return copy
    }

    if (!isPlainRecord(value)) throw new SettingsError(`${source} contains a non-plain object`)
    const copy: Record<string, unknown> = {}
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || key === '__proto__' || key === 'prototype' || key === 'constructor') {
        throw new SettingsError(`${source} contains a prototype-dangerous key`)
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
        throw new SettingsError(`${source} contains a non-JSON object property`)
      }
      copy[key] = cloneJsonValue(descriptor.value, ancestors, source)
    }
    return copy
  } finally {
    ancestors.delete(value)
  }
}

function cloneJsonObject(value: unknown, source: string): Record<string, unknown> {
  if (!isPlainRecord(value)) throw new SettingsError(`${source} must be a JSON object`)
  return cloneJsonValue(value, new WeakSet(), source) as Record<string, unknown>
}

function mergeObjects(earlier: Record<string, unknown>, later: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...earlier }
  for (const [key, value] of Object.entries(later)) {
    const previous = earlier[key]
    merged[key] = isPlainRecord(previous) && isPlainRecord(value) ? mergeObjects(previous, value) : value
  }
  return merged
}

/** Returns a recursively merged copy; arrays and scalar values are replaced by later layers. */
export function mergeSettings(...layers: unknown[]): Record<string, unknown> {
  let merged: Record<string, unknown> = {}
  for (const layer of layers) merged = mergeObjects(merged, cloneJsonObject(layer, 'settings'))
  return merged
}

function parseJsonObject(text: string, source: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new SettingsError(`${source} is not valid JSON: ${messageOf(error)}`)
  }
  return cloneJsonObject(value, source)
}

function readSettingsFile(path: string): string {
  let descriptor: number | undefined
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK)
    const initialStat = fstatSync(descriptor)
    if (!initialStat.isFile()) throw new SettingsError(`--settings file ${path} is not a regular file`)
    if (initialStat.size > MAX_SETTINGS_BYTES) {
      throw new SettingsError(`--settings file ${path} exceeds ${MAX_SETTINGS_BYTES} bytes`)
    }

    const chunks: Buffer[] = []
    let totalBytes = 0
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, MAX_SETTINGS_BYTES + 1 - totalBytes))
      const bytesRead = readSync(descriptor, chunk, 0, chunk.length, null)
      if (bytesRead === 0) break
      totalBytes += bytesRead
      if (totalBytes > MAX_SETTINGS_BYTES) {
        throw new SettingsError(`--settings file ${path} exceeds ${MAX_SETTINGS_BYTES} bytes`)
      }
      chunks.push(chunk.subarray(0, bytesRead))
    }

    if (fstatSync(descriptor).size > MAX_SETTINGS_BYTES) {
      throw new SettingsError(`--settings file ${path} exceeds ${MAX_SETTINGS_BYTES} bytes`)
    }
    return Buffer.concat(chunks, totalBytes).toString('utf8')
  } catch (error) {
    if (error instanceof SettingsError) throw error
    throw new SettingsError(`could not read --settings file ${path}: ${messageOf(error)}`)
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

function loadSettings(value: string, cwd: string | undefined): Record<string, unknown> {
  const trimmed = value.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return parseJsonObject(value, '--settings JSON')

  const path = isAbsolute(value) ? value : resolve(cwd ?? process.cwd(), value)
  return parseJsonObject(readSettingsFile(path), `--settings file ${path}`)
}

/** Extracts all pre-terminator --settings JSON/files and returns the remaining tokens. */
export function parseSettingsArguments(
  tokens: readonly string[],
  cwd: string | undefined,
  valueFlags: readonly string[] = []
): ParsedSettingsArguments {
  const args: string[] = []
  let settings: Record<string, unknown> = {}
  let found = false

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!
    if (token === '--') {
      args.push(...tokens.slice(index))
      break
    }
    if (token === '--settings') {
      const value = tokens[index + 1]
      if (value === undefined) throw new SettingsError('--settings requires a JSON value or file path')
      found = true
      settings = mergeObjects(settings, loadSettings(value, cwd))
      index += 1
      continue
    }
    if (token.startsWith('--settings=')) {
      found = true
      settings = mergeObjects(settings, loadSettings(token.slice('--settings='.length), cwd))
      continue
    }

    args.push(token)
    if (valueFlags.includes(token) && !token.includes('=') && index + 1 < tokens.length) {
      args.push(tokens[index + 1]!)
      index += 1
    }
  }

  return { args, settings, found }
}
