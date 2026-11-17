import { useEffect, useState, type CSSProperties } from 'react'
import type { AgentCapabilities, Capability, Session, UiPluginContext } from '@quirky/protocol'
import { AgentIcon, Badge } from '@quirky/ui'

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

/** What the user has picked in the composer; null means the agent's own default. */
export type Picks = { model: string | null; effort: string | null; mode: string | null; plan: boolean }

export const NO_PICKS: Picks = { model: null, effort: null, mode: null, plan: false }

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
  modes: string[]
  mode: string
  defaultMode: string | null
  modelReason: string | undefined
  effortReason: string | undefined
  modeReason: string | undefined
  planReason: string | undefined
  imagesReason: string | undefined
}

/** Resolves the model, effort and mode in effect from the picks, the launch settings and the agent's lists. */
export function useTurnSettings(
  context: UiPluginContext,
  session: Session,
  capabilities: AgentCapabilities | null,
  options: AgentOptions | null,
  picks: Picks
): TurnSettings {
  const launched = launchPicks(session)
  const live = useLiveModels(context, session, capabilities, options)
  const liveList = live !== null && live !== 'failed' ? live.models : []
  const modelList: Choice[] = (options?.models ?? []).map((entry) => ({ value: entry.id, label: entry.label })).concat(liveList)
  const liveCurrent = live !== null && live !== 'failed' ? live.current : null
  const model = picks.model ?? launched.model ?? liveCurrent
  const choices = options ? effortChoices(options, model) : []
  const effort = picks.effort ?? launched.effort ?? ''
  const permissionModes = capabilities?.permissionModes
  const modes = permissionModes?.ok ? permissionModes.modes : []
  const defaultMode = modes[0] ?? null
  const mode = picks.mode ?? defaultMode ?? ''

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
    modelReason: reasonOf(capabilities?.model) ?? (options === null ? 'Models unavailable' : options.supported ? noModels : 'This agent takes no model setting'),
    effortReason: reasonOf(capabilities?.effort) ?? (choices.length === 0 ? 'This model has no effort setting' : undefined),
    modeReason: reasonOf(permissionModes),
    planReason: reasonOf(capabilities?.planMode),
    imagesReason: reasonOf(capabilities?.images)
  }
}

/** A permission mode id as a sentence-case label, "acceptEdits" as "Accept edits". */
export function modeLabel(mode: string): string {
  const words = mode.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' ').toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}
