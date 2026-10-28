import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { Button, Dialog, FormRow } from '@quirky/ui'
import type { UiPluginContext } from '@quirky/protocol'
import { QUICK_COMMAND_LIMITS, type QuickCommand } from '../../layout/types'
import { messageOf, useRepoName } from './shared'

export type QuickCommandDialogProps = {
  context: UiPluginContext
  /** The command to edit, or null to add one. */
  command: QuickCommand | null
  /** The repo a new Project-scoped command belongs to; null where there is none (the floating workspace). */
  repo: string | null
  onClose(): void
  /** Called with every saved command after a save lands, just before the dialog closes. */
  onSaved?(commands: QuickCommand[]): void
}

type AgentOption = { id: string; label: string }
type AgentRow = { id: string; label: string; installed: boolean; enabled: boolean; promptMode: string }

/** The agents a quick command can start: installed, enabled, and given their prompt on the command line. */
async function loadAgentOptions(context: UiPluginContext): Promise<AgentOption[]> {
  try {
    const result = (await context.call('quirky.agents/list', {})) as { agents: AgentRow[] }
    return result.agents.filter((entry) => entry.installed && entry.enabled && entry.promptMode !== 'stdin-after-start').map((entry) => ({ id: entry.id, label: entry.label }))
  } catch {
    return []
  }
}

/**
 * The Add / Edit Quick Command form. It saves through the daemon and shows a refusal inline, so
 * the text survives a rejected save. Terminal and Agent keep separate drafts: switching action
 * never turns a command line into a prompt. Save is Cmd+Enter and Escape closes.
 */
export function QuickCommandDialog({ context, command, repo, onClose, onSaved }: QuickCommandDialogProps) {
  const editing = command !== null
  const title = editing ? 'Edit Quick Command' : 'Add Quick Command'

  const [label, setLabel] = useState(command?.label ?? '')
  const [kind, setKind] = useState<'terminal' | 'agent'>(command?.kind ?? 'terminal')
  const [agent, setAgent] = useState(command?.agent ?? '')
  const [terminalText, setTerminalText] = useState(command?.kind === 'agent' ? '' : (command?.command ?? ''))
  const [agentText, setAgentText] = useState(command?.kind === 'agent' ? command.command : '')
  const [appendEnter, setAppendEnter] = useState(command?.kind === 'agent' ? true : (command?.appendEnter ?? true))
  const projectRepo = (command?.scope === 'repo' ? command.repo : null) ?? repo
  // null until the person picks one: the repo can arrive after the dialog opens, and Project is then the default
  const [pickedScope, setScope] = useState<'global' | 'repo' | null>(command ? command.scope : null)
  const scope = pickedScope === 'repo' && projectRepo === null ? 'global' : (pickedScope ?? (projectRepo !== null ? 'repo' : 'global'))
  const [advancedOpen, setAdvancedOpen] = useState(true)
  const [agents, setAgents] = useState<AgentOption[]>([])
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const labelInput = useRef<HTMLInputElement>(null)
  const dialogHost = useRef<HTMLDivElement>(null)
  const repoName = useRepoName(context, projectRepo)

  useEffect(() => {
    let live = true
    void loadAgentOptions(context).then((options) => {
      if (live) setAgents(options)
    })
    return () => {
      live = false
    }
  }, [context])

  useEffect(() => {
    if (kind === 'agent' && agent === '' && agents.length > 0) setAgent(agents[0]!.id)
  }, [kind, agent, agents])

  useEffect(() => {
    labelInput.current?.focus()
  }, [])

  useEffect(() => {
    dialogHost.current?.querySelector<HTMLElement>('[role="dialog"]')?.setAttribute('aria-label', title)
  }, [title])

  const text = kind === 'agent' ? agentText : terminalText
  const agentChosen = agents.some((option) => option.id === agent)
  const canSave = !saving && label.trim() !== '' && text.trim() !== '' && (kind === 'terminal' || agentChosen)

  const close = () => {
    if (!savingRef.current) onClose()
  }
  const save = async () => {
    if (savingRef.current || !canSave) return
    savingRef.current = true
    setSaving(true)
    setError(null)
    const fields: Record<string, unknown> = {
      label: label.trim(),
      kind,
      ...(kind === 'agent' ? { agent } : {}),
      command: text.trimEnd(),
      ...(kind === 'terminal' ? { appendEnter } : {}),
      scope,
      ...(scope === 'repo' ? { repo: projectRepo } : {})
    }
    try {
      const method = editing ? 'quirky.terminal/updateQuickCommand' : 'quirky.terminal/addQuickCommand'
      const result = (await context.call(method, editing ? { id: command.id, ...fields } : fields)) as { commands: QuickCommand[] }
      onSaved?.(result.commands)
      onClose()
    } catch (failure) {
      setError(messageOf(failure))
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && canSave) {
      event.preventDefault()
      void save()
    }
  }

  const chooseKind = (next: 'terminal' | 'agent') => {
    setKind(next)
    setError(null)
  }

  return createPortal(
    <div ref={dialogHost} className="qc-dialog">
      <Dialog open title={title} onClose={close} closeOnBackdrop={!saving} actions={
        <div className="qc-dialog-foot">
          <Button onClick={close} disabled={saving}>Cancel</Button>
          <Button variant="primary" title="Save (⌘Enter)" disabled={!canSave} onClick={() => void save()}>
            Save
          </Button>
        </div>
      }>
        <div className="qc-dialog-content">
          <p className="ui-text-muted">Saved items appear in the tab bar menu for one-click run.</p>
          <fieldset className="qc-dialog-body" disabled={saving} onKeyDown={onKeyDown}>
            <div className="qc-row-fields">
              <FormRow label="Label" htmlFor="qc-command-label">
                <input
                  id="qc-command-label"
                  ref={labelInput}
                  className="ui-text-field__input"
                  name="label"
                  placeholder="Start dev server"
                  maxLength={QUICK_COMMAND_LIMITS.label}
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                />
              </FormRow>
              <fieldset className="qc-fieldset">
                <legend>Action</legend>
                <span>
                  <label className="qc-choice">
                    <input type="radio" name="action" value="terminal" checked={kind === 'terminal'} onChange={() => chooseKind('terminal')} />
                    Terminal
                  </label>
                  <label className="qc-choice">
                    <input type="radio" name="action" value="agent" checked={kind === 'agent'} onChange={() => chooseKind('agent')} />
                    Agent
                  </label>
                </span>
              </fieldset>
            </div>

            <FormRow label="Agent" htmlFor="qc-command-agent">
              <select
                id="qc-command-agent"
                className="ui-text-field__input"
                name="agent"
                aria-label="Agent"
                disabled={kind === 'terminal'}
                value={agentChosen ? agent : ''}
                onChange={(event) => setAgent(event.target.value)}
              >
                <option value="">Choose agent</option>
                {agents.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </FormRow>

            <FormRow
              label={kind === 'agent' ? 'Prompt' : 'Command'}
              htmlFor="qc-command-text"
              help={kind === 'agent' ? 'Multi-line prompts are fine. Keep them focused.' : 'Several lines run as one line joined with "; ".'}
            >
              <textarea
                id="qc-command-text"
                className="ui-text-field__input qc-textarea"
                name="command"
                aria-label={kind === 'agent' ? 'Prompt' : 'Command'}
                placeholder={kind === 'agent' ? 'Ask the agent to investigate this workspace' : 'npm run dev'}
                maxLength={QUICK_COMMAND_LIMITS.command}
                value={text}
                onChange={(event) => (kind === 'agent' ? setAgentText(event.target.value) : setTerminalText(event.target.value))}
              />
            </FormRow>

            <Button
              className="qc-switch"
              role="switch"
              name="appendEnter"
              aria-checked={kind === 'terminal' && appendEnter}
              disabled={kind === 'agent'}
              onClick={() => setAppendEnter((on) => !on)}
            >
              <span className="qc-switch-track" aria-hidden="true" />
              Append Enter — run immediately
            </Button>

            <Button type="button" className="qc-advanced-toggle" aria-expanded={advancedOpen} onClick={() => setAdvancedOpen((open) => !open)}>
              <span aria-hidden="true">{advancedOpen ? '▾' : '▸'}</span>
              Advanced
            </Button>
            {advancedOpen ? (
              <fieldset className="qc-fieldset">
                <legend>Scope</legend>
                <span>
                  <label className="qc-choice">
                    <input type="radio" name="scope" value="global" checked={scope === 'global'} onChange={() => setScope('global')} />
                    Global
                  </label>
                  {projectRepo !== null ? (
                    <label className="qc-choice">
                      <input type="radio" name="scope" value="repo" checked={scope === 'repo'} onChange={() => setScope('repo')} />
                      Project
                      <span className="qc-note">{repoName}</span>
                    </label>
                  ) : null}
                </span>
              </fieldset>
            ) : null}

            {error !== null ? <div className="ui-error-text" role="alert">{error}</div> : null}
          </fieldset>
        </div>
      </Dialog>
    </div>,
    document.body
  )
}

/**
 * Opens the dialog in its own React root on `document.body`, for callers with no React tree to
 * render it in (a menu item's handler). Returns a function that closes it.
 */
export function openQuickCommandDialog(props: Omit<QuickCommandDialogProps, 'onClose'> & { onClose?(): void }): () => void {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  let open = true
  const close = () => {
    if (!open) return
    open = false
    props.onClose?.()
    queueMicrotask(() => {
      root.unmount()
      host.remove()
    })
  }
  root.render(<QuickCommandDialog {...props} onClose={close} />)
  return close
}
