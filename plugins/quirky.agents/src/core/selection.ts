import type { AgentEntry, OptionUse, Selection, ValidSelection } from './types'

/** A pick or extra arguments the agent's catalog refuses; the message is the text shown to the user. */
export class SelectionError extends Error {}

const MAX_MODEL_LENGTH = 128
const MAX_OPTIONS = 16
const MAX_OPTION_ID_LENGTH = 64
const RESERVED_OPTION_IDS = new Set(['model', '__proto__', 'constructor', 'prototype'])

const invalid = (why: string): SelectionError => new SelectionError(`invalid launch selection: ${why}`)

function pickedOptions(value: unknown): [string, unknown][] {
  if (value === undefined || value === null) return []
  if (typeof value !== 'object' || Array.isArray(value)) throw invalid('options must be an object')
  const entries = Object.entries(value)
  if (entries.length > MAX_OPTIONS) throw invalid(`at most ${MAX_OPTIONS} options`)
  for (const [id] of entries) {
    if (id.length > MAX_OPTION_ID_LENGTH) throw invalid(`option IDs must be ${MAX_OPTION_ID_LENGTH} characters or fewer`)
    if (RESERVED_OPTION_IDS.has(id)) throw invalid(`option ID ${id} is reserved`)
  }
  return entries
}

function pickedModel(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw invalid('model must be a string')
  const model = value.trim()
  if (!model) throw invalid('model must not be empty')
  if (model.startsWith('-')) throw invalid('the model can\'t start with "-"')
  if (model.length > MAX_MODEL_LENGTH) throw invalid(`model must be ${MAX_MODEL_LENGTH} characters or fewer`)
  return model
}

/**
 * Checks a caller's pick against the agent's catalog and returns it normalized, or null when there
 * is no pick. Refuses, with the message shown to the user, anything the catalog doesn't offer for
 * that model: never clamps or drops a value. Whether a launch can carry an option is `resolve`'s check.
 */
export function validateSelection(
  entry: AgentEntry,
  raw: Selection | { model?: unknown; options?: unknown }
): ValidSelection | null {
  if (typeof raw !== 'object' || raw === null) throw invalid('selection must be an object')
  const model = pickedModel(raw.model)
  const options = pickedOptions(raw.options)
  if (model === null) {
    if (options.length === 0) return null
    throw new SelectionError(`${options[0]![0]} requires a model`)
  }

  const catalog = entry.launchOptions
  if (!catalog) throw new SelectionError(`Agent ${entry.id} does not support launch-time model selection.`)
  const listed = catalog.models.find((candidate) => candidate.id === model)
  if (!listed && catalog.unlisted === 'refuse') {
    throw new SelectionError(`Agent ${entry.id} does not support model ${model}.`)
  }
  const offered: OptionUse[] = listed ? listed.options : catalog.unlistedOptions

  const values: Record<string, string | boolean> = Object.create(null)
  for (const [id, value] of options) {
    if (typeof value !== 'string' && typeof value !== 'boolean') {
      throw invalid(`option ${id} must be a string or a boolean`)
    }
    const use = offered.find((candidate) => candidate.id === id)
    const decl = catalog.options.find((candidate) => candidate.id === id)
    const accepted =
      use && decl
        ? decl.type === 'boolean'
          ? typeof value === 'boolean'
          : typeof value === 'string' &&
            (use.choices ?? decl.choices?.map((choice) => choice.value) ?? []).includes(value)
        : false
    if (!accepted) throw new SelectionError(`Agent ${entry.id} model ${model} does not support ${id} ${value}.`)
    values[id] = value
  }
  return { model, values, listed: listed !== undefined }
}
