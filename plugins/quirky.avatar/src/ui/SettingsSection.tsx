import { useEffect, useState, type CSSProperties } from 'react'
import { Button, SelectField, TextArea, TextField } from '@quirky/ui'
import type { AgentKind, AvatarSettings, AvatarUiProps, Level, SwitchId } from '../contracts'
import { splitLines } from './sheet-model'

const LEVELS: { id: Level; label: string }[] = [
  { id: 'shadow', label: 'Shadow' },
  { id: 'local', label: 'Local' },
  { id: 'own-branch', label: 'Own branch' },
  { id: 'full', label: 'Full' }
]
const AGENTS: { id: AgentKind; label: string }[] = [
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
  { id: 'pi', label: 'pi' },
  { id: 'omp', label: 'omp' }
]
const SWITCHES: { id: SwitchId; label: string }[] = [
  { id: 'messaging', label: 'Message people (PR comments, reviews, issues, chat)' },
  { id: 'historyRewrite', label: 'Rewrite history or delete remote branches' },
  { id: 'deploys', label: 'Deploy or run migrations' }
]

export const CODEX_BRAIN_NOTE = "Codex can't fully turn off its shell; the avatar interrupts any tool it starts."

const stack: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 'var(--ui-space-12)' }
const row: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 'var(--ui-space-4)' }

/** The form's text-field values; list settings stay as newline-separated text until Save. */
type Form = {
  defaultLevel: Level
  switches: Record<SwitchId, boolean>
  houseRules: string
  allowCommands: string
  denyCommands: string
  deployCommands: string
  brainAgent: AgentKind
  brainModel: string
  judgmentTimeoutSeconds: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toForm(settings: AvatarSettings): Form {
  return {
    defaultLevel: settings.defaultLevel,
    switches: { ...settings.switches },
    houseRules: settings.houseRules.join('\n'),
    allowCommands: settings.allowCommands.join('\n'),
    denyCommands: settings.denyCommands.join('\n'),
    deployCommands: settings.deployCommands.join('\n'),
    brainAgent: settings.brainAgent,
    brainModel: settings.brainModel ?? '',
    judgmentTimeoutSeconds: String(settings.judgmentTimeoutSeconds)
  }
}

function asSettings(value: unknown): AvatarSettings | null {
  if (!isRecord(value) || !isRecord(value.switches)) return null
  const list = (entry: unknown) => (Array.isArray(entry) ? entry.filter((line): line is string => typeof line === 'string') : [])
  return {
    defaultLevel: LEVELS.some((level) => level.id === value.defaultLevel) ? (value.defaultLevel as Level) : 'full',
    switches: {
      messaging: value.switches.messaging === true,
      historyRewrite: value.switches.historyRewrite === true,
      deploys: value.switches.deploys === true
    },
    houseRules: list(value.houseRules),
    allowCommands: list(value.allowCommands),
    denyCommands: list(value.denyCommands),
    deployCommands: list(value.deployCommands),
    brainAgent: AGENTS.some((agent) => agent.id === value.brainAgent) ? (value.brainAgent as AgentKind) : 'claude',
    brainModel: typeof value.brainModel === 'string' && value.brainModel !== '' ? value.brainModel : null,
    judgmentTimeoutSeconds: typeof value.judgmentTimeoutSeconds === 'number' ? value.judgmentTimeoutSeconds : 55
  }
}

function parseTimeout(text: string): number | null {
  const parsed = Number(text)
  return text.trim() !== '' && Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

/** The `quirky.avatar/setSettings` params for `form`, or null when the judgment timeout is not a positive number. */
function toPatch(form: Form): AvatarSettings | null {
  const timeout = parseTimeout(form.judgmentTimeoutSeconds)
  if (timeout === null) return null
  return {
    defaultLevel: form.defaultLevel,
    switches: { ...form.switches },
    houseRules: splitLines(form.houseRules),
    allowCommands: splitLines(form.allowCommands),
    denyCommands: splitLines(form.denyCommands),
    deployCommands: splitLines(form.deployCommands),
    brainAgent: form.brainAgent,
    brainModel: form.brainModel.trim() === '' ? null : form.brainModel.trim(),
    judgmentTimeoutSeconds: timeout
  }
}

/**
 * Settings, Avatar: the defaults every hand-off starts from and the brain's agent, model and
 * timeout. Edits stay local until Save writes them through `quirky.avatar/setSettings`.
 */
export default function SettingsSection({ context }: AvatarUiProps) {
  const [saved, setSaved] = useState<Form | null>(null)
  const [form, setForm] = useState<Form | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    context.call('quirky.avatar/settings', {}).then(
      (value) => {
        if (cancelled) return
        const settings = asSettings(value)
        if (!settings) {
          setFailure('The avatar returned settings in an unknown shape.')
          return
        }
        setSaved(toForm(settings))
        setForm(toForm(settings))
      },
      (error: unknown) => {
        if (!cancelled) setFailure(error instanceof Error ? error.message : String(error))
      }
    )
    return () => { cancelled = true }
  }, [context])

  if (form === null || saved === null) {
    return <div data-avatar-ui="settings">{failure === null ? 'Loading avatar settings…' : <span role="alert">{`Could not load avatar settings: ${failure}`}</span>}</div>
  }

  const edit = (patch: Partial<Form>) => setForm((current) => (current ? { ...current, ...patch } : current))
  const dirty = JSON.stringify(form) !== JSON.stringify(saved)
  const timeoutError = parseTimeout(form.judgmentTimeoutSeconds) === null ? 'Enter a number of seconds above zero.' : undefined

  const save = async () => {
    const patch = toPatch(form)
    if (patch === null) return
    setSaving(true)
    try {
      const result = asSettings(await context.call('quirky.avatar/setSettings', patch))
      const next = result ? toForm(result) : form
      setSaved(next)
      setForm(next)
      setFailure(null)
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={stack} data-avatar-ui="settings">
      <SelectField label="Default level" help="Each hand-off can change it." value={form.defaultLevel} onChange={(event) => edit({ defaultLevel: event.target.value as Level })}>
        {LEVELS.map((level) => <option key={level.id} value={level.id}>{level.label}</option>)}
      </SelectField>
      <div style={row} role="group" aria-label="Floor switches">
        <span>Floor switches</span>
        <span className="ui-help-text">Held unless switched on. Anything outside the handed-off worktrees, and credentials, is always held.</span>
        {SWITCHES.map((entry) => (
          <label key={entry.id} className="ui-checkbox-label">
            <input type="checkbox" checked={form.switches[entry.id]} onChange={(event) => edit({ switches: { ...form.switches, [entry.id]: event.target.checked } })} />
            {entry.label}
          </label>
        ))}
      </div>
      <TextArea label="House rules" help="Added to every mandate. One per line." rows={3} value={form.houseRules} onChange={(event) => edit({ houseRules: event.target.value })} />
      <TextArea label="Always-allowed commands" help="Allowed without judgment. One per line." rows={3} value={form.allowCommands} onChange={(event) => edit({ allowCommands: event.target.value })} />
      <TextArea label="Always-denied commands" help="Always denied. One per line." rows={3} value={form.denyCommands} onChange={(event) => edit({ denyCommands: event.target.value })} />
      <TextArea label="Deploy commands" help="Commands that count as a deploy. One per line." rows={3} value={form.deployCommands} onChange={(event) => edit({ deployCommands: event.target.value })} />
      <SelectField label="Brain agent" help="The agent the avatar runs on." value={form.brainAgent} onChange={(event) => edit({ brainAgent: event.target.value as AgentKind })}>
        {AGENTS.map((agent) => <option key={agent.id} value={agent.id}>{agent.label}</option>)}
      </SelectField>
      {form.brainAgent === 'codex' && <span role="note" className="ui-help-text">{CODEX_BRAIN_NOTE}</span>}
      <TextField label="Brain model" help="Empty uses the agent's default." value={form.brainModel} onChange={(event) => edit({ brainModel: event.target.value })} />
      <TextField
        label="Judgment timeout (seconds)"
        help="How long the gate waits for the brain before asking the agent to retry."
        inputMode="numeric"
        value={form.judgmentTimeoutSeconds}
        error={timeoutError}
        onChange={(event) => edit({ judgmentTimeoutSeconds: event.target.value })}
      />
      {failure !== null && <span role="alert">{failure}</span>}
      <div>
        <Button variant="primary" disabled={!dirty || saving || timeoutError !== undefined} onClick={() => void save()}>Save</Button>
        <Button disabled={!dirty || saving} onClick={() => setForm(saved)}>Revert</Button>
      </div>
    </div>
  )
}
