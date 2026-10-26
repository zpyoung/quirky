import type { QuirkyEvent } from './rpc'

/** The contribution kinds the UI plugin API adds. */
export const UI_KINDS = ['sidebar-section', 'panel', 'view', 'command', 'keybinding', 'setting', 'theme'] as const

/** UI kinds whose implementation is code a plugin's UI module provides. */
export const CODE_BACKED_KINDS = ['view', 'panel', 'sidebar-section', 'command'] as const

/** The color slots a theme fills; window tokens map to CSS custom properties `--<token>`. */
export const THEME_TOKENS = [
  'bg',
  'bg-raised',
  'bg-hover',
  'bg-active',
  'border',
  'text',
  'muted',
  'accent',
  'amber',
  'green',
  'grey',
  'dim',
  'danger',
  'terminal-background',
  'terminal-foreground',
  'terminal-cursor'
] as const

export type ThemeToken = (typeof THEME_TOKENS)[number]

/** A theme color: a 3, 6 or 8 digit hex color. */
export const THEME_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/

export type ThemeInfo = {
  id: string
  /** The declaring plugin; null for the built-in default. */
  plugin: string | null
  title: string
  appearance: 'dark' | 'light'
  colors: Record<ThemeToken, string>
}

/** The theme in effect when none is chosen, and the fallback when a chosen one is gone. */
export const DEFAULT_THEME: ThemeInfo = {
  id: 'default',
  plugin: null,
  title: 'Quirky Dark',
  appearance: 'dark',
  colors: {
    bg: '#16181d',
    'bg-raised': '#1d2027',
    'bg-hover': '#262a33',
    'bg-active': '#2d3240',
    border: '#2b2f3a',
    text: '#d7dae0',
    muted: '#8a909e',
    accent: '#4f8ff7',
    amber: '#f0b429',
    green: '#3fb950',
    grey: '#8b949e',
    dim: '#4a505c',
    danger: '#e5534b',
    'terminal-background': '#16181d',
    'terminal-foreground': '#d7dae0',
    'terminal-cursor': '#d7dae0'
  }
}

export type ThemeList = { chosen: string; active: string; themes: ThemeInfo[] }

/** A sidebar section, panel or view in the UI model. */
export type UiSlotEntry = {
  id: string
  kind: 'sidebar-section' | 'panel' | 'view'
  /** The plugin whose declaration is in effect. */
  plugin: string
  title: string
  order: number
  /** URL of the owning plugin's UI module; null when it has none. */
  module: string | null
}

export type UiCommandEntry = {
  id: string
  plugin: string
  title: string
  description?: string
  module: string | null
}

export type UiKeybinding = {
  id: string
  plugin: string
  /** The canonical chord. */
  key: string
  /** A full command ID. */
  command: string
  status: 'active' | 'shadowed' | 'unbound'
  /** The winning keybinding ID, or `kernel` for a reserved chord. */
  shadowedBy?: string
}

/** What a plugin declares for a `setting` contribution. */
export type SettingDeclaration = {
  type: 'boolean' | 'number' | 'string' | 'enum'
  title: string
  description?: string
  default: boolean | number | string
  minimum?: number
  maximum?: number
  values?: string[]
}

export type UiSettingEntry = { id: string; plugin: string } & SettingDeclaration

/** A setting with its current value; `stored` is absent when nothing is stored. */
export type SettingInfo = UiSettingEntry & {
  value: boolean | number | string
  /** `valid` is false when the stored value fails the current declaration. */
  stored?: { value: unknown; valid: boolean }
}

/** Everything the window needs to render plugin UI, as returned by `ui.contributions`. */
export type UiModel = {
  /** Order ascending, then ID. */
  sidebarSections: UiSlotEntry[]
  /** Order ascending, then ID. */
  panels: UiSlotEntry[]
  /** ID ascending. */
  views: UiSlotEntry[]
  /** Title ascending, then ID. */
  commands: UiCommandEntry[]
  /** ID ascending. */
  keybindings: UiKeybinding[]
  /** ID ascending. */
  settings: UiSettingEntry[]
  /** The default theme first, then by title. */
  themes: ThemeInfo[]
  /** `chosen` and `active` are `default` or a theme ID. */
  theme: { chosen: string; active: string }
  /** Per plugin with a `ui` field and code-backed contributions in effect; `provides` lists the IDs its module may provide. */
  modules: Record<string, { url: string; provides: string[] }>
}

/** Which view and panel are open, whether the sidebar shows, and where focus is; owned by the daemon. */
export type UiLayout = {
  view: { id: string; input?: unknown } | null
  panel: string | null
  sidebar: boolean
  focus: 'sidebar' | 'view' | 'panel' | null
}

/** A connected window (a client with role `ui`). */
export type UiWindowInfo = { connId: number; name?: string; focused: boolean }

/** One slot in the UI model, with the latest report from its mounted window. */
export type UiSlotState = {
  id: string
  kind: 'sidebar-section' | 'panel' | 'view'
  plugin: string
  title: string
  shown: boolean
  report?: unknown
}

/** What `ui.state` returns. */
export type UiState = { windows: UiWindowInfo[]; layout: UiLayout; slots: UiSlotState[] }

/** Renders a slot into `element`; the returned function cleans up. `report` sends a JSON summary of what the slot shows. */
export type MountFunction = (
  element: HTMLElement,
  props: { input?: unknown; report?(state: unknown): void }
) => (() => void) | void

/** Runs a command, with the arguments it was invoked with. */
export type CommandHandler = (args?: unknown) => unknown

/** What a plugin's `activate` receives in the window. */
export type UiPluginContext = {
  readonly pluginId: string
  /** Writes to the window log, prefixed with the plugin ID. */
  log(message: string): void
  /** Registers the implementation of a code-backed contribution this plugin declares; throws for any other ID. */
  provide(contributionId: string, implementation: unknown): void
  /** Invokes a daemon or plugin method. */
  call(method: string, params?: Record<string, unknown>): Promise<unknown>
  /** Listens to every daemon event; the returned function unsubscribes. */
  subscribe(listener: (event: QuirkyEvent) => void | Promise<void>): () => void
  /** Reads a setting by short name in the plugin's own namespace, or by full setting ID. */
  getSetting(name: string): unknown
  executeCommand(id: string, args?: unknown): Promise<void>
  openView(id: string, input?: unknown): void
  closeView(): void
  togglePanel(id: string, open?: boolean): void
  getLayout(): UiLayout
  /** Listens to layout changes; the returned function unsubscribes. */
  onLayout(listener: (layout: UiLayout) => void): () => void
  /** Listens to binary stream frames tagged `streamId`; the returned function unsubscribes. */
  onStream(streamId: number, listener: (bytes: Uint8Array) => void): () => void
  /** Listens to connection status changes; the returned function unsubscribes. */
  onConnection(listener: (status: 'connected' | 'reconnecting') => void): () => void
  /** Shows a confirm dialog; resolves true when the person confirms. */
  confirm(options: { title: string; body?: string; confirmLabel?: string }): Promise<boolean>
  toast(title: string, body: string): void
  /** Shows a count on the panel's toggle; null clears it. */
  setPanelBadge(panelId: string, count: number | null): void
}

/** The shape a plugin's UI module must export. */
export type UiPluginModule = {
  activate(context: UiPluginContext): void | Promise<void>
  deactivate?(): void | Promise<void>
}

/** Platform whose chord conventions apply: on `darwin`, `cmd` means `mod` and `metaKey` is `mod`. */
export const CHORD_PLATFORM: string = 'darwin'

/** Chords the window keeps for itself: new tab, close tab, tabs 1 to 9 and the command palette. */
export const RESERVED_CHORDS: readonly string[] = [
  'mod+t',
  'mod+w',
  'mod+1',
  'mod+2',
  'mod+3',
  'mod+4',
  'mod+5',
  'mod+6',
  'mod+7',
  'mod+8',
  'mod+9',
  'mod+shift+p'
]

const MODIFIER_ORDER = ['mod', 'ctrl', 'alt', 'shift'] as const
type Modifier = (typeof MODIFIER_ORDER)[number]

const NAMED_KEYS = new Set([
  'enter',
  'escape',
  'tab',
  'space',
  'backspace',
  'delete',
  'up',
  'down',
  'left',
  'right',
  'home',
  'end',
  'pageup',
  'pagedown'
])
const PUNCTUATION_KEYS = new Set([',', '.', '/', ';', "'", '[', ']', '\\', '-', '=', '`'])
const FUNCTION_KEY_RE = /^f(?:[1-9]|1[0-2])$/
const LETTER_OR_DIGIT_RE = /^[a-z0-9]$/

function isKeyName(token: string): boolean {
  return (
    LETTER_OR_DIGIT_RE.test(token) ||
    FUNCTION_KEY_RE.test(token) ||
    NAMED_KEYS.has(token) ||
    PUNCTUATION_KEYS.has(token)
  )
}

function modifierOf(token: string): Modifier | null {
  if (token === 'cmd') return CHORD_PLATFORM === 'darwin' ? 'mod' : null
  return (MODIFIER_ORDER as readonly string[]).includes(token) ? (token as Modifier) : null
}

/**
 * Parses a keybinding's `key` text to its canonical chord: modifiers in the order mod, ctrl, alt,
 * shift, then the lowercase key. On failure `error` is the text SC-5 prints after the
 * `keybinding <name>: ` label.
 */
export function parseChord(text: string): { ok: true; chord: string } | { ok: false; error: string } {
  const tokens = text.split('+').map((token) => token.trim().toLowerCase())
  const key = tokens[tokens.length - 1]
  const seen = new Set<Modifier>()
  for (const token of tokens.slice(0, -1)) {
    const modifier = modifierOf(token)
    if (modifier === null) {
      if (isKeyName(token)) return { ok: false, error: 'key must end in one key' }
      return { ok: false, error: `unknown modifier \`${token}\`` }
    }
    if (seen.has(modifier)) return { ok: false, error: `duplicate modifier \`${token}\`` }
    seen.add(modifier)
  }
  if (key === '' || modifierOf(key) !== null) return { ok: false, error: 'key must end in one key' }
  if (!isKeyName(key)) return { ok: false, error: `unknown key \`${key}\`` }
  if (!FUNCTION_KEY_RE.test(key) && !seen.has('mod') && !seen.has('ctrl') && !seen.has('alt')) {
    return { ok: false, error: 'key needs a modifier or a function key' }
  }
  return { ok: true, chord: [...MODIFIER_ORDER.filter((m) => seen.has(m)), key].join('+') }
}

const CODE_PUNCTUATION: Record<string, string> = {
  Comma: ',',
  Period: '.',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Minus: '-',
  Equal: '=',
  Backquote: '`'
}

const EVENT_KEY_NAMES: Record<string, string> = {
  Enter: 'enter',
  Escape: 'escape',
  Tab: 'tab',
  ' ': 'space',
  Backspace: 'backspace',
  Delete: 'delete',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Home: 'home',
  End: 'end',
  PageUp: 'pageup',
  PageDown: 'pagedown'
}

function keyFromEvent(event: { key: string; code: string }): string | null {
  const letter = /^Key([A-Z])$/.exec(event.code)
  if (letter) return letter[1].toLowerCase()
  const digit = /^Digit([0-9])$/.exec(event.code)
  if (digit) return digit[1]
  const punctuation = CODE_PUNCTUATION[event.code]
  if (punctuation) return punctuation
  const functionKey = event.key.toLowerCase()
  if (FUNCTION_KEY_RE.test(functionKey)) return functionKey
  return EVENT_KEY_NAMES[event.key] ?? null
}

/**
 * The canonical chord for a key press, or null when it is a bare modifier or outside the chord
 * grammar. Letters, digits and punctuation come from `code`, so Shift and Alt don't change them.
 */
export function chordFromKeyEvent(event: {
  key: string
  code: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}): string | null {
  const key = keyFromEvent(event)
  if (key === null) return null
  const mac = CHORD_PLATFORM === 'darwin'
  const held: Record<Modifier, boolean> = {
    mod: mac && event.metaKey,
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey
  }
  return [...MODIFIER_ORDER.filter((m) => held[m]), key].join('+')
}

/**
 * Null when `value` fits `declaration`, else the message to report for setting `id`. The type is
 * checked first, then the range or enum membership; numbers must be finite.
 */
export function checkSettingValue(id: string, declaration: SettingDeclaration, value: unknown): string | null {
  switch (declaration.type) {
    case 'boolean':
      return typeof value === 'boolean' ? null : `${id} must be a boolean`
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return `${id} must be a number`
      if (declaration.minimum !== undefined && value < declaration.minimum) {
        return `${id} must be at least ${declaration.minimum}`
      }
      if (declaration.maximum !== undefined && value > declaration.maximum) {
        return `${id} must be at most ${declaration.maximum}`
      }
      return null
    case 'string':
      return typeof value === 'string' ? null : `${id} must be a string`
    case 'enum': {
      if (typeof value !== 'string') return `${id} must be a string`
      const values = declaration.values ?? []
      return values.includes(value) ? null : `${id} must be one of ${values.join(', ')}`
    }
  }
}
