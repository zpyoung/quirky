import { useEffect, useState, type CSSProperties } from 'react'
import type { AgentCapabilities, Capability, Session, UiPluginContext } from '@quirky/protocol'
import { AgentIcon, Badge, Button, ControlIcon, IconButton, SelectField } from '@quirky/ui'

type Choice = { value: string; label: string }
type ModelOption = { id: string; label: string; type: 'select' | 'boolean'; choices: Choice[] | null }
export type AgentModel = { id: string; label: string; options: ModelOption[] }

/** The part of `quirky.agents/options` the composer reads; null models mean the list could not be loaded. */
export type AgentOptions = { supported: boolean; models: AgentModel[]; unlistedOptions: ModelOption[] }

/** What the user has picked in the composer; null means the agent's own default. */
export type Picks = { model: string | null; effort: string | null; mode: string | null; plan: boolean }

export const NO_PICKS: Picks = { model: null, effort: null, mode: null, plan: false }

const LOADING = 'Loading capabilities'

/** The hover text for a control that `capability` turns off, or undefined when it is on. */
export function reasonOf(capability: Capability | AgentCapabilities['permissionModes'] | undefined): string | undefined {
  if (capability === undefined) return LOADING
  return capability.ok ? undefined : capability.reason
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
        const info = loaded as Partial<AgentOptions> | undefined
        setOptions({ supported: info?.supported !== false, models: info?.models ?? [], unlistedOptions: info?.unlistedOptions ?? [] })
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
  useEffect(() => {
    setLive(null)
    if (!wanted) return
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
  }, [context, session.id, wanted])
  return wanted ? live : null
}

const effortChoices = (options: AgentOptions, model: string | null): Choice[] => {
  const known = options.models.find((entry) => entry.id === model)
  const effort = (known?.options ?? options.unlistedOptions).find((option) => option.id === 'effort')
  return Array.isArray(effort?.choices) ? effort.choices : []
}

/** The model and effort the session was launched with, as the starting picks. */
export function launchPicks(session: Session): Pick<Picks, 'model' | 'effort'> {
  const launched = session.launchSettings?.options
  const model = launched?.model?.value
  const effort = launched?.effort?.value
  return { model: typeof model === 'string' ? model : null, effort: typeof effort === 'string' ? effort : null }
}

const bar = { display: 'flex', alignItems: 'flex-end', flexWrap: 'wrap', gap: 'var(--ui-space-8)', minWidth: 0 } satisfies CSSProperties
const chip = { display: 'inline-flex', alignItems: 'center', gap: 'var(--ui-space-4)' } satisfies CSSProperties
const DROP_HINT = 'Drop images onto the composer'

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

export type ControlsProps = {
  context: UiPluginContext
  session: Session
  capabilities: AgentCapabilities | null
  options: AgentOptions | null
  picks: Picks
  onPicks: (picks: Picks) => void
}

/**
 * The composer's agent chip, model and effort pickers, permission mode, plan toggle and attach button.
 * The desktop shell has no native file picker, so the attach button only tells the user to drop images.
 */
export function Controls({ context, session, capabilities, options, picks, onPicks }: ControlsProps) {
  const launched = launchPicks(session)
  const live = useLiveModels(context, session, capabilities, options)
  const liveList = live !== null && live !== 'failed' ? live.models : []
  const modelList: Choice[] = (options?.models ?? []).map((entry) => ({ value: entry.id, label: entry.label })).concat(liveList)
  const liveCurrent = live !== null && live !== 'failed' ? live.current : null
  const model = picks.model ?? launched.model ?? liveCurrent ?? modelList[0]?.value ?? null
  const choices = options ? effortChoices(options, model) : []
  const effort = picks.effort ?? launched.effort ?? choices[0]?.value ?? ''
  const modes = capabilities?.permissionModes
  const mode = picks.mode ?? (modes?.ok ? modes.modes[0] : undefined) ?? ''

  const noModels =
    live === null ? (options !== null && modelList.length === 0 && capabilities?.model.ok ? 'Loading models' : undefined)
    : live === 'failed' ? 'Models unavailable'
    : modelList.length === 0 ? 'No models listed for this agent'
    : undefined
  const modelReason =
    reasonOf(capabilities?.model) ?? (options === null ? 'Models unavailable' : options.supported ? noModels : 'This agent takes no model setting')
  const effortReason = reasonOf(capabilities?.effort) ?? (choices.length === 0 ? 'This model has no effort setting' : undefined)
  const modeReason = reasonOf(modes)
  const planReason = reasonOf(capabilities?.planMode)
  const imagesReason = reasonOf(capabilities?.images)

  const onAttachHint = () => context.toast('Attach images', DROP_HINT)

  const unlisted = model !== null && !modelList.some((entry) => entry.value === model)

  return (
    <div style={bar}>
      <AgentChip session={session} />
      <SelectField
        label="Model"
        value={model ?? ''}
        disabled={modelReason !== undefined}
        title={modelReason}
        onChange={(event) => onPicks({ ...picks, model: event.target.value, effort: null })}
      >
        {unlisted && <option value={model}>{model}</option>}
        {modelList.map((entry) => (
          <option key={entry.value} value={entry.value}>{entry.label}</option>
        ))}
      </SelectField>
      <SelectField
        label="Effort"
        value={effort}
        disabled={effortReason !== undefined}
        title={effortReason}
        onChange={(event) => onPicks({ ...picks, effort: event.target.value })}
      >
        {choices.map((choice) => (
          <option key={choice.value} value={choice.value}>{choice.label}</option>
        ))}
      </SelectField>
      <SelectField
        label="Permission mode"
        value={mode}
        disabled={modeReason !== undefined}
        title={modeReason}
        onChange={(event) => onPicks({ ...picks, mode: event.target.value })}
      >
        {modes?.ok && modes.modes.map((name) => (
          <option key={name} value={name}>{name}</option>
        ))}
      </SelectField>
      <Button
        aria-pressed={picks.plan}
        disabled={planReason !== undefined}
        title={planReason}
        onClick={() => onPicks({ ...picks, plan: !picks.plan })}
      >
        Plan mode
      </Button>
      <IconButton
        label="Attach images"
        disabled={imagesReason !== undefined}
        title={imagesReason ?? DROP_HINT}
        onClick={onAttachHint}
      >
        <ControlIcon name="plus" />
      </IconButton>
    </div>
  )
}
