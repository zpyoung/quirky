import { isPluginId, parseContributionId } from './plugins'
import { parseChord } from './ui'

/** File at the root of a distro directory. */
export const DISTRO_MANIFEST_FILE = 'quirky-distro.json'

/** The parsed contents of a `quirky-distro.json`. */
export type DistroManifest = {
  /** Plugin-ID syntax. */
  id: string
  name: string
  version: string
  description?: string
  /** Relative directories of the plugins the distro bundles. */
  plugins?: string[]
  /** Plugin or contribution IDs to turn off. */
  disable?: string[]
  /** Setting ID to the value the distro layers under the user's own. */
  settings?: Record<string, boolean | number | string>
  /** A theme contribution ID. */
  theme?: string
  /** Chord to command ID. */
  keybindings?: Record<string, string>
}

/** An installed distro as listed by `distro.list`. */
export type DistroInfo = {
  id: string
  name: string
  version: string
  description?: string
  /** IDs of the plugins it installed. */
  plugins: string[]
  installedAt: number
}

/** What installing a plugin would add, read without running its code. */
export type PluginInspection = {
  id: string
  name: string
  version: string
  description?: string
  contributions: { kind: string; id: string; data: Record<string, unknown> }[]
  overrides: { id: string; replaces: string }[]
  disables: string[]
  /** Present when the plugin is already installed. */
  installed?: { version: string; added: string[]; removed: string[] }
}

/** What installing a distro would change. */
export type DistroInspection = {
  manifest: DistroManifest
  plugins: PluginInspection[]
  settings: { id: string; current: unknown; next: unknown }[]
}

const MANIFEST_FIELDS = new Set(['id', 'name', 'version', 'description', 'plugins', 'disable', 'settings', 'theme', 'keybindings'])

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredString(raw: JsonRecord, field: string, errors: string[]): string | null {
  const value = raw[field]
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

function stringList(raw: JsonRecord, field: string, errors: string[]): string[] | null {
  const value = raw[field]
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

/** The canonical form of a relative directory, or null when it is absolute, empty or leaves the distro. */
function insideDirectory(path: string): string | null {
  if (path === '' || path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:/.test(path)) return null
  const kept: string[] = []
  for (const segment of path.split(/[\\/]/)) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (kept.pop() === undefined) return null
      continue
    }
    kept.push(segment)
  }
  return kept.length === 0 ? null : kept.join('/')
}

function checkPlugins(raw: JsonRecord, errors: string[]): void {
  const dirs = stringList(raw, 'plugins', errors)
  const seen = new Set<string>()
  for (const dir of dirs ?? []) {
    const inside = insideDirectory(dir)
    if (inside === null) {
      errors.push(`plugins: '${dir}' must be a relative directory inside the distro`)
      continue
    }
    if (seen.has(inside)) errors.push(`plugins: duplicate directory '${dir}'`)
    seen.add(inside)
  }
}

function checkDisable(raw: JsonRecord, errors: string[]): void {
  const seen = new Set<string>()
  for (const entry of stringList(raw, 'disable', errors) ?? []) {
    if (!isPluginId(entry) && parseContributionId(entry) === null) {
      errors.push(`disable: '${entry}' is not a plugin ID or a contribution ID`)
    }
    if (seen.has(entry)) errors.push(`disable: duplicate entry '${entry}'`)
    seen.add(entry)
  }
}

function checkSettings(raw: JsonRecord, errors: string[]): void {
  const settings = raw.settings
  if (settings === undefined) return
  if (!isRecord(settings)) {
    errors.push("field 'settings' must be an object")
    return
  }
  for (const [id, value] of Object.entries(settings)) {
    if (parseContributionId(id)?.kind !== 'setting') errors.push(`settings: '${id}' is not a setting contribution ID`)
    const scalar = typeof value === 'boolean' || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))
    if (!scalar) errors.push(`settings: value of '${id}' must be a boolean, number or string`)
  }
}

function checkTheme(raw: JsonRecord, errors: string[]): void {
  const theme = raw.theme
  if (theme === undefined) return
  if (typeof theme !== 'string' || parseContributionId(theme)?.kind !== 'theme') {
    errors.push(`theme: ${typeof theme === 'string' ? `'${theme}'` : 'the value'} is not a theme contribution ID`)
  }
}

function checkKeybindings(raw: JsonRecord, errors: string[]): void {
  const keybindings = raw.keybindings
  if (keybindings === undefined) return
  if (!isRecord(keybindings)) {
    errors.push("field 'keybindings' must be an object")
    return
  }
  const chords = new Map<string, string>()
  for (const [written, command] of Object.entries(keybindings)) {
    const parsed = parseChord(written)
    if (!parsed.ok) errors.push(`keybindings: ${written}: ${parsed.error}`)
    else {
      if (chords.has(parsed.chord)) errors.push(`keybindings: '${written}' repeats the chord ${parsed.chord}`)
      chords.set(parsed.chord, written)
    }
    if (typeof command !== 'string' || parseContributionId(command)?.kind !== 'command') {
      errors.push(`keybindings: value of '${written}' must be a command contribution ID, got '${String(command)}'`)
    }
  }
}

/**
 * Validates the text of a `quirky-distro.json` without touching the filesystem. Reports every
 * problem in one pass; on success keybinding chords are in canonical form.
 */
export function parseDistroManifest(
  text: string
): { ok: true; manifest: DistroManifest } | { ok: false; errors: string[] } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { ok: false, errors: [`${DISTRO_MANIFEST_FILE} can't be parsed: ${(error as Error).message}`] }
  }
  if (!isRecord(raw)) return { ok: false, errors: [`${DISTRO_MANIFEST_FILE} can't be parsed: expected a JSON object`] }

  const errors: string[] = []
  for (const field of Object.keys(raw)) {
    if (!MANIFEST_FIELDS.has(field)) errors.push(`unknown field '${field}'`)
  }
  const id = requiredString(raw, 'id', errors)
  if (id !== null && !isPluginId(id)) errors.push(`id '${id}' is not a valid plugin ID`)
  requiredString(raw, 'name', errors)
  requiredString(raw, 'version', errors)
  if (raw.description !== undefined && typeof raw.description !== 'string') errors.push("field 'description' must be a string")
  checkPlugins(raw, errors)
  checkDisable(raw, errors)
  checkSettings(raw, errors)
  checkTheme(raw, errors)
  checkKeybindings(raw, errors)
  if (errors.length > 0) return { ok: false, errors }

  const manifest = { ...raw } as DistroManifest
  if (isRecord(raw.keybindings)) {
    manifest.keybindings = Object.fromEntries(
      Object.entries(raw.keybindings as Record<string, string>).map(([written, command]) => [
        (parseChord(written) as { ok: true; chord: string }).chord,
        command
      ])
    )
  }
  return { ok: true, manifest }
}
