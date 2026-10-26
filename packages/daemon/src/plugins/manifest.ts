import { isAbsolute, relative, resolve } from 'node:path'
import {
  BUILTIN_PLUGIN_PREFIX,
  isContributionName,
  isKind,
  isPluginId,
  parseContributionId,
  type PluginManifest,
  type PluginSource,
} from '@quirky/protocol'

export const MANIFEST_FILE = 'quirky-plugin.json'

const FIELDS = new Set([
  'id',
  'name',
  'version',
  'description',
  'main',
  'activation',
  'dependencies',
  'contributes',
  'overrides',
  'disables',
])

type Record_ = Record<string, unknown>

function isRecord(value: unknown): value is Record_ {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredString(manifest: Record_, field: string, errors: string[]): string | null {
  const value = manifest[field]
  if (value === undefined) {
    errors.push(`missing required field '${field}'`)
    return null
  }
  if (typeof value !== 'string' || value === '') {
    errors.push(`field '${field}' must be a non-empty string`)
    return null
  }
  return value
}

function stringList(manifest: Record_, field: string, errors: string[]): string[] | null {
  const value = manifest[field]
  if (value === undefined) return null
  if (!Array.isArray(value)) {
    errors.push(`field '${field}' must be an array of strings`)
    return null
  }
  const strings: string[] = []
  value.forEach((item, index) => {
    if (typeof item === 'string') strings.push(item)
    else errors.push(`${field}[${index}] must be a string`)
  })
  return strings
}

function checkMain(main: unknown, dir: string, errors: string[]): void {
  if (main === undefined) return
  if (typeof main !== 'string' || main === '') {
    errors.push("field 'main' must be a non-empty string")
    return
  }
  const rel = relative(dir, resolve(dir, main))
  if (isAbsolute(main) || rel === '' || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) {
    errors.push(`field 'main' must be a relative path inside the plugin directory, got '${main}'`)
  }
}

function checkDependencies(manifest: Record_, id: string | null, errors: string[]): void {
  const dependencies = stringList(manifest, 'dependencies', errors)
  if (!dependencies) return
  const seen = new Set<string>()
  for (const dependency of dependencies) {
    if (dependency === id) errors.push('dependencies: a plugin cannot depend on itself')
    else if (seen.has(dependency)) errors.push(`dependencies: duplicate dependency '${dependency}'`)
    seen.add(dependency)
  }
}

function checkContributes(value: unknown, errors: string[]): void {
  if (value === undefined) return
  if (!isRecord(value)) {
    errors.push("field 'contributes' must be an object keyed by kind")
    return
  }
  for (const [kind, entries] of Object.entries(value)) {
    if (!isKind(kind)) errors.push(`contributes: kind '${kind}' is not valid`)
    if (!Array.isArray(entries)) {
      errors.push(`contributes.${kind} must be an array`)
      continue
    }
    const names = new Set<string>()
    entries.forEach((entry, index) => {
      if (!isRecord(entry) || typeof entry.id !== 'string') {
        errors.push(`contributes.${kind}[${index}] must be an object with a string id`)
        return
      }
      if (!isContributionName(entry.id)) errors.push(`contributes.${kind}: name '${entry.id}' is not valid`)
      else if (names.has(entry.id)) errors.push(`contributes.${kind}: duplicate name '${entry.id}'`)
      names.add(entry.id)
    })
  }
}

function checkOverrides(value: unknown, id: string | null, errors: string[]): void {
  if (value === undefined) return
  if (!Array.isArray(value)) {
    errors.push("field 'overrides' must be an array")
    return
  }
  const seen = new Set<string>()
  value.forEach((entry, index) => {
    if (!isRecord(entry) || typeof entry.id !== 'string') {
      errors.push(`overrides[${index}] must be an object with a string id`)
      return
    }
    const parsed = parseContributionId(entry.id)
    if (!parsed) errors.push(`overrides: override ID '${entry.id}' is not a valid contribution ID`)
    else if (parsed.namespace === id) errors.push(`overrides: '${entry.id}' is in the plugin's own namespace, use contributes for your own IDs`)
    if (seen.has(entry.id)) errors.push(`overrides: duplicate override ID '${entry.id}'`)
    seen.add(entry.id)
  })
}

function checkDisables(manifest: Record_, errors: string[]): void {
  for (const target of stringList(manifest, 'disables', errors) ?? []) {
    if (!parseContributionId(target)) errors.push(`disables: disables ID '${target}' is not a valid contribution ID`)
  }
}

/**
 * Validates the text of a `quirky-plugin.json` without running anything from the plugin.
 * Reports every problem it finds, so a plugin author fixes them in one pass.
 */
export function parseManifest(
  text: string,
  at: { dirName: string; dir: string; source: PluginSource },
): { ok: true; manifest: PluginManifest } | { ok: false; errors: string[] } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { ok: false, errors: [`${MANIFEST_FILE} can't be parsed: ${(error as Error).message}`] }
  }
  if (!isRecord(raw)) return { ok: false, errors: [`${MANIFEST_FILE} can't be parsed: expected a JSON object`] }

  const errors: string[] = []
  for (const field of Object.keys(raw)) {
    if (!FIELDS.has(field)) errors.push(`unknown field '${field}'`)
  }

  const id = requiredString(raw, 'id', errors)
  requiredString(raw, 'name', errors)
  requiredString(raw, 'version', errors)
  if (raw.description !== undefined && typeof raw.description !== 'string') errors.push("field 'description' must be a string")
  if (raw.activation !== undefined && raw.activation !== 'lazy' && raw.activation !== 'startup') {
    errors.push("field 'activation' must be 'lazy' or 'startup'")
  }

  if (id !== null) {
    if (!isPluginId(id)) errors.push(`id '${id}' is not a valid plugin ID`)
    if (id !== at.dirName) errors.push(`directory name doesn't match the ID: directory '${at.dirName}', id '${id}'`)
    if (at.source === 'installed' && id.startsWith(BUILTIN_PLUGIN_PREFIX)) {
      errors.push(`id '${id}': the ${BUILTIN_PLUGIN_PREFIX} prefix is reserved for built-ins`)
    }
  }
  checkMain(raw.main, at.dir, errors)
  checkDependencies(raw, id, errors)
  checkContributes(raw.contributes, errors)
  checkOverrides(raw.overrides, id, errors)
  checkDisables(raw, errors)

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, manifest: raw as PluginManifest }
}
