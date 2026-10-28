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
