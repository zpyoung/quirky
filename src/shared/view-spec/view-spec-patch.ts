import { isPlainObject } from './view-spec-check-state'
import {
  MAX_PATCH_OPS,
  type ViewPatch,
  type ViewPatchOp,
  type ViewSpec,
  type ViewValidationError
} from './view-spec-types'

const OPS = ['add', 'replace', 'remove'] as const
const CANONICAL_INDEX = /^(?:0|[1-9]\d*)$/

/** A patch that is malformed or cannot be applied; `errors` are `path: message` pairs. */
export class ViewPatchError extends Error {
  readonly errors: ViewValidationError[]

  constructor(errors: ViewValidationError[]) {
    super(errors.map((error) => `${error.path}: ${error.message}`).join('; '))
    this.name = 'ViewPatchError'
    this.errors = errors
  }
}

function isPatchOpName(value: unknown): value is ViewPatchOp['op'] {
  return typeof value === 'string' && OPS.some((op) => op === value)
}

/** The segments of a JSON Pointer with `~1` and `~0` undone, or undefined when it is not one. */
function parsePointer(pointer: string): string[] | undefined {
  if (pointer === '') {
    return []
  }
  if (!pointer.startsWith('/') || /~(?![01])/.test(pointer)) {
    return undefined
  }
  return pointer
    .slice(1)
    .split('/')
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'))
}

function readOps(raw: unknown): { ops: ViewPatchOp[]; errors: ViewValidationError[] } {
  const errors: ViewValidationError[] = []
  if (!Array.isArray(raw)) {
    return { ops: [], errors: [{ path: 'ops', message: 'must be an array of operations' }] }
  }
  if (raw.length > MAX_PATCH_OPS) {
    return { ops: [], errors: [{ path: 'ops', message: `at most ${MAX_PATCH_OPS} ops allowed` }] }
  }
  const ops: ViewPatchOp[] = []
  raw.forEach((entry: unknown, index) => {
    const at = `ops[${index}]`
    if (!isPlainObject(entry)) {
      return void errors.push({ path: at, message: 'must be an object' })
    }
    for (const key of Object.keys(entry)) {
      if (key !== 'op' && key !== 'path' && key !== 'value') {
        errors.push({
          path: `${at}.${key}`,
          message: `unknown field '${key}'; allowed: op, path, value`
        })
      }
    }
    const op = entry.op
    if (!isPatchOpName(op)) {
      return void errors.push({ path: `${at}.op`, message: `must be one of ${OPS.join(' | ')}` })
    }
    if (typeof entry.path !== 'string') {
      return void errors.push({ path: `${at}.path`, message: 'must be a JSON Pointer string' })
    }
    if (op !== 'remove' && entry.value === undefined) {
      return void errors.push({ path: `${at}.value`, message: `is required for ${op}` })
    }
    ops.push({ op, path: entry.path, ...(entry.value === undefined ? {} : { value: entry.value }) })
  })
  return { ops, errors }
}

/**
 * Checks untrusted patch input: an `{ ops }` object whose `ops` is an array of at most 200
 * `add`/`replace`/`remove` operations. Never throws. Whether the paths exist is only known when
 * the patch is applied.
 */
export function parseViewPatch(
  input: unknown
): { ok: true; patch: ViewPatch } | { ok: false; errors: string[] } {
  if (!isPlainObject(input) || !Object.hasOwn(input, 'ops')) {
    return { ok: false, errors: ['ops: is required'] }
  }
  const { ops, errors } = readOps(input.ops)
  if (errors.length > 0) {
    return { ok: false, errors: errors.map((error) => `${error.path}: ${error.message}`) }
  }
  return { ok: true, patch: { ops } }
}

function child(
  container: unknown,
  segment: string
): { found: true; value: unknown } | { found: false } {
  if (Array.isArray(container)) {
    const index = CANONICAL_INDEX.test(segment) ? Number(segment) : -1
    return index >= 0 && index < container.length
      ? { found: true, value: container[index] }
      : { found: false }
  }
  if (isPlainObject(container) && Object.hasOwn(container, segment)) {
    return { found: true, value: container[segment] }
  }
  return { found: false }
}

/** Applies one op to `doc`, returning the new root, or the problem as a message for `ops[i].path`. */
function applyOp(doc: unknown, op: ViewPatchOp): { doc: unknown } | { error: string } {
  const segments = parsePointer(op.path)
  if (segments === undefined) {
    return { error: `'${op.path}' is not a JSON Pointer` }
  }
  const value: unknown = op.op === 'remove' ? undefined : JSON.parse(JSON.stringify(op.value))
  if (segments.length === 0) {
    return op.op === 'remove' ? { error: 'the whole spec cannot be removed' } : { doc: value }
  }

  let parent = doc
  for (const segment of segments.slice(0, -1)) {
    const next = child(parent, segment)
    if (!next.found) {
      return { error: `${op.path} does not exist` }
    }
    parent = next.value
  }
  const last = segments.at(-1)
  if (last === undefined) {
    return { error: `${op.path} does not exist` }
  }

  if (Array.isArray(parent)) {
    if (last === '-' && op.op === 'add') {
      parent.push(value)
      return { doc }
    }
    if (!CANONICAL_INDEX.test(last)) {
      return { error: `${op.path} does not exist` }
    }
    const index = Number(last)
    if (op.op === 'add') {
      if (index > parent.length) {
        return { error: `index ${last} is out of range` }
      }
      parent.splice(index, 0, value)
    } else {
      if (index >= parent.length) {
        return { error: `${op.path} does not exist` }
      }
      if (op.op === 'replace') {
        parent[index] = value
      } else {
        parent.splice(index, 1)
      }
    }
    return { doc }
  }
  if (isPlainObject(parent)) {
    if (op.op !== 'add' && !Object.hasOwn(parent, last)) {
      return { error: `${op.path} does not exist` }
    }
    if (op.op === 'remove') {
      delete parent[last]
    }
    // defineProperty so a `__proto__` key becomes plain data instead of reassigning the prototype
    else {
      Object.defineProperty(parent, last, {
        value,
        enumerable: true,
        writable: true,
        configurable: true
      })
    }
    return { doc }
  }
  return { error: `${op.path} does not exist` }
}

/**
 * Applies RFC 6902 `add`, `replace` and `remove` operations (JSON Pointer paths, `-` appends,
 * `~0` and `~1` escapes) to a deep copy of `spec`, in order. All or nothing: `spec` is never
 * mutated, and a malformed patch or an op that cannot apply throws a `ViewPatchError` naming each
 * problem as `ops[i].path: message`.
 *
 * The result is only structurally a spec. Callers must run it through `validateViewSpec` before
 * storing or rendering it.
 */
export function applyViewPatch(spec: ViewSpec, patch: ViewPatch): ViewSpec {
  const { ops, errors } = readOps(patch.ops)
  if (errors.length > 0) {
    throw new ViewPatchError(errors)
  }
  let doc: unknown = JSON.parse(JSON.stringify(spec))
  for (const [index, op] of ops.entries()) {
    const result = applyOp(doc, op)
    if ('error' in result) {
      throw new ViewPatchError([{ path: `ops[${index}].path`, message: result.error }])
    }
    doc = result.doc
  }
  // SAFETY: ops can replace any part of the spec, so the shape is unchecked until the caller validates it.
  return doc as ViewSpec
}
