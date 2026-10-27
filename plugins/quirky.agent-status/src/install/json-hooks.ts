import { isQuirkyHookCommand } from '../hook-command.ts'
import { InstallError, type InstallEnv, type Installer } from '../types.ts'
import {
  REAL_HOME_SKIPPED,
  isRealHomeInTest,
  ShapeError,
  editJsonFile,
  isObject,
  objectAt,
  ensureObjectAt,
  pruneEmptyAt,
  readJsonFile,
  type JsonObject
} from './common.ts'

/** One hook entry Quirky wants under an event of the file's event map. */
export type PlanEntry = { event: string; definition: JsonObject }

const COMMAND_KEYS = ['command', 'bash', 'powershell'] as const

function isQuirkyNestedHook(hook: unknown): boolean {
  return isObject(hook) && isQuirkyHookCommand(hook.command)
}

/** True for a hook definition that runs the Quirky shim, either directly or in its nested `hooks`. */
export function ownsDefinition(definition: unknown): boolean {
  if (!isObject(definition)) return false
  if (COMMAND_KEYS.some((key) => isQuirkyHookCommand(definition[key]))) return true
  return Array.isArray(definition.hooks) && definition.hooks.some(isQuirkyNestedHook)
}

/** The definition without Quirky's hooks, or null when nothing but Quirky's was in it. */
function withoutQuirky(definition: unknown): unknown | null {
  if (!ownsDefinition(definition)) return definition
  const owner = definition as JsonObject
  if (COMMAND_KEYS.some((key) => isQuirkyHookCommand(owner[key]))) return null
  const rest = (owner.hooks as unknown[]).filter((hook) => !isQuirkyNestedHook(hook))
  return rest.length > 0 ? { ...owner, hooks: rest } : null
}

function stripQuirky(definitions: unknown[]): unknown[] {
  return definitions.flatMap((definition) => {
    const kept = withoutQuirky(definition)
    return kept === null ? [] : [kept]
  })
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Makes `plan` the only Quirky content under the event map at `mapPath`: every planned event ends with
 * exactly one current Quirky definition, Quirky entries under other events are dropped, and everything
 * else (user hooks, other keys, order) stays. An up-to-date entry is left where it is.
 */
export function installEventMap(doc: JsonObject, mapPath: string[], plan: PlanEntry[]): void {
  const map = ensureObjectAt(doc, mapPath)
  const planned = new Set(plan.map((entry) => entry.event))
  for (const [event, definitions] of Object.entries(map)) {
    if (planned.has(event) || !Array.isArray(definitions)) continue
    const kept = stripQuirky(definitions)
    if (same(kept, definitions)) continue
    if (kept.length === 0) delete map[event]
    else map[event] = kept
  }
  for (const { event, definition } of plan) {
    const current = map[event]
    if (current !== undefined && !Array.isArray(current)) throw new ShapeError(event)
    const existing = current ?? []
    const owned = existing.filter(ownsDefinition)
    if (owned.length === 1 && same(owned[0], definition)) continue
    map[event] = [...stripQuirky(existing), definition]
  }
}

/** Removes Quirky's hooks from the event map at `mapPath`, and the containers that leaves empty. */
export function removeEventMap(doc: JsonObject, mapPath: string[]): void {
  const map = objectAt(doc, mapPath)
  if (!map) return
  let changed = false
  for (const [event, definitions] of Object.entries(map)) {
    if (!Array.isArray(definitions)) continue
    const kept = stripQuirky(definitions)
    if (same(kept, definitions)) continue
    changed = true
    if (kept.length === 0) delete map[event]
    else map[event] = kept
  }
  if (changed) pruneEmptyAt(doc, mapPath)
}

/** True when every planned event carries a Quirky definition equal to the planned one. */
export function planInstalled(doc: JsonObject, mapPath: string[], plan: PlanEntry[]): boolean {
  const map = objectAt(doc, mapPath)
  if (!map) return false
  return plan.every(({ event, definition }) => {
    const definitions = map[event]
    return Array.isArray(definitions) && definitions.some((candidate) => same(candidate, definition))
  })
}

export type JsonHookSpec = {
  agent: string
  source: string
  path(target: InstallEnv): string
  /** Where the event map lives in the document, e.g. `['hooks']`. */
  mapPath: string[]
  plan(target: InstallEnv): PlanEntry[]
  note?: string
  /** Sets top-level keys the agent needs, before the event map is written. */
  prepare?(doc: JsonObject): void
  /** True when what remains after a remove is only what Quirky added, so the file is deleted. */
  isEmpty?(doc: JsonObject): boolean
}

/**
 * An installer for an agent whose hooks live in one JSON file as an event map. The file is merged,
 * never replaced: a rerun changes nothing, and remove leaves the user's keys and hooks as they were.
 */
export function jsonHookInstaller(spec: JsonHookSpec): Installer {
  return {
    agent: spec.agent,
    source: spec.source,
    files: (target) => [spec.path(target)],
    install(target) {
      if (isRealHomeInTest(target.home)) return { changed: [], message: REAL_HOME_SKIPPED }
      const file = spec.path(target)
      const plan = spec.plan(target)
      const changed = editJsonFile(
        file,
        target.home,
        (doc) => {
          spec.prepare?.(doc)
          installEventMap(doc, spec.mapPath, plan)
        },
        { createIfMissing: true, isEmpty: spec.isEmpty }
      )
      return { changed: changed ? [file] : [], ...(spec.note ? { note: spec.note } : {}) }
    },
    remove(target) {
      if (isRealHomeInTest(target.home)) return { changed: [], message: REAL_HOME_SKIPPED }
      const file = spec.path(target)
      const changed = editJsonFile(file, target.home, (doc) => removeEventMap(doc, spec.mapPath), {
        createIfMissing: false,
        isEmpty: spec.isEmpty
      })
      return { changed: changed ? [file] : [] }
    },
    status(target) {
      try {
        const { doc, text } = readJsonFile(spec.path(target), target.home)
        if (text === null) return 'not-installed'
        return planInstalled(doc, spec.mapPath, spec.plan(target)) ? 'installed' : 'not-installed'
      } catch (error) {
        if (error instanceof InstallError) return { error: error.message }
        throw error
      }
    }
  }
}
