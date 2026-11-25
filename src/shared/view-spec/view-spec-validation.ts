import { COMPONENTS, nearestTypes } from './view-spec-catalog'
import {
  ID_FIELD,
  IMAGE_EXTENSIONS,
  isRequired,
  type Field,
  type Shape
} from './view-spec-catalog-schema'
import {
  addError,
  checkKeys,
  isFiniteNumber,
  isPlainObject,
  newCheck,
  shorten,
  utf8Length,
  type Check
} from './view-spec-check-state'
import { isLocalPreviewUrl, loadsRemoteHtml } from './view-spec-html-safety'
import { checkMarkdown } from './view-spec-markdown-links'
import { loadsImages } from './view-spec-mermaid-guard'
import { readQuestion } from './view-spec-question-validation'
import {
  ACTION_NAME_PATTERN,
  MAX_COLUMNS,
  MAX_DEPTH,
  MAX_NODES,
  MAX_SPEC_BYTES,
  MAX_TITLE_LENGTH,
  VIEW_NODE_TYPES,
  isViewNodeType,
  type ViewNode,
  type ViewNodeType,
  type ViewSpec,
  type ViewValidationError
} from './view-spec-types'

export { applyViewPatch, parseViewPatch, ViewPatchError } from './view-spec-patch'

function readString(
  raw: unknown,
  field: Extract<Field, { kind: 'string' }>,
  path: string,
  check: Check
): string | undefined {
  if (typeof raw !== 'string') {
    addError(check, path, 'must be a string')
    return undefined
  }
  if (field.required && raw.length === 0) {
    addError(check, path, 'must not be empty')
  }
  if (field.max !== undefined && (field.bytes ? utf8Length(raw) : raw.length) > field.max) {
    addError(check, path, `must be at most ${field.max} ${field.bytes ? 'bytes' : 'characters'}`)
  }
  if (field.pattern && !field.pattern.test(raw)) {
    addError(check, path, `must be ${field.hint ?? `in the form ${field.pattern}`}`)
  }
  if (field.markdown) {
    checkMarkdown(raw, path, check.errors)
  }
  if (field.ident && ACTION_NAME_PATTERN.test(raw)) {
    if (check.ids.has(raw)) {
      addError(check, path, `duplicate id '${raw}'`)
    }
    check.ids.add(raw)
  }
  return raw
}

function readShape(
  raw: Record<string, unknown>,
  shape: Shape,
  path: string,
  check: Check
): Record<string, unknown> {
  checkKeys(raw, Object.keys(shape), path, check)
  const out: Record<string, unknown> = {}
  for (const [name, field] of Object.entries(shape)) {
    const value = Object.hasOwn(raw, name) ? raw[name] : undefined
    const fieldPath = path ? `${path}.${name}` : name
    if (value === undefined) {
      if (isRequired(field)) {
        addError(check, fieldPath, 'is required')
      }
      continue
    }
    const read = readField(value, field, fieldPath, check)
    if (read !== undefined) {
      out[name] = read
    }
  }
  return out
}

function readField(value: unknown, field: Field, path: string, check: Check): unknown {
  switch (field.kind) {
    case 'string':
      return readString(value, field, path, check)
    case 'enum':
      if (typeof value === 'string' && field.values.includes(value)) {
        return value
      }
      addError(check, path, `must be one of ${field.values.join(' | ')}`)
      return undefined
    case 'number':
      if (!isFiniteNumber(value)) {
        return void addError(check, path, 'must be a finite number')
      }
      if (
        (field.min !== undefined && value < field.min) ||
        (field.max !== undefined && value > field.max)
      ) {
        addError(
          check,
          path,
          `must be between ${field.min ?? '-Infinity'} and ${field.max ?? 'Infinity'}`
        )
      }
      return value
    case 'boolean':
      if (typeof value === 'boolean') {
        return value
      }
      addError(check, path, 'must be a boolean')
      return undefined
    case 'text-or-number':
      if (isFiniteNumber(value) || typeof value === 'string') {
        return value
      }
      addError(check, path, 'must be a string or a finite number')
      return undefined
    case 'strings': {
      if (!Array.isArray(value)) {
        return void addError(check, path, 'must be an array of strings')
      }
      if (value.length < field.min) {
        addError(check, path, `needs at least ${field.min} entry`)
      }
      if (value.length > field.max) {
        return void addError(check, path, `at most ${field.max} entries allowed`)
      }
      value.forEach((entry, index) => {
        if (typeof entry !== 'string') {
          addError(check, `${path}[${index}]`, 'must be a string')
        }
      })
      return value
    }
    case 'matrix': {
      if (!Array.isArray(value)) {
        return void addError(check, path, 'must be an array of rows')
      }
      if (value.length > field.max) {
        return void addError(check, path, `at most ${field.max} rows allowed`)
      }
      value.forEach((row, index) => {
        if (!Array.isArray(row)) {
          return addError(check, `${path}[${index}]`, 'must be an array of strings')
        }
        row.forEach((cell, cellIndex) => {
          if (typeof cell !== 'string') {
            addError(check, `${path}[${index}][${cellIndex}]`, 'must be a string')
          }
        })
      })
      return value
    }
    case 'list': {
      if (!Array.isArray(value)) {
        return void addError(check, path, 'must be an array')
      }
      if (value.length < field.min) {
        addError(check, path, `needs at least ${field.min} entry`)
      }
      if (value.length > field.max) {
        return void addError(check, path, `at most ${field.max} ${field.what} allowed`)
      }
      return value.map((entry, index) => {
        const entryPath = `${path}[${index}]`
        if (!isPlainObject(entry)) {
          addError(check, entryPath, 'must be an object')
          return {}
        }
        return readShape(entry, field.of, entryPath, check)
      })
    }
    case 'question':
      return readQuestion(value, path, check)
  }
}

type NodeCheck = (props: Record<string, unknown>, path: string, check: Check) => void

const SCHEME = /^[a-z][a-z0-9+.-]*:/i
const IMAGE_EXTENSION = new RegExp(`\\.(${IMAGE_EXTENSIONS.join('|')})$`, 'i')

const NODE_CHECKS: Partial<Record<ViewNodeType, NodeCheck>> = {
  table(props, path, check) {
    const { columns, rows } = props
    if (!Array.isArray(columns) || !Array.isArray(rows)) {
      return
    }
    rows.forEach((row, index) => {
      if (Array.isArray(row) && row.length !== columns.length) {
        addError(
          check,
          `${path}.props.rows[${index}]`,
          `row has ${row.length} cells; the table has ${columns.length} columns`
        )
      }
    })
  },
  diagram(props, path, check) {
    if (typeof props.source === 'string' && loadsImages(props.source)) {
      addError(
        check,
        `${path}.props.source`,
        'diagram source must not load images or remote content (img: shapes, <img>, url() and similar are refused)'
      )
    }
  },
  image(props, path, check) {
    const value = props.path
    if (typeof value !== 'string') {
      return
    }
    const at = `${path}.props.path`
    if (value.startsWith('/') || value.startsWith('\\') || SCHEME.test(value)) {
      addError(check, at, 'image path must be relative to the worktree')
    } else if (value.split(/[\\/]/).includes('..')) {
      addError(check, at, "image path must not contain '..' segments")
    } else if (!IMAGE_EXTENSION.test(value)) {
      addError(
        check,
        at,
        `image path must end in ${IMAGE_EXTENSIONS.slice(0, -1).join(', ')} or ${IMAGE_EXTENSIONS.at(-1)}`
      )
    }
  },
  html(props, path, check) {
    if (typeof props.html === 'string' && loadsRemoteHtml(props.html)) {
      addError(
        check,
        `${path}.props.html`,
        'remote content is not allowed in html; inline it as data:'
      )
    }
  },
  'live-preview'(props, path, check) {
    if (typeof props.url === 'string' && !isLocalPreviewUrl(props.url)) {
      addError(
        check,
        `${path}.props.url`,
        'url must be http:// on localhost, 127.0.0.1 or *.quirky.localhost'
      )
    }
  },
  matrix(props, path, check) {
    const { columns, rows } = props
    if (!Array.isArray(columns) || !Array.isArray(rows)) {
      return
    }
    rows.forEach((row: Record<string, unknown>, index) => {
      const cells = row.cells
      if (Array.isArray(cells) && cells.length !== columns.length) {
        addError(
          check,
          `${path}.props.rows[${index}].cells`,
          `row has ${cells.length} cells; the matrix has ${columns.length} columns`
        )
      }
      if (!Array.isArray(row.highlight)) {
        return
      }
      row.highlight.forEach((name, at) => {
        if (typeof name === 'string' && !columns.includes(name)) {
          addError(
            check,
            `${path}.props.rows[${index}].highlight[${at}]`,
            `'${shorten(name)}' is not a column name`
          )
        }
      })
    })
  },
  'annotated-code'(props, path, check) {
    const { code, notes } = props
    if (typeof code !== 'string' || !Array.isArray(notes)) {
      return
    }
    const total = code.split('\n').length - (code.endsWith('\n') ? 1 : 0)
    notes.forEach((note: Record<string, unknown>, index) => {
      if (typeof note.lines !== 'string') {
        return
      }
      const at = `${path}.props.notes[${index}].lines`
      const match = /^(\d{1,6})(?:-(\d{1,6}))?$/.exec(note.lines)
      if (!match) {
        return addError(check, at, 'lines must be a line number like "4" or a range like "3-7"')
      }
      const first = Number(match[1])
      const last = match[2] === undefined ? first : Number(match[2])
      if (first < 1 || last < first || last > total) {
        addError(check, at, `lines must fall within the code's ${total} lines`)
      }
    })
  }
}

function readNode(raw: unknown, path: string, depth: number, check: Check): ViewNode | undefined {
  if (!isPlainObject(raw)) {
    return void addError(check, path, 'node must be an object')
  }
  checkKeys(raw, ['type', 'id', 'props', 'children'], path, check)
  const type = raw.type
  if (typeof type !== 'string') {
    return void addError(check, `${path}.type`, 'type is required and must be a string')
  }
  if (!isViewNodeType(type)) {
    const near = nearestTypes(type)
    addError(
      check,
      `${path}.type`,
      near.length > 0
        ? `unknown type '${shorten(type)}'; did you mean ${near.join(', ')}?`
        : `unknown type '${shorten(type)}'; the catalog has ${VIEW_NODE_TYPES.join(', ')}`
    )
    return undefined
  }
  if (check.nodeLimitHit) {
    return undefined
  }
  if (++check.nodes > MAX_NODES) {
    check.nodeLimitHit = true
    addError(check, path, `at most ${MAX_NODES} nodes allowed`)
    return undefined
  }
  if (depth > MAX_DEPTH) {
    addError(check, path, `nesting must be at most ${MAX_DEPTH} levels deep`)
    return undefined
  }
  const component = COMPONENTS[type]
  const node: ViewNode = { type }
  const id = raw.id === undefined ? undefined : readString(raw.id, ID_FIELD, `${path}.id`, check)
  if (id !== undefined && ACTION_NAME_PATTERN.test(id)) {
    node.id = id
  }

  const rawProps = raw.props
  if (rawProps !== undefined && !isPlainObject(rawProps)) {
    addError(check, `${path}.props`, 'props must be an object')
  }
  const props = readShape(
    isPlainObject(rawProps) ? rawProps : {},
    component.shape,
    `${path}.props`,
    check
  )
  if (Object.keys(props).length > 0) {
    node.props = props
  }
  NODE_CHECKS[type]?.(props, path, check)

  const rawChildren = raw.children
  if (rawChildren === undefined) {
    return node
  }
  if (!Array.isArray(rawChildren)) {
    return void addError(check, `${path}.children`, 'children must be an array')
  }
  if (component.container === undefined) {
    if (rawChildren.length > 0) {
      addError(check, `${path}.children`, `${type} cannot have children`)
    }
    return node
  }
  if (component.container === 'columns' && rawChildren.length > MAX_COLUMNS) {
    addError(check, `${path}.children`, `columns allows at most ${MAX_COLUMNS} children`)
    return node
  }
  const children: ViewNode[] = []
  rawChildren.forEach((child, index) => {
    const read = readNode(child, `${path}.children[${index}]`, depth + 1, check)
    if (read) {
      children.push(read)
    }
  })
  if (children.length > 0) {
    node.children = children
  }
  return node
}

function encodedSize(raw: unknown): number | 'unserializable' {
  try {
    return new TextEncoder().encode(JSON.stringify(raw)).length
  } catch {
    return 'unserializable'
  }
}

export type ViewSpecCheckResult =
  | { ok: true; spec: ViewSpec }
  | { ok: false; errors: ViewValidationError[] }

/**
 * Checks an untrusted spec against the catalog and the limits. Pure and never throws: every
 * refusal is a path and message, and all of them are collected. On success `spec` is canonical,
 * holding only known fields.
 */
export function checkViewSpec(raw: unknown): ViewSpecCheckResult {
  try {
    if (!isPlainObject(raw)) {
      return { ok: false, errors: [{ path: '', message: 'view spec must be an object' }] }
    }
    const size = encodedSize(raw)
    if (size === 'unserializable') {
      return { ok: false, errors: [{ path: '', message: 'view spec must be plain JSON' }] }
    }
    if (size > MAX_SPEC_BYTES) {
      return {
        ok: false,
        errors: [
          {
            path: '',
            message: `view spec is ${size} bytes; at most ${MAX_SPEC_BYTES} bytes allowed`
          }
        ]
      }
    }
    const check = newCheck()
    checkKeys(raw, ['title', 'root'], '', check)
    let title = ''
    if (typeof raw.title !== 'string' || raw.title.trim() === '') {
      addError(check, 'title', 'title is required and must be a non-empty string')
    } else if (raw.title.length > MAX_TITLE_LENGTH) {
      addError(check, 'title', `title must be at most ${MAX_TITLE_LENGTH} characters`)
    } else {
      title = raw.title
    }
    const root =
      raw.root === undefined
        ? (addError(check, 'root', 'root is required'), undefined)
        : readNode(raw.root, 'root', 1, check)
    if (check.errors.length > 0 || root === undefined) {
      return { ok: false, errors: check.errors }
    }
    return { ok: true, spec: { title, root } }
  } catch (error) {
    return {
      ok: false,
      errors: [
        {
          path: '',
          message: `view spec could not be checked: ${error instanceof Error ? error.message : String(error)}`
        }
      ]
    }
  }
}

/** One line for a refusal: `<path>: <message>` per error, joined with `; `. */
export function formatViewErrors(errors: readonly ViewValidationError[]): string {
  return errors
    .map((error) => (error.path ? `${error.path}: ${error.message}` : error.message))
    .join('; ')
}

/**
 * Validates an untrusted view spec for the CLI, the host and the renderer. Never throws. Each error
 * is one problem written `path: message` (just the message when it concerns the whole spec), and
 * every problem is reported at once. On success `spec` is canonical, holding only known fields.
 */
export function validateViewSpec(
  input: unknown
): { ok: true; spec: ViewSpec } | { ok: false; errors: string[] } {
  const result = checkViewSpec(input)
  if (result.ok) {
    return result
  }
  return { ok: false, errors: result.errors.map((error) => formatViewErrors([error])) }
}
