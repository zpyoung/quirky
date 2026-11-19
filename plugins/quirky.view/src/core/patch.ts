import { validateViewSpec } from './catalog'
import type { ViewSpec, ViewValidationError } from './contract'

export const MAX_PATCH_OPS = 200

const OPS = ['add', 'replace', 'remove'] as const
const CANONICAL_INDEX = /^(?:0|[1-9]\d*)$/

export type PatchResult = { ok: true; spec: ViewSpec } | { ok: false; errors: ViewValidationError[] }

type Op = { op: (typeof OPS)[number]; path: string; value?: unknown }

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** The segments of a JSON Pointer with `~1` and `~0` undone, or undefined when it is not one. */
function parsePointer(pointer: string): string[] | undefined {
  if (pointer === '') return []
  if (!pointer.startsWith('/') || /~(?![01])/.test(pointer)) return undefined
  return pointer.slice(1).split('/').map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'))
}

function readOps(raw: unknown): { ops: Op[]; errors: ViewValidationError[] } {
  const errors: ViewValidationError[] = []
  if (!Array.isArray(raw)) return { ops: [], errors: [{ path: 'ops', message: 'must be an array of operations' }] }
  if (raw.length > MAX_PATCH_OPS) return { ops: [], errors: [{ path: 'ops', message: `at most ${MAX_PATCH_OPS} ops allowed` }] }
  const ops: Op[] = []
  raw.forEach((entry, index) => {
    const at = `ops[${index}]`
    if (!isObject(entry)) return void errors.push({ path: at, message: 'must be an object' })
    for (const key of Object.keys(entry)) {
      if (key !== 'op' && key !== 'path' && key !== 'value') errors.push({ path: `${at}.${key}`, message: `unknown field '${key}'; allowed: op, path, value` })
    }
    const op = entry.op
    if (typeof op !== 'string' || !(OPS as readonly string[]).includes(op)) return void errors.push({ path: `${at}.op`, message: `must be one of ${OPS.join(' | ')}` })
    if (typeof entry.path !== 'string') return void errors.push({ path: `${at}.path`, message: 'must be a JSON Pointer string' })
    if (op !== 'remove' && entry.value === undefined) return void errors.push({ path: `${at}.value`, message: `is required for ${op}` })
    ops.push({ op: op as Op['op'], path: entry.path, ...(entry.value === undefined ? {} : { value: entry.value }) })
  })
  return { ops, errors }
}

function child(container: unknown, segment: string): { found: true; value: unknown } | { found: false } {
  if (Array.isArray(container)) {
    const index = CANONICAL_INDEX.test(segment) ? Number(segment) : -1
    return index >= 0 && index < container.length ? { found: true, value: container[index] } : { found: false }
  }
  if (isObject(container) && Object.hasOwn(container, segment)) return { found: true, value: container[segment] }
  return { found: false }
}

/** Applies one op to `doc`, returning the new root, or the problem as a message for `ops[i].path`. */
function applyOp(doc: unknown, op: Op): { doc: unknown } | { error: string } {
  const segments = parsePointer(op.path)
  if (segments === undefined) return { error: `'${op.path}' is not a JSON Pointer` }
  const value = op.op === 'remove' ? undefined : JSON.parse(JSON.stringify(op.value))
  if (segments.length === 0) return op.op === 'remove' ? { error: 'the whole spec cannot be removed' } : { doc: value }

  let parent = doc
  for (const segment of segments.slice(0, -1)) {
    const next = child(parent, segment)
    if (!next.found) return { error: `${op.path} does not exist` }
    parent = next.value
  }
  const last = segments[segments.length - 1]

  if (Array.isArray(parent)) {
    if (last === '-' && op.op === 'add') {
      parent.push(value)
      return { doc }
    }
    if (!CANONICAL_INDEX.test(last)) return { error: `${op.path} does not exist` }
    const index = Number(last)
    if (op.op === 'add') {
      if (index > parent.length) return { error: `index ${last} is out of range` }
      parent.splice(index, 0, value)
    } else {
      if (index >= parent.length) return { error: `${op.path} does not exist` }
      if (op.op === 'replace') parent[index] = value
      else parent.splice(index, 1)
    }
    return { doc }
  }
  if (isObject(parent)) {
    if (op.op !== 'add' && !Object.hasOwn(parent, last)) return { error: `${op.path} does not exist` }
    if (op.op === 'remove') delete parent[last]
    // defineProperty so a `__proto__` key becomes plain data instead of reassigning the prototype
    else Object.defineProperty(parent, last, { value, enumerable: true, writable: true, configurable: true })
    return { doc }
  }
  return { error: `${op.path} does not exist` }
}

/**
 * Applies RFC 6902 `add`, `replace` and `remove` ops to a copy of `spec` and checks the result with
 * `validateViewSpec`. All or nothing: any bad op or an invalid result returns every error as
 * `path: message` and leaves `spec` as it was. Never throws.
 */
export function applyPatch(spec: ViewSpec, rawOps: unknown): PatchResult {
  try {
    const { ops, errors } = readOps(rawOps)
    if (errors.length > 0) return { ok: false, errors }
    let doc: unknown = JSON.parse(JSON.stringify(spec))
    for (const [index, op] of ops.entries()) {
      const result = applyOp(doc, op)
      if ('error' in result) return { ok: false, errors: [{ path: `ops[${index}].path`, message: result.error }] }
      doc = result.doc
    }
    return validateViewSpec(doc)
  } catch (error) {
    return { ok: false, errors: [{ path: 'ops', message: `patch could not be applied: ${error instanceof Error ? error.message : String(error)}` }] }
  }
}
