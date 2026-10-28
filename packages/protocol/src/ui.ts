import type { NativeBrowserCapability } from './native-browser'
import type { QuirkyEvent } from './rpc'
import type { UiToolEntry, UiToolLayout, UiToolSlot } from './tool-slots'

/** The contribution kinds the UI plugin API adds. */
export const UI_KINDS = ['status-bar', 'sidebar-section', 'activity-item', 'panel', 'view', 'overlay', 'command', 'keybinding', 'setting', 'settings-section', 'theme', 'menu-item'] as const

/** UI kinds whose implementation is code a plugin's UI module provides. */
export const CODE_BACKED_KINDS = ['status-bar', 'view', 'panel', 'sidebar-section', 'activity-item', 'settings-section', 'overlay', 'command'] as const

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

/** The logical system-following choice; a window resolves its local appearance. */
export const DEFAULT_THEME: ThemeInfo = {
  id: 'default',
  plugin: null,
  title: 'Follow system',
  appearance: 'dark',
  colors: {
    bg: '#101114',
    'bg-raised': '#16171b',
    'bg-hover': '#22242b',
    'bg-active': '#22242b',
    border: '#24262c',
    text: '#eceef2',
    muted: '#7c828d',
    accent: '#7c8cff',
    amber: '#e5b454',
    green: '#4cc38a',
    grey: '#7c828d',
    dim: '#4a505c',
    danger: '#ef6b73',
    'terminal-background': '#16171b',
    'terminal-foreground': '#eceef2',
    'terminal-cursor': '#eceef2'
  }
}

/** Explicit appearance pins, selected through the existing theme.set API. */
export const DARK_THEME: ThemeInfo = { ...DEFAULT_THEME, id: 'dark', title: 'Dark' }
export const LIGHT_THEME: ThemeInfo = {
  id: 'light',
  plugin: null,
  title: 'Light',
  appearance: 'light',
  colors: {
    bg: '#f4f5f7', 'bg-raised': '#ffffff', 'bg-hover': '#e7e9ef', 'bg-active': '#e7e9ef',
    border: '#e3e5ea', text: '#1b1d22', muted: '#80868f', accent: '#5b6cff',
    amber: '#c98a0b', green: '#1f9d63', grey: '#80868f', dim: '#a4a9b2', danger: '#d6455d',
    'terminal-background': '#ffffff', 'terminal-foreground': '#1b1d22', 'terminal-cursor': '#1b1d22'
  }
}

export type ThemeList = { chosen: string; active: string; themes: ThemeInfo[] }

/** A code-backed status bar, sidebar section, activity item, panel, view, overlay, or generic settings section in the UI model. */
export type UiSlotEntry = {
  id: string
  kind: 'status-bar' | 'sidebar-section' | 'activity-item' | 'panel' | 'view' | 'overlay' | 'settings-section'
  /** The plugin whose declaration is in effect. */
  plugin: string
  title: string
  /** Optional descriptive copy for generic settings sections. */
  description?: string
  order: number
  /** URL of the owning plugin's UI module; null when it has none. */
  module: string | null
  /** Views opting into Settings navigation; ignored for every other slot kind. */
  settings?: boolean
  /** Host-owned tool placement metadata for panel/sidebar/activity contributions. */
  defaultSlot?: UiToolSlot
  icon?: string
}

export type UiCommandEntry = {
  id: string
  plugin: string
  title: string
  description?: string
  module: string | null
}

/** The window menus a `menu-item` contribution may target. */
export const TERMINAL_PANE_MENU = 'quirky.terminal/pane'
/** The tab-strip menu; commands receive `{ worktree, workspace, group }`. */
export const TERMINAL_TAB_MENU = 'quirky.terminal/tab'

/** A public menu row; pane commands receive `{ session }`, tab commands `{ worktree, workspace, group }`. */
export type UiMenuItemEntry = {
  id: string
  plugin: string
  menu: typeof TERMINAL_PANE_MENU | typeof TERMINAL_TAB_MENU
  title: string
  command: string
  /** `agent: 'any'` shows the row only on a pane whose session runs an agent other than the shell. */
  when?: { agent?: 'any' }
  after?: 'quick-commands'
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
  /** The canonical `when` condition; absent when the binding is unconditional. */
  when?: string
}

/** What a plugin declares for a `setting` contribution. */
export type SettingDeclaration = {
  type: 'boolean' | 'number' | 'string' | 'enum'
  title: string
  description?: string
  /** Optional generic settings navigation metadata. */
  category?: string
  section?: string
  default: boolean | number | string
  minimum?: number
  maximum?: number
  values?: string[]
  /** Exposes a boolean setting as a checked item in the native View menu. */
  menu?: 'view'
}

export type UiSettingEntry = { id: string; plugin: string } & SettingDeclaration

/** A setting with its current value; `stored` is absent when nothing is stored. */
export type SettingInfo = UiSettingEntry & {
  value: boolean | number | string
  /** Which layer `value` comes from: the user's stored value, the installed distro's, or the declared default; the daemon always sets it. */
  source?: 'user' | 'distro' | 'default'
  /** `valid` is false when the stored value fails the current declaration. */
  stored?: { value: unknown; valid: boolean }
}

/** Everything the window needs to render plugin UI, as returned by `ui.contributions`. */
export type UiModel = {
  /** Order ascending, then ID. */
  sidebarSections: UiSlotEntry[]
  /** Order ascending, then ID. */
  statusBars: UiSlotEntry[]
  /** Order ascending, then ID. */
  activityItems: UiSlotEntry[]
  /** Order ascending, then ID. */
  panels: UiSlotEntry[]
  /** ID ascending. */
  views: UiSlotEntry[]
  /** Order ascending, then ID. */
  overlays: UiSlotEntry[]
  commands: UiCommandEntry[]
  /**
   * Registry precedence, highest first: the distro's bindings in manifest order, then plugin
   * bindings in the order `resolveKeybindings` ranks them (a plugin that beats another comes
   * first, ties by plugin ID), each plugin's by ID. A window takes the first matching `active`
   * binding, so this order is part of the contract.
   */
  keybindings: UiKeybinding[]
  /** ID ascending. */
  settings: UiSettingEntry[]
  /** Rich, code-backed content inside the generic Settings dialog, ordered by contribution order then ID. */
  settingsSections: UiSlotEntry[]
  /** ID ascending. */
  menuItems: UiMenuItemEntry[]
  /** The default theme first, then by title. */
  themes: ThemeInfo[]
  /** `chosen` and `active` are `default` or a theme ID. */
  theme: { chosen: string; active: string }
  /** Per plugin with a `ui` field and code-backed contributions in effect; `provides` lists the IDs its module may provide. */
  modules: Record<string, { url: string; provides: string[] }>
  /** Resolved tool projection; omitted by older contribution producers. */
  tools?: UiToolEntry[]
}

/** The daemon-owned layout: open view/panel, sidebar visibility and desired panel geometry; `palette` is absent when the command palette is closed. */
export type UiLayout = {
  view: { id: string; input?: unknown } | null
  panel: string | null
  sidebar: boolean
  focus: 'sidebar' | 'view' | 'panel' | null
  /** Desired width by effective panel ID; absent entries retain the shell's default width. */
  panelWidths?: Record<string, number>
  /** Whether the command palette is open; absent means closed. */
  palette?: boolean
  /** Host-owned six-slot placement, visibility and geometry, shared across projects. */
  tools?: UiToolLayout
  /** Open center view contributions, retaining each view's last input in this window. */
  viewTabs?: { id: string; input?: unknown }[]
}

/** A connected window (a client with role `ui`). */
export type UiWindowInfo = {
  connId: number
  name?: string
  focused: boolean
  /** Epoch milliseconds of the window's last reported input; null before any. */
  inputAt: number | null
  /** Whether that input is within the away threshold. */
  present: boolean
}

/** How long without input before a window stops counting as present; milliseconds. */
export const DESKTOP_AWAY_MS = 180_000

/** One slot in the UI model, with the latest report from its mounted window. */
export type UiSlotState = {
  id: string
  kind: 'status-bar' | 'sidebar-section' | 'activity-item' | 'panel' | 'view' | 'overlay' | 'settings-section'
  plugin: string
  title: string
  shown: boolean
  report?: unknown
}

/** How a toast looks and what the person is told about it. */
export type ToastKind = 'info' | 'success' | 'warning' | 'error'

/** A button on a toast; it runs window command `command` with `args` and dismisses the toast unless `keepOpen`. */
export type ToastAction = { label: string; command: string; args?: unknown; keepOpen?: boolean }

/**
 * What a plugin can ask of a toast. A toast with a `key` replaces the one already showing under
 * that key without running its `onDismiss`; `persistent` skips the auto-dismiss timer; `onDismiss`
 * runs once when the toast is dismissed by its close button, its timer or `ui.toast.dismiss`.
 */
export type ToastOptions = {
  kind?: ToastKind
  key?: string
  persistent?: boolean
  detail?: string
  actions?: ToastAction[]
  onDismiss?: { command: string; args?: unknown }
}

/** A toast the window shows, as `ui.state` lists it. */
export type UiToastState = {
  key: string | null
  kind: ToastKind
  title: string
  body: string
  detail: string | null
  persistent: boolean
  actions: { label: string; command: string; args?: unknown }[]
}

/** What `ui.state` returns; `toasts` is the focused window's list, else the latest window's. */
export type UiState = { windows: UiWindowInfo[]; layout: UiLayout; slots: UiSlotState[]; toasts: UiToastState[] }

/**
 * Renders a slot into `element`; the returned function cleans up. `report` sends a JSON summary
 * of what the slot shows. A view embedded with `mountView` gets `input` and no `report`.
 */
export type MountFunction = (
  element: HTMLElement,
  props: { input?: unknown; report?(state: unknown): void }
) => (() => void) | void

/** Runs a command, with the arguments it was invoked with. */
export type CommandHandler = (args?: unknown) => unknown

/** What a plugin's `activate` receives in the window. */
export type UiPluginContext = {
  readonly nativeBrowser: NativeBrowserCapability
  readonly pluginId: string
  /** Writes to the window log, prefixed with the plugin ID. */
  log(message: string): void
  /** Reads plain text from this window's clipboard: native desktop pasteboard, Web Clipboard API otherwise. */
  readClipboardText(): Promise<string>
  /** Registers the implementation of a code-backed contribution this plugin declares; throws for any other ID. */
  provide(contributionId: string, implementation: unknown): void
  /** Invokes a daemon or plugin method. */
  call(method: string, params?: Record<string, unknown>): Promise<unknown>
  /** Listens to every daemon event; the returned function unsubscribes. */
  subscribe(listener: (event: QuirkyEvent) => void | Promise<void>): () => void
  /** Reads a setting by short name in the plugin's own namespace, or by full setting ID. */
  getSetting(name: string): unknown
  executeCommand(id: string, args?: unknown): Promise<void>
  /**
   * Mints a one-use, same-window drag capability. Put only its opaque token in DataTransfer;
   * external bytes cannot create a capability.
   */
  createCommandDrag(commandId: string, args?: Record<string, unknown>): string
  /** Consumes a capability once, returning the trusted command and its snapshotted arguments. */
  consumeCommandDrag(token: string): { command: string; args: Record<string, unknown> } | null
  /** Cancels a capability minted by this context. */
  cancelCommandDrag(token: string): void
  openView(id: string, input?: unknown): void
  closeView(): void
  togglePanel(id: string, open?: boolean): void
  /** Opens or closes the command palette; omitting `open` toggles the daemon-owned state. */
  setPalette(open?: boolean): void
  getLayout(): UiLayout
  /** Listens to layout changes; the returned function unsubscribes. */
  onLayout(listener: (layout: UiLayout) => void): () => void
  /** Listens to binary stream frames tagged `streamId`; the returned function unsubscribes. */
  onStream(streamId: number, listener: (bytes: Uint8Array) => void): () => void
  /** Listens to connection status changes; the returned function unsubscribes. */
  onConnection(listener: (status: 'connected' | 'reconnecting') => void): () => void
  /** Shows a confirm dialog; resolves true when the person confirms. */
  confirm(options: { title: string; body?: string; confirmLabel?: string }): Promise<boolean>
  /** Shows a toast; `options` can make it a success or warning, keyed, persistent or actionable. */
  toast(title: string, body: string, options?: ToastOptions): void
  /** Shows a count on the panel's toggle, with `title` as its tooltip (default "<count> waiting"); null clears it. */
  setPanelBadge(panelId: string, count: number | null, title?: string): void
  /**
   * Sets a window-global context key that keybinding `when` conditions read; `undefined` clears
   * it. The window clears every key this plugin set when the plugin is deactivated.
   */
  setContext(key: string, value: boolean | undefined): void
  /**
   * Mounts the effective view `viewId` (any plugin's) into `element` with `{input}` and no
   * `report`, and returns a function that unmounts it; deactivating this plugin unmounts it too.
   * Throws `no contribution <id>` for a view the model does not have.
   */
  mountView(viewId: string, element: HTMLElement, input?: unknown): () => void
}

/** The shape a plugin's UI module must export. */
export type UiPluginModule = {
  activate(context: UiPluginContext): void | Promise<void>
  deactivate?(): void | Promise<void>
}

/** Platform whose chord conventions apply: on `darwin`, `cmd` means `mod` and `metaKey` is `mod`. */
export const CHORD_PLATFORM: string = 'darwin'


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

const WHEN_MAX_DEPTH = 32
const WHEN_KEY_START_RE = /[A-Za-z]/
const WHEN_KEY_RE = /[A-Za-z][A-Za-z0-9.]*/y

type WhenNode =
  | { t: 'key'; name: string }
  | { t: 'not'; x: WhenNode }
  | { t: 'and' | 'or'; xs: WhenNode[] }

type WhenToken = { text: string; pos: number }

class WhenError extends Error {}

function tokenizeWhen(text: string): WhenToken[] {
  const tokens: WhenToken[] = []
  let at = 0
  while (at < text.length) {
    const char = text[at]
    if (/\s/.test(char)) {
      at++
    } else if (text.startsWith('&&', at) || text.startsWith('||', at)) {
      tokens.push({ text: text.slice(at, at + 2), pos: at + 1 })
      at += 2
    } else if (char === '!' || char === '(' || char === ')') {
      tokens.push({ text: char, pos: at + 1 })
      at++
    } else if (WHEN_KEY_START_RE.test(char)) {
      WHEN_KEY_RE.lastIndex = at
      const key = WHEN_KEY_RE.exec(text)![0]
      tokens.push({ text: key, pos: at + 1 })
      at += key.length
    } else {
      throw new WhenError(`unexpected \`${char}\` at position ${at + 1}`)
    }
  }
  return tokens
}

function parseWhenTokens(tokens: WhenToken[]): WhenNode {
  let at = 0
  const peek = (): string | undefined => tokens[at]?.text
  const unexpected = (): never => {
    const token = tokens[at]
    throw new WhenError(token ? `unexpected \`${token.text}\` at position ${token.pos}` : 'expected a key at the end')
  }
  const join = (t: 'and' | 'or', xs: WhenNode[]): WhenNode => {
    const flat = xs.flatMap((x) => (x.t === t ? x.xs : [x]))
    return flat.length === 1 ? flat[0] : { t, xs: flat }
  }
  const unary = (depth: number): WhenNode => {
    if (depth > WHEN_MAX_DEPTH) throw new WhenError('nested too deeply')
    const token = peek()
    if (token === '!') {
      at++
      return { t: 'not', x: unary(depth + 1) }
    }
    if (token === '(') {
      at++
      const inner = or(depth + 1)
      if (peek() !== ')') {
        if (at >= tokens.length) throw new WhenError('missing `)` at the end')
        unexpected()
      }
      at++
      return inner
    }
    if (token !== undefined && WHEN_KEY_START_RE.test(token[0])) {
      at++
      return { t: 'key', name: token }
    }
    return unexpected()
  }
  const and = (depth: number): WhenNode => {
    const xs = [unary(depth)]
    while (peek() === '&&') {
      at++
      xs.push(unary(depth))
    }
    return join('and', xs)
  }
  const or = (depth: number): WhenNode => {
    const xs = [and(depth)]
    while (peek() === '||') {
      at++
      xs.push(and(depth))
    }
    return join('or', xs)
  }
  const root = or(0)
  if (at < tokens.length) unexpected()
  return root
}

function printWhen(node: WhenNode): string {
  switch (node.t) {
    case 'key':
      return node.name
    case 'not':
      return `!${node.x.t === 'and' || node.x.t === 'or' ? `(${printWhen(node.x)})` : printWhen(node.x)}`
    case 'and':
      return node.xs.map((x) => (x.t === 'or' ? `(${printWhen(x)})` : printWhen(x))).join(' && ')
    case 'or':
      return node.xs.map(printWhen).join(' || ')
  }
}

function parseWhenNode(text: string): WhenNode {
  return parseWhenTokens(tokenizeWhen(text))
}

/**
 * Parses a keybinding's `when` condition (`!`, `&&`, `||` and parentheses over context keys,
 * `&&` binding tighter than `||`) to its canonical text: single spaces around binary operators,
 * no redundant parentheses. Two conditions that differ only in spacing or redundant parentheses
 * have the same canonical text. On failure `error` names the first problem found.
 */
export function parseWhen(text: string): { ok: true; canonical: string } | { ok: false; error: string } {
  try {
    return { ok: true, canonical: printWhen(parseWhenNode(text)) }
  } catch (error) {
    if (error instanceof WhenError) return { ok: false, error: error.message }
    throw error
  }
}

const parsedWhen = new Map<string, WhenNode | null>()

function whenNodeOf(canonical: string): WhenNode | null {
  const known = parsedWhen.get(canonical)
  if (known !== undefined) return known
  let node: WhenNode | null
  try {
    node = parseWhenNode(canonical)
  } catch {
    node = null
  }
  if (parsedWhen.size >= 512) parsedWhen.clear()
  parsedWhen.set(canonical, node)
  return node
}

/** Whether a canonical `when` holds for the context keys; a key missing from `keys` is false, and so is text that does not parse. */
export function evaluateWhen(canonical: string, keys: ReadonlyMap<string, boolean>): boolean {
  const run = (node: WhenNode): boolean => {
    switch (node.t) {
      case 'key':
        return keys.get(node.name) === true
      case 'not':
        return !run(node.x)
      case 'and':
        return node.xs.every(run)
      case 'or':
        return node.xs.some(run)
    }
  }
  const node = whenNodeOf(canonical)
  return node !== null && run(node)
}

/** Whether a canonical `when` names `key` somewhere outside every `!`. */
export function whenMentions(canonical: string, key: string): boolean {
  const mentions = (node: WhenNode): boolean => {
    switch (node.t) {
      case 'key':
        return node.name === key
      case 'not':
        return false
      case 'and':
      case 'or':
        return node.xs.some(mentions)
    }
  }
  const node = whenNodeOf(canonical)
  return node !== null && mentions(node)
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
