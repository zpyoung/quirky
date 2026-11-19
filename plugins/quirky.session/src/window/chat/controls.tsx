import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { AgentCapabilities, Capability, Session, UiPluginContext, VisualLevel } from '@quirky/protocol'
import { AgentIcon, Badge, Button, ContextMenuList, ControlIcon, Popover, type ContextMenuItem } from '@quirky/ui'
import { clearVisualResolver, setVisualResolver, type VisualLabel, type VisualRef } from './editor/types'

export type Choice = { value: string; label: string }
type ModelOption = { id: string; label: string; type: 'select' | 'boolean'; choices: Choice[] | null; default?: string }
export type AgentModel = { id: string; label: string; options: ModelOption[] }

/** The part of `quirky.agents/options` the composer reads; a null `defaultModel` means the agent picks its own. */
export type AgentOptions = {
  supported: boolean
  models: AgentModel[]
  unlisted: 'accept' | 'refuse'
  unlistedOptions: ModelOption[]
  defaultModel: string | null
}

/** What the user has picked in the composer; null means the agent's own default. `visualLevel` is left out until the dial is used. */
export type Picks = { model: string | null; effort: string | null; mode: string | null; visualLevel?: VisualLevel }

export const NO_PICKS: Picks = { model: null, effort: null, mode: null }

const AUTO_UNAVAILABLE = "Auto mode isn't available for this model"

const LOADING = 'Loading capabilities'

/** The hover text for a control that `capability` turns off, or undefined when it is on. */
export function reasonOf(capability: Capability | AgentCapabilities['permissionModes'] | undefined): string | undefined {
  if (capability === undefined) return LOADING
  return capability.ok ? undefined : capability.reason
}

/** Reads a `quirky.agents/options` reply, tolerating fields an older agents plugin leaves out. */
export function agentOptionsOf(loaded: unknown): AgentOptions {
  const info = loaded as Partial<AgentOptions> | undefined
  return {
    supported: info?.supported !== false,
    models: info?.models ?? [],
    unlisted: info?.unlisted === 'refuse' ? 'refuse' : 'accept',
    unlistedOptions: info?.unlistedOptions ?? [],
    defaultModel: typeof info?.defaultModel === 'string' ? info.defaultModel : null
  }
}

/** Loads the model catalog for `agent`; null until it arrives and when the agents plugin is missing. */
export function useAgentOptions(context: UiPluginContext, agent: string): AgentOptions | null {
  const [options, setOptions] = useState<AgentOptions | null>(null)
  useEffect(() => {
    let cancelled = false
    setOptions(null)
    context
      .call('quirky.agents/options', { agent })
      .then((loaded) => {
        if (cancelled) return
        setOptions(agentOptionsOf(loaded))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [context, agent])
  return options
}

type LiveModels = { models: Choice[]; current: string | null } | 'failed' | null

/** Loads the running agent's own model list, only for an agent whose catalog lists none. */
function useLiveModels(context: UiPluginContext, session: Session, capabilities: AgentCapabilities | null, options: AgentOptions | null): LiveModels {
  const [live, setLive] = useState<LiveModels>(null)
  const wanted = options !== null && options.models.length === 0 && capabilities?.model.ok === true
  const started = session.status !== 'starting'
  useEffect(() => {
    setLive(null)
    // the runner answers "not running" until startup finishes, so wait and refetch when it does
    if (!wanted || !started) return
    let cancelled = false
    context
      .call('quirky.structured/models', { session: session.id })
      .then((loaded) => {
        if (cancelled) return
        const found = loaded as { models?: { id: string; label: string }[]; current?: string | null } | undefined
        setLive({ models: (found?.models ?? []).map((entry) => ({ value: entry.id, label: entry.label })), current: found?.current ?? null })
      })
      .catch(() => {
        if (!cancelled) setLive('failed')
      })
    return () => {
      cancelled = true
    }
  }, [context, session.id, wanted, started])
  return wanted ? live : null
}

export const effortOption = (options: AgentOptions, model: string | null): ModelOption | undefined => {
  const known = options.models.find((entry) => entry.id === model)
  return (known?.options ?? options.unlistedOptions).find((option) => option.id === 'effort')
}

export const effortChoices = (options: AgentOptions, model: string | null): Choice[] => {
  const effort = effortOption(options, model)
  return Array.isArray(effort?.choices) ? effort.choices : []
}

/** The model and effort the session was launched with, as the starting picks. */
export function launchPicks(session: Session): Pick<Picks, 'model' | 'effort'> {
  const launched = session.launchSettings?.options
  const model = launched?.model?.value
  const effort = launched?.effort?.value
  return { model: typeof model === 'string' ? model : null, effort: typeof effort === 'string' ? effort : null }
}

const chip = { display: 'inline-flex', alignItems: 'center', gap: 'var(--ui-space-4)' } satisfies CSSProperties

/** The agent a session runs; fixed because an agent cannot change once its session exists. */
export function AgentChip({ session }: { session: Session }) {
  return (
    <span style={chip} aria-label="Agent" title="The agent is fixed for this session">
      <Badge>
        <span style={chip}>
          <AgentIcon id={session.agent} />
          {session.agent}
        </span>
      </Badge>
    </span>
  )
}

/**
 * The absolute path of each of `files`, null where none is known. A file carries its own `path` in some
 * shells; otherwise the paths come from the window's native drop report, which matches only the whole
 * set of files from one drop, so every file of the drop must be passed together.
 */
export async function absolutePathsOf(context: UiPluginContext, files: File[]): Promise<(string | null)[]> {
  const direct = files.map((file) => {
    const path = (file as File & { path?: unknown }).path
    return typeof path === 'string' && path.startsWith('/') ? path : null
  })
  if (direct.every((path) => path !== null)) return direct
  const dropped = await context.nativeDropPaths(files).catch(() => null)
  return files.map((_, index) => direct[index] ?? dropped?.[index] ?? null)
}

/** What the settings chip shows and offers: the lists, the current values and why a control is off. */
export type TurnSettings = {
  modelList: Choice[]
  /** Null when the session launched without one, so the agent runs on its own default. */
  model: string | null
  /** True when the current model is not in the list, so it needs an entry of its own. */
  unlisted: boolean
  choices: Choice[]
  /** Empty when the session launched without one, so the agent runs on its own default. */
  effort: string
  /** The Mode list's rows, in the agent's order; `modeReasons` says why one cannot be picked. */
  modes: string[]
  mode: string
  defaultMode: string | null
  /** The display name of a permission mode id. */
  modeLabel: (mode: string) => string
  /** Whether a permission mode lets the agent act without asking. */
  isDangerous: (mode: string) => boolean
  /** One line on what a permission mode lets the agent do, or undefined when there is none to say. */
  modeDescription: (mode: string) => string | undefined
  modelReason: string | undefined
  effortReason: string | undefined
  /** Why the whole Permissions list is off, such as an agent with no permission modes. */
  modeReason: string | undefined
  /** Why a single mode row is off, by mode id. */
  modeReasons: Record<string, string | undefined>
  imagesReason: string | undefined
}

/** Why a Mode row is off: Auto when the model lacks it, Plan when the agent has none; a mode the agent offers has no reason. */
function modeReasonsOf(capabilities: AgentCapabilities | null, autoAvailable: boolean | undefined): TurnSettings['modeReasons'] {
  return {
    auto: autoAvailable === false ? AUTO_UNAVAILABLE : undefined,
    plan: reasonOf(capabilities?.planMode)
  }
}

/** Loads the permission mode a running session is in, which can differ from the agent's default when it opened in another. */
function useLiveMode(context: UiPluginContext, session: Session, capabilities: AgentCapabilities | null): string | null {
  const [mode, setMode] = useState<string | null>(null)
  const wanted = capabilities?.permissionModes.ok === true
  const started = session.status !== 'starting' && session.status !== 'exited'
  useEffect(() => {
    setMode(null)
    if (!wanted || !started) return
    let cancelled = false
    context
      .call('quirky.structured/settings', { session: session.id })
      .then((loaded) => {
        const found = (loaded as { settings?: { permissionMode?: unknown } } | undefined)?.settings?.permissionMode
        if (!cancelled && typeof found === 'string') setMode(found)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [context, session.id, wanted, started])
  return mode
}

const MODE_DESCRIPTIONS: Record<string, Record<string, string>> = {
  claude: {
    default: 'Ask before edits and commands',
    acceptEdits: 'Edit files; ask before commands',
    plan: 'Read only until you approve a plan',
    auto: 'A classifier approves safe actions',
    dontAsk: 'Deny anything not pre-approved',
    bypassPermissions: 'Run every tool without asking'
  },
  codex: {
    default: 'Work in the workspace; ask before leaving it',
    'read-only': 'Read only; ask before any change',
    'auto-review': 'A reviewer approves requests to leave the workspace',
    'full-access': 'Run anything with no sandbox or approvals'
  }
}

/**
 * Resolves the model, effort and mode in effect from the picks, the launch settings and the agent's
 * lists. `autoAvailable` is whether Claude offers Auto; leave it undefined before the chat has
 * reported, when Auto is not ruled out.
 */
export function useTurnSettings(
  context: UiPluginContext,
  session: Session,
  capabilities: AgentCapabilities | null,
  options: AgentOptions | null,
  picks: Picks,
  autoAvailable?: boolean
): TurnSettings {
  const launched = launchPicks(session)
  const live = useLiveModels(context, session, capabilities, options)
  const liveMode = useLiveMode(context, session, capabilities)
  const liveList = live !== null && live !== 'failed' ? live.models : []
  const modelList: Choice[] = (options?.models ?? []).map((entry) => ({ value: entry.id, label: entry.label })).concat(liveList)
  const liveCurrent = live !== null && live !== 'failed' ? live.current : null
  const model = picks.model ?? launched.model ?? liveCurrent
  const choices = options ? effortChoices(options, model) : []
  const effort = picks.effort ?? launched.effort ?? ''
  const permissionModes = capabilities?.permissionModes
  const modes = permissionModes?.ok ? permissionModes.modes : []
  const defaultMode = modes[0] ?? null
  const mode = picks.mode ?? (liveMode !== null && modes.includes(liveMode) ? liveMode : null) ?? defaultMode ?? ''
  const labels = permissionModes?.ok ? permissionModes.labels : undefined
  const dangerous = permissionModes?.ok ? permissionModes.dangerous ?? [] : []

  const noModels =
    live === null ? (options !== null && modelList.length === 0 && capabilities?.model.ok ? 'Loading models' : undefined)
    : live === 'failed' ? 'Models unavailable'
    : modelList.length === 0 ? 'No models listed for this agent'
    : undefined
  return {
    modelList,
    model,
    unlisted: model !== null && !modelList.some((entry) => entry.value === model),
    choices,
    effort,
    modes,
    mode,
    defaultMode,
    modeLabel: (name) => labels?.[name] ?? modeLabel(name),
    isDangerous: (name) => dangerous.includes(name),
    modeDescription: (name) => MODE_DESCRIPTIONS[session.agent]?.[name],
    modelReason: reasonOf(capabilities?.model) ?? (options === null ? 'Models unavailable' : options.supported ? noModels : 'This agent takes no model setting'),
    effortReason: reasonOf(capabilities?.effort) ?? (choices.length === 0 ? 'This model has no effort setting' : undefined),
    modeReason: reasonOf(permissionModes),
    modeReasons: modeReasonsOf(capabilities, autoAvailable),
    imagesReason: reasonOf(capabilities?.images)
  }
}

/** A permission mode id as a sentence-case label, "acceptEdits" as "Accept edits"; the fallback when the agent names none. */
export function modeLabel(mode: string): string {
  const words = mode.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' ').toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

export const VISUAL_LEVELS: { value: VisualLevel; label: string; detail: string }[] = [
  { value: 'off', label: 'Off', detail: 'Draws only when you ask' },
  { value: 'balanced', label: 'Balanced', detail: 'Draws when a picture clearly beats prose' },
  { value: 'visual-first', label: 'Visual-first', detail: 'Draws for any structured answer' }
]

export const visualLevelLabel = (level: VisualLevel): string => VISUAL_LEVELS.find((entry) => entry.value === level)?.label ?? level

const DEFAULT_LEVEL_SETTING = 'setting:quirky.structured/default-visual-level'

/** The level a chat with no `visual-level` item draws at: the `default-visual-level` setting. */
export function defaultVisualLevel(context: UiPluginContext): VisualLevel {
  try {
    const value = context.getSetting(DEFAULT_LEVEL_SETTING)
    return value === 'off' || value === 'balanced' || value === 'visual-first' ? value : 'visual-first'
  } catch {
    return 'visual-first'
  }
}

const dialChip = { display: 'inline-flex', alignItems: 'center', gap: 'var(--ui-space-4)', borderRadius: 'var(--ui-radius-window)' } satisfies CSSProperties

/** The composer's visual-level dial: names the level the next message goes out at and lists the three to pick from. */
export function VisualDial({ level, onPick }: { level: VisualLevel; onPick: (level: VisualLevel) => void }) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLDivElement>(null)
  const items: ContextMenuItem[] = VISUAL_LEVELS.map((entry) => ({ id: entry.value, label: entry.label, detail: entry.detail, checked: entry.value === level }))
  const onToggle = () => setOpen(!open)
  const onPickLevel = (item: ContextMenuItem) => {
    setOpen(false)
    if (item.id !== undefined && item.id !== level) onPick(item.id as VisualLevel)
  }
  return (
    <div ref={anchor} style={{ display: 'inline-flex' }}>
      <Button style={dialChip} aria-haspopup="dialog" aria-expanded={open} title="How liberally the agent draws visuals in this chat" onClick={onToggle}>
        {`Visuals: ${visualLevelLabel(level)}`}
        <ControlIcon name="caret-down" />
      </Button>
      <Popover open={open} label="Visual level" anchor={anchor} onClose={() => setOpen(false)}>
        <ContextMenuList
          items={items}
          label="Visual level"
          highlightFirst
          onChoose={onPickLevel}
          onClose={() => setOpen(false)}
        />
      </Popover>
    </div>
  )
}

/** What a chat does when a visual's card asks it to: put a reference in the composer, or expand a visual. */
export type ChatHandle = {
  point?: (ref: VisualRef, label: VisualLabel) => void
  expand?: (viewId: string, version?: number) => void
}

const handles = new Map<string, ChatHandle[]>()

/** Makes the chat of `session` answer `handle`'s commands for as long as it is mounted. */
export function registerChatHandle(session: string, handle: ChatHandle): () => void {
  handles.set(session, [...(handles.get(session) ?? []), handle])
  return () => {
    const rest = (handles.get(session) ?? []).filter((entry) => entry !== handle)
    if (rest.length === 0) handles.delete(session)
    else handles.set(session, rest)
  }
}

/** The newest handler of `action` registered for `session`, or undefined when its chat is not open. */
export function chatHandler<K extends keyof ChatHandle>(session: string, action: K): ChatHandle[K] {
  return [...(handles.get(session) ?? [])].reverse().find((entry) => entry[action] !== undefined)?.[action]
}

type SpecNode = { type?: string; id?: string; props?: Record<string, unknown>; children?: unknown[] }
type LabelRecord = { title?: string; spec?: { root?: SpecNode } }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const textOf = (value: unknown): string => (typeof value === 'string' ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : '')
const itemsOf = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.filter(isRecord) : [])
const clamp = (text: string, max = 120): string => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`
}

/** Mirrors the renderer's key fragment so a stored key can be matched against the spec it was made from. */
const keyPart = (text: string, fallback: string): string => {
  const slug = text.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-._]+|-+$/g, '').slice(0, 40)
  return slug === '' ? fallback : slug
}
const keyOf = (prefix: string, ...parts: string[]): string => [prefix, ...parts].join(':').slice(0, 80)
const withUnit = (value: unknown, unit: string): string => (unit === '' ? textOf(value) : `${textOf(value)} ${unit}`)

/** The node text a Mermaid source gives `id`, from `id[text]`, `id(text)`, `id{text}` or `participant id as text`; null when it names none. */
function mermaidText(source: string, id: string): string | null {
  const shaped = /([A-Za-z0-9_][\w.-]*)\s*(?:\[\[|\[\(|\(\(|\[|\(|\{\{|\{|>)\s*"?([^"\]\)\}\n]+)/g
  for (const match of source.matchAll(shaped)) if (keyPart(match[1]!, 'node') === id) return clamp(match[2]!.replace(/<br\s*\/?>/gi, ' '))
  for (const match of source.matchAll(/(?:participant|actor)\s+([A-Za-z0-9_][\w.-]*)\s+as\s+(.+)/g)) if (keyPart(match[1]!, 'node') === id) return clamp(match[2]!)
  return null
}

/** The element keys `node` makes pointable, each with its label, in the shapes the card renderer gives them. */
function pointsOf(node: SpecNode): [string, string][] {
  const props = node.props ?? {}
  const points: [string, string][] = []
  if (node.id !== undefined) {
    const named = ['title', 'label', 'caption', 'alt', 'path', 'text'].map((name) => textOf(props[name])).find((value) => value !== '')
    points.push([keyOf('node', node.id), clamp(named ?? node.id)])
  }
  const itemKey = (id: unknown, index: number) => keyOf('item', keyPart(textOf(id), String(index)))
  switch (node.type) {
    case 'table':
      ;(Array.isArray(props.rows) ? props.rows.filter(Array.isArray) : []).forEach((row, index) => points.push([keyOf('row', String(index)), clamp(textOf(row[0]))]))
      break
    case 'bar-chart': {
      const unit = textOf(props.unit)
      itemsOf(props.series).forEach((entry, index) => points.push([keyOf('pt', keyPart(textOf(entry.label), String(index))), clamp(`${textOf(entry.label)} ${withUnit(entry.value, unit)}`)]))
      break
    }
    case 'line-chart': {
      const unit = textOf(props.unit)
      itemsOf(props.points).forEach((point, index) => points.push([keyOf('pt', keyPart(textOf(point.x), String(index))), clamp(`${textOf(point.x)} ${withUnit(point.y, unit)}`)]))
      break
    }
    case 'timeline':
      itemsOf(props.items).forEach((entry, index) => points.push([itemKey(entry.id, index), clamp(textOf(entry.label))]))
      break
    case 'board': {
      let running = 0
      for (const column of itemsOf(props.columns)) for (const card of itemsOf(column.cards)) points.push([itemKey(card.id, running++), clamp(textOf(card.title))])
      break
    }
    case 'sketch':
      itemsOf(props.shapes).forEach((shape, index) => points.push([itemKey(shape.id, index), clamp(textOf(shape.label) || `${textOf(shape.kind)} ${index + 1}`)]))
      break
    case 'matrix': {
      const columns = Array.isArray(props.columns) ? props.columns.map(textOf) : []
      itemsOf(props.rows).forEach((row, rowIndex) => {
        const label = textOf(row.label)
        columns.forEach((column, columnIndex) => {
          points.push([keyOf('cell', keyPart(label, String(rowIndex)), keyPart(column, String(columnIndex))), clamp(`${label} › ${column}`)])
        })
      })
      break
    }
    case 'file-map':
      itemsOf(props.entries).forEach((entry, index) => points.push([keyOf('file', String(index)), clamp(textOf(entry.path))]))
      break
  }
  return points
}

/**
 * The text an element key reads as in `spec`: the named node, row, point, item, cell, file, line, diagram
 * node or region it points at, else the key itself.
 */
function labelOfElement(spec: LabelRecord['spec'], element: string): string {
  const [kind, ...rest] = element.split(':')
  const key = rest.join(':')
  const stack: unknown[] = [spec?.root]
  const diagrams: string[] = []
  while (stack.length > 0) {
    const node = stack.pop()
    if (!isRecord(node)) continue
    const entry = node as SpecNode
    const found = pointsOf(entry).find(([candidate]) => candidate === element)
    if (found) return found[1]
    if (entry.type === 'diagram' && isRecord(entry.props)) diagrams.push(textOf(entry.props.source))
    const children = Array.isArray(entry.children) ? entry.children : []
    for (let index = children.length - 1; index >= 0; index--) stack.push(children[index])
  }
  if (kind === 'dg') return diagrams.map((source) => mermaidText(source, key)).find((text): text is string => text !== null) ?? key
  if (kind === 'line' && /^\d+$/.test(key)) return `line ${key}`
  const region = kind === 'region' ? /^(\d+)-(\d+)$/.exec(key) : null
  if (region) return `region near ${region[1]}%,${region[2]}%`
  if (kind === 'pt') return key
  return element
}

/**
 * Teaches reference chips whose visual no one pointed at in this window, such as in older messages, to
 * read as the visual's title and the element, through `quirky.view/get`.
 */
export function useVisualLabels(context: UiPluginContext): void {
  useEffect(() => {
    const resolve = async (ref: VisualRef): Promise<VisualLabel | null> => {
      const record = (await context.call('quirky.view/get', { viewId: ref.viewId, version: ref.version })) as LabelRecord | null
      if (typeof record?.title !== 'string') return null
      return { title: record.title, label: labelOfElement(record.spec, ref.element) }
    }
    setVisualResolver(resolve)
    return () => clearVisualResolver(resolve)
  }, [context])
}
