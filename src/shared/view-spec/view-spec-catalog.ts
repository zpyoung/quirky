import { BASIC_COMPONENTS } from './view-spec-catalog-basic-components'
import {
  ID_HINT,
  isRequired,
  type Component,
  type Field,
  type PropFields
} from './view-spec-catalog-schema'
import { VISUAL_COMPONENTS } from './view-spec-catalog-visual-components'
import {
  MAX_CHART_POINTS,
  MAX_COLUMNS,
  MAX_DEPTH,
  MAX_NODES,
  MAX_SPEC_BYTES,
  MAX_TABLE_ROWS,
  VIEW_NODE_TYPES,
  type ViewNodeType
} from './view-spec-types'

/** Every component an agent can draw, plus the guide text `quirky view` prints. */

/** The catalog entry for each kind. */
export const COMPONENTS: Record<ViewNodeType, Component> = {
  ...BASIC_COMPONENTS,
  ...VISUAL_COMPONENTS
}

function levenshtein(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const above = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1))
      diagonal = above
    }
  }
  return row[b.length]
}

/** The catalog types nearest to `name`, closest first; empty when nothing is plausibly meant. */
export function nearestTypes(name: string, limit = 3): ViewNodeType[] {
  const lower = name.toLowerCase()
  return VIEW_NODE_TYPES.map((type) => ({
    type,
    distance: lower.includes(type) || type.includes(lower) ? 0 : levenshtein(lower, type)
  }))
    .filter(({ type, distance }) => distance <= Math.max(2, Math.floor(type.length / 3)))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit)
    .map(({ type }) => type)
}

function describeField(field: Field): string {
  switch (field.kind) {
    case 'string':
      return field.ident ? 'string (an id)' : 'string'
    case 'enum':
      return field.values.join('|')
    case 'number':
      return field.min !== undefined && field.max !== undefined
        ? `number (${field.min} to ${field.max})`
        : 'number'
    case 'boolean':
      return 'boolean'
    case 'text-or-number':
      return 'string|number'
    case 'strings':
      return 'string[]'
    case 'matrix':
      return 'string[][]'
    case 'question':
      return 'ask question object (see field)'
    case 'list':
      return `{${describeFields(field.of)}}[]`
  }
}

function describeFields(fields: PropFields): string {
  return Object.entries(fields)
    .map(([name, field]) => {
      return `${name}${isRequired(field) ? '' : '?'}: ${describeField(field)}`
    })
    .join(', ')
}

/** The agent-facing guide: the spec envelope, the limits, and every component with its props and one example. */
export function catalogGuide(): string {
  const lines = [
    'View spec',
    '  {"title": string, "root": node}; a node is {"type": <component>, "id"?: string, "props": {...}, "children": [node, ...]}.',
    `  An id is ${ID_HINT}, and unique in the spec, timeline items, board cards and sketch shapes included. A user points at an element by its id, so keep ids the same when you update.`,
    '  Props are strings, except numbers in charts, plots, sketches and fields and booleans in fields and html. There are no style, class, event or URL props.',
    `  Limits: at most ${MAX_NODES} nodes, ${MAX_DEPTH} levels deep, ${MAX_SPEC_BYTES / 1024} KiB encoded, ${MAX_TABLE_ROWS} table rows, ${MAX_CHART_POINTS} chart points.`,
    '  An invalid spec is refused whole: nothing renders and the errors print as `path: message; ...` with exit code 2.',
    '',
    'Components'
  ]
  for (const type of VIEW_NODE_TYPES) {
    const component = COMPONENTS[type]
    const props = describeFields(component.props)
    lines.push('', `  ${type}: ${component.summary}`, `    props: ${props || 'none'}`)
    if (component.container) {
      lines.push(
        `    children: ${component.container === 'columns' ? `up to ${MAX_COLUMNS} nodes` : 'any nodes'}`
      )
    }
    lines.push(`    example: ${JSON.stringify(component.example)}`)
  }
  return lines.join('\n')
}
