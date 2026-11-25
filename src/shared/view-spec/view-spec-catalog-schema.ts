import { ACTION_NAME_PATTERN, MAX_ID_LENGTH } from './view-spec-types'
import type { ViewNode, ViewNodeType } from './view-spec-types'

/** The prop-shape vocabulary the catalog is written in and the validator reads. */

export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] as const
export const FILE_STATUSES = ['added', 'modified', 'deleted', 'renamed', 'touched'] as const
export const SKETCH_SHAPES = ['box', 'ellipse', 'line', 'arrow', 'text'] as const
export const TONES = ['neutral', 'good', 'warn', 'bad'] as const
export const CALLOUT_TONES = ['info', 'good', 'warn', 'bad'] as const
export const STATUS_STATES = ['ok', 'warn', 'bad', 'pending'] as const
export const STEP_STATES = ['done', 'active', 'pending', 'failed'] as const
export const BUTTON_VARIANTS = ['primary', 'ghost'] as const
export const ID_HINT = `lowercase letters, digits and dashes, 1 to ${MAX_ID_LENGTH} characters`

export type Field =
  | {
      kind: 'string'
      required?: boolean
      max?: number
      bytes?: boolean
      markdown?: boolean
      pattern?: RegExp
      hint?: string
      ident?: boolean
    }
  | { kind: 'enum'; values: readonly string[]; required?: boolean }
  | { kind: 'number'; required?: boolean; min?: number; max?: number }
  | { kind: 'boolean'; required?: boolean }
  | { kind: 'text-or-number'; required?: boolean }
  | { kind: 'strings'; min: number; max: number; optional?: boolean }
  | { kind: 'list'; of: Shape; min: number; max: number; what: string }
  | { kind: 'matrix'; max: number }
  | { kind: 'question' }

export type Shape = Record<string, Field>

export type Component = {
  summary: string
  container?: 'any' | 'columns'
  shape: Shape
  example: ViewNode
}

export function isRequired(field: Field): boolean {
  if (field.kind === 'strings') {
    return field.optional !== true
  }
  return (
    field.kind === 'list' ||
    field.kind === 'matrix' ||
    field.kind === 'question' ||
    field.required === true
  )
}

export const ID_FIELD: Extract<Field, { kind: 'string' }> = {
  kind: 'string',
  ident: true,
  pattern: ACTION_NAME_PATTERN,
  hint: ID_HINT
}
export const CAPTION_FIELD: Field = { kind: 'string', max: 200 }
export const TONE_FIELD: Field = { kind: 'enum', values: TONES }

export const ITEM_STATE_SHAPE = (states: readonly string[], text: string): Shape => ({
  [text]: { kind: 'string', required: true },
  state: { kind: 'enum', values: states, required: true }
})

export type VisualNodeType =
  | 'diagram'
  | 'image'
  | 'html'
  | 'live-preview'
  | 'timeline'
  | 'board'
  | 'matrix'
  | 'annotated-code'
  | 'file-map'
  | 'plot'
  | 'sketch'

export type BasicNodeType = Exclude<ViewNodeType, VisualNodeType>
