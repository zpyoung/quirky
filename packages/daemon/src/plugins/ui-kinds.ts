import {
  checkSchemaDeclaration,
  checkSettingValue,
  isContributionName,
  parseChord,
  parseContributionId,
  parseWhen,
  THEME_COLOR_RE,
  THEME_TOKENS,
  UI_KINDS,
  type SettingDeclaration,
} from '@quirky/protocol'

type Entry = Record<string, unknown>

const ALLOWED_FIELDS: Record<string, readonly string[]> = {
  'status-bar': ['title', 'description', 'order'],
  'sidebar-section': ['title', 'description', 'order'],
  panel: ['title', 'description', 'order'],
  view: ['title', 'description', 'settings'],
  overlay: ['title', 'description', 'order'],
  command: ['title', 'description', 'args'],
  keybinding: ['key', 'command', 'description', 'when'],
  setting: ['type', 'default', 'title', 'description', 'minimum', 'maximum', 'values'],
  theme: ['title', 'appearance', 'colors', 'description'],
}

const SETTING_TYPES = ['boolean', 'number', 'string', 'enum'] as const
const TITLE_REQUIRED = new Set(['status-bar', 'sidebar-section', 'panel', 'overlay', 'setting', 'theme'])

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function checkTitle(kind: string, label: string, entry: Entry, errors: string[]): void {
  if (entry.title === undefined) {
    if (TITLE_REQUIRED.has(kind)) errors.push(`${label}: title is required`)
  } else if (!isNonEmptyString(entry.title)) {
    errors.push(`${label}: title must be a non-empty string`)
  }
}

function checkKeybinding(label: string, entry: Entry, errors: string[]): void {
  if (entry.key === undefined) errors.push(`${label}: key is required`)
  else if (typeof entry.key !== 'string') errors.push(`${label}: key must be a string`)
  else {
    const chord = parseChord(entry.key)
    if (!chord.ok) errors.push(`${label}: ${chord.error}`)
  }

  const command = entry.command
  if (command === undefined) errors.push(`${label}: command is required`)
  else if (typeof command !== 'string') errors.push(`${label}: command must be a string`)
  else if (!isContributionName(command) && parseContributionId(command)?.kind !== 'command') {
    errors.push(`${label}: command must be a command name or a full command ID`)
  }

  if (entry.when !== undefined) {
    if (typeof entry.when !== 'string') errors.push(`${label}: when must be a string`)
    else {
      const when = parseWhen(entry.when)
      if (!when.ok) errors.push(`${label}: when is invalid: ${when.error}`)
    }
  }
}

function checkValues(label: string, values: unknown, errors: string[]): string[] | null {
  const valid =
    Array.isArray(values) &&
    values.length > 0 &&
    values.every(isNonEmptyString) &&
    new Set(values).size === values.length
  if (valid) return values as string[]
  errors.push(`${label}: values must be a non-empty list of distinct non-empty strings`)
  return null
}

function checkBound(label: string, entry: Entry, field: 'minimum' | 'maximum', type: unknown, errors: string[]): number | undefined {
  const value = entry[field]
  if (value === undefined) return undefined
  if (type !== 'number') errors.push(`${label}: ${field} is only allowed for a number`)
  else if (!isFiniteNumber(value)) errors.push(`${label}: ${field} must be a number`)
  else return value
  return undefined
}

function checkSetting(label: string, entry: Entry, errors: string[]): void {
  const type = entry.type
  const typeValid = (SETTING_TYPES as readonly unknown[]).includes(type)
  if (!typeValid) errors.push(`${label}: type must be boolean, number, string or enum`)

  let minimum = checkBound(label, entry, 'minimum', type, errors)
  let maximum = checkBound(label, entry, 'maximum', type, errors)
  if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
    errors.push(`${label}: minimum must not be greater than maximum`)
    minimum = undefined
    maximum = undefined
  }

  let values: string[] | null = null
  if (entry.values !== undefined) {
    if (type === 'enum' || !typeValid) values = checkValues(label, entry.values, errors)
    else errors.push(`${label}: values is only allowed for an enum`)
  } else if (type === 'enum') {
    errors.push(`${label}: values is required for an enum`)
  }

  if (entry.default === undefined) {
    errors.push(`${label}: default is required`)
    return
  }
  if (!typeValid || (type === 'enum' && values === null)) return
  const declaration: SettingDeclaration = {
    type: type as SettingDeclaration['type'],
    title: '',
    default: entry.default as SettingDeclaration['default'],
    minimum,
    maximum,
    values: values ?? undefined,
  }
  const problem = checkSettingValue('default', declaration, entry.default)
  if (problem !== null) errors.push(`${label}: ${problem}`)
}

function checkTheme(label: string, entry: Entry, errors: string[]): void {
  if (entry.appearance !== 'dark' && entry.appearance !== 'light') {
    errors.push(`${label}: appearance must be dark or light`)
  }
  if (entry.colors === undefined) return
  if (!isRecord(entry.colors)) {
    errors.push(`${label}: colors must be an object`)
    return
  }
  for (const [token, value] of Object.entries(entry.colors)) {
    if (!(THEME_TOKENS as readonly string[]).includes(token)) errors.push(`${label}: unknown color \`${token}\``)
    else if (typeof value !== 'string' || !THEME_COLOR_RE.test(value)) {
      errors.push(`${label}: color ${token} must be a hex color`)
    }
  }
}

/** True for the UI contribution kinds that `checkUiKindEntry` validates. */
export function isUiKind(kind: string): boolean {
  return (UI_KINDS as readonly string[]).includes(kind)
}

/**
 * Checks the fields of a contribution of one of the UI kinds and appends one message per problem
 * to `errors`. `label` prefixes every message, as for `checkKindEntry`.
 */
export function checkUiKindEntry(kind: string, label: string, entry: Entry, errors: string[]): void {
  const allowed = ALLOWED_FIELDS[kind]
  for (const field of Object.keys(entry)) {
    if (field !== 'id' && !allowed.includes(field)) errors.push(`${label}: unknown field \`${field}\``)
  }
  if (allowed.includes('title')) checkTitle(kind, label, entry, errors)
  if (entry.description !== undefined && typeof entry.description !== 'string') {
    errors.push(`${label}: description must be a string`)
  }
  if (allowed.includes('order') && entry.order !== undefined && !isFiniteNumber(entry.order)) {
    errors.push(`${label}: order must be a number`)
  }
  if (kind === 'view' && entry.settings !== undefined && typeof entry.settings !== 'boolean') {
    errors.push(`${label}: settings must be a boolean`)
  }
  if (kind === 'command' && entry.args !== undefined) {
    for (const problem of checkSchemaDeclaration(entry.args, 'args', { object: true })) errors.push(`${label}: ${problem}`)
  }
  if (kind === 'keybinding') checkKeybinding(label, entry, errors)
  if (kind === 'setting') checkSetting(label, entry, errors)
  if (kind === 'theme') checkTheme(label, entry, errors)
}
