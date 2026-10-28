import type { LaunchCatalog, ModelDecl } from './types'
import { parseModelDeclarations } from './launch-options'

/** Accepts only the owner command's bounded JSON model-list envelope and declared option IDs. */
export function parseDiscoveredModels(stdout: string, catalog: LaunchCatalog): ModelDecl[] {
  const value: unknown = JSON.parse(stdout)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('provider output must be a JSON object')
  const data = value as Record<string, unknown>
  if (Object.keys(data).length !== 1 || !Object.hasOwn(data, 'models')) throw new Error('provider output must contain only a models list')
  if (!Array.isArray(data.models)) throw new Error('provider output models must be a list')
  return parseModelDeclarations(data.models, catalog.options)
}

/** Maps the official Codex app-server `model/list` response into the provider catalog shape. */
export function parseCodexAppServerModels(stdout: string, catalog: LaunchCatalog): ModelDecl[] {
  const value: unknown = JSON.parse(stdout)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Codex model output must be an object')
  }
  const envelope = value as Record<string, unknown>
  if (Object.keys(envelope).length !== 2 || !Object.hasOwn(envelope, 'data') ||
    !Array.isArray(envelope.data) || envelope.nextCursor !== null) {
    throw new Error('Codex model output must be a complete model/list snapshot')
  }
  const models = envelope.data.map((value): Record<string, unknown> => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('Codex model entry must be an object')
    }
    const model = value as Record<string, unknown>
    if (typeof model.id !== 'string' || model.id.trim() === '' || model.hidden === true) {
      throw new Error('Codex model entry has an invalid ID or visibility')
    }
    const label = model.displayName === undefined ? model.id :
      typeof model.displayName === 'string' && model.displayName.trim() !== '' ? model.displayName : null
    if (label === null) throw new Error('Codex model entry has an invalid display name')
    const efforts = model.supportedReasoningEfforts === undefined ? [] : model.supportedReasoningEfforts
    if (!Array.isArray(efforts)) throw new Error('Codex model efforts must be a list')
    const choices = efforts.map((item) => {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        throw new Error('Codex model effort must be an object')
      }
      const effort = (item as Record<string, unknown>).reasoningEffort
      if (typeof effort !== 'string' || effort.trim() === '') throw new Error('Codex model effort is invalid')
      return effort
    })
    if (new Set(choices).size !== choices.length) throw new Error('Codex model efforts contain duplicates')
    return {
      id: model.id,
      label,
      description: null,
      options: choices.length === 0 ? [] : [{ id: 'effort', choices }]
    }
  })
  return parseModelDeclarations(models, catalog.options)
}
