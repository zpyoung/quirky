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
import { CLI_WORD_RE, checkKindEntry, cliGroupWord, effectiveCliWords, isMethodReference } from './kinds'

export const MANIFEST_FILE = 'quirky-plugin.json'

const FIELDS = new Set([
  'id',
  'name',
  'version',
  'description',
  'main',
  'ui',
  'cli',
  'cliAliases',
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

function hasLoneSurrogate(value: string): boolean {
  return /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(value)
}

function checkPluginPath(manifest: Record_, field: 'main' | 'ui' | 'cli', dir: string, errors: string[]): void {
  const value = manifest[field]
  if (value === undefined) return
  if (typeof value !== 'string' || value === '') {
    errors.push(`field '${field}' must be a non-empty string`)
    return
  }
  if (hasLoneSurrogate(value)) {
    errors.push(`field '${field}' must be a well-formed path`)
    return
  }
  const rel = relative(dir, resolve(dir, value))
  if (isAbsolute(value) || rel === '' || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) {
    errors.push(`field '${field}' must be a relative path inside the plugin directory, got '${value}'`)
  }
}

function checkDependencies(manifest: Record_, id: string | null, errors: string[]): void {
  const dependencies = stringList(manifest, 'dependencies', errors)
  if (!dependencies) return
  const seen = new Set<string>()
  for (const dependency of dependencies) {
    if (!isPluginId(dependency)) errors.push(`dependencies: invalid plugin ID '${dependency}'`)
    if (dependency === id) errors.push('dependencies: a plugin cannot depend on itself')
    if (seen.has(dependency)) errors.push(`dependencies: duplicate dependency '${dependency}'`)
    seen.add(dependency)
  }
}

function checkCliAliases(manifest: Record_, id: string | null, errors: string[]): void {
  const aliases = stringList(manifest, 'cliAliases', errors)
  if (!aliases) return
  const own = id === null ? null : cliGroupWord(id)
  const seen = new Set<string>()
  for (const alias of aliases) {
    if (!CLI_WORD_RE.test(alias)) errors.push(`cliAliases: '${alias}' must be a lowercase word such as 'tools' or 'my-tools'`)
    else if (alias === own) errors.push(`cliAliases: '${alias}' is the plugin's own group word`)
    else if (seen.has(alias)) errors.push(`cliAliases: duplicate alias '${alias}'`)
    seen.add(alias)
  }
}

function entriesOf(manifest: Record_, kind: string): Record_[] {
  const entries = isRecord(manifest.contributes) ? manifest.contributes[kind] : undefined
  return Array.isArray(entries) ? entries.filter(isRecord) : []
}

/** Rules that span entries: `describe` targets, `cli-command` methods, the `cli` module and distinct words. */
function checkCrossReferences(manifest: Record_, id: string | null, errors: string[]): void {
  const methods = new Map(entriesOf(manifest, 'method').map((entry) => [entry.id, entry]))
  for (const entry of methods.values()) {
    if (!isMethodReference(entry.describe) || entry.destructive !== true) continue
    const describe = entry.describe as string
    const slash = describe.indexOf('/')
    const name = describe.slice(slash + 1)
    const local = slash < 0 || describe.slice(0, slash) === id
    if (!local || methods.get(name)?.readOnly !== true) {
      errors.push(`method ${entry.id}: describe '${describe}' is not a readOnly method of this plugin`)
    }
  }

  const owners = new Map<string, string>()
  for (const entry of entriesOf(manifest, 'cli-command')) {
    const label = `cli-command ${entry.id}`
    if (entry.method === undefined && manifest.cli === undefined) {
      errors.push(`${label}: needs the manifest field 'cli' because it declares no method`)
    }
    if (typeof entry.method === 'string' && !entry.method.includes('/') && !methods.has(entry.method)) {
      errors.push(`${label}: method '${entry.method}' is not a method this plugin declares`)
    }
    if (typeof entry.id !== 'string' || (entry.words !== undefined && typeof entry.words !== 'string')) continue
    const words = effectiveCliWords(entry.id, entry.words)
    const first = owners.get(words)
    if (first === undefined) owners.set(words, entry.id)
    else if (words === '') errors.push(`${label}: words are already used by cli-command ${first} (the bare group command)`)
    else errors.push(`${label}: words '${words}' are already used by cli-command ${first}`)
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
      if (names.has(entry.id)) errors.push(`contributes.${kind}: duplicate name '${entry.id}'`)
      names.add(entry.id)
      checkKindEntry(kind, `${kind} ${entry.id}`, entry, errors)
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
    else {
      if (parsed.namespace === id) errors.push(`overrides: '${entry.id}' is in the plugin's own namespace, use contributes for your own IDs`)
      checkKindEntry(parsed.kind, `override ${entry.id}`, entry, errors)
    }
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
  checkPluginPath(raw, 'main', at.dir, errors)
  checkPluginPath(raw, 'ui', at.dir, errors)
  checkPluginPath(raw, 'cli', at.dir, errors)
  checkCliAliases(raw, id, errors)
  checkDependencies(raw, id, errors)
  checkContributes(raw.contributes, errors)
  checkCrossReferences(raw, id, errors)
  checkOverrides(raw.overrides, id, errors)
  checkDisables(raw, errors)

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, manifest: raw as PluginManifest }
}
