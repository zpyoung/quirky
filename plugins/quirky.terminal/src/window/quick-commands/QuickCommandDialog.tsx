import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { Button, Dialog, FormRow, InlineError } from '@quirky/ui'
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

export const QUICK_COMMAND_DIALOG_COMMAND = 'command:quirky.terminal/quick-command-dialog'

export type QuickCommandDialogArgs =
  | { action: 'open'; command?: string; repo?: string }
  | { action: 'toggle-advanced' }
  | { action: 'toggle-append-enter' }

export type QuickCommandDialogResult =
  | { ok: true; dialog: 'add' | 'edit' }
  | { ok: true; advanced: boolean }
  | { ok: true; appendEnter: boolean }
  | { ok: false; reason: string }

type DialogController = {
  dialog: 'add' | 'edit'
  kind: 'terminal' | 'agent'
  advancedOpen: boolean
  appendEnter: boolean
  setAdvancedOpen?: (open: boolean) => void
  setAppendEnter?: (appendEnter: boolean) => void
  close(): void
}

type QuickCommandListResult = { commands: QuickCommand[] }
type AgentListResult = { agents: AgentRow[] }
type QuickCommandDialogInput = { action?: unknown; command?: unknown; repo?: unknown }

const dialogControllers = new WeakMap<UiPluginContext, DialogController>()
const retiredDialogContexts = new WeakSet<UiPluginContext>()

/** Closes the activation's modal and refuses late results from its pending command lookups. */
export function disposeQuickCommandDialog(context: UiPluginContext): void {
  retiredDialogContexts.add(context)
  dialogControllers.get(context)?.close()
  dialogControllers.delete(context)
}

/** Runs the dialog command with a literal ID, so every caller in the window routes through it. */
export function requestQuickCommandDialog(context: UiPluginContext, args: QuickCommandDialogArgs): Promise<void> {
  return context.executeCommand(QUICK_COMMAND_DIALOG_COMMAND, args)
}

/** The agents a quick command can start: installed, enabled, and given their prompt on the command line. */
async function loadAgentOptions(context: UiPluginContext): Promise<AgentOption[]> {
  const result = (await context.call('quirky.agents/list', {})) as AgentListResult
  return result.agents.filter((entry) => entry.installed && entry.enabled && entry.promptMode !== 'stdin-after-start').map((entry) => ({ id: entry.id, label: entry.label }))
}
/**
 * The Add / Edit Quick Command form. It saves through the daemon and shows a refusal inline, so
 * the text survives a rejected save. Terminal and Agent keep separate drafts: switching action
 * never turns a command line into a prompt. Save is Cmd+Enter and Escape closes.
 */
export function QuickCommandDialog({ context, command, repo, onClose: onDialogClose, onSaved }: QuickCommandDialogProps) {
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
  const [agentLoadError, setAgentLoadError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const labelInput = useRef<HTMLInputElement>(null)
  const dialogHost = useRef<HTMLDivElement>(null)
  const controllerRef = useRef<DialogController | null>(null)
  const closeRef = useRef<() => void>(() => {})
  const repoName = useRepoName(context, projectRepo)
  const onClose = () => {
    const controller = controllerRef.current
    if (controller !== null && dialogControllers.get(context) === controller) dialogControllers.delete(context)
    onDialogClose()
  }
  closeRef.current = onClose

  useEffect(() => {
    let live = true
    void loadAgentOptions(context).then((options) => {
      if (live) {
        setAgents(options)
        setAgentLoadError(null)
      }
    }).catch((failure: unknown) => {
      if (live) setAgentLoadError(`Could not load agents: ${messageOf(failure)}`)
    })
    return () => {
      live = false
    }
  }, [context])
  useEffect(() => {
    const existing = dialogControllers.get(context)
    const controller = existing ?? {
      dialog: editing ? 'edit' : 'add',
      kind,
      advancedOpen,
      appendEnter,
      close: () => closeRef.current()
    }
    if (existing === undefined) {
      dialogControllers.set(context, controller)
    } else {
      setKind(existing.kind)
      setAdvancedOpen(existing.advancedOpen)
      setAppendEnter(existing.appendEnter)
    }
    controllerRef.current = controller
    controller.setAdvancedOpen = setAdvancedOpen
    controller.setAppendEnter = setAppendEnter
    controller.close = () => closeRef.current()
    return () => {
      if (dialogControllers.get(context) === controller) dialogControllers.delete(context)
      controller.setAdvancedOpen = undefined
      controller.setAppendEnter = undefined
      controllerRef.current = null
    }
  }, [context])

  useEffect(() => {
    const controller = controllerRef.current
    if (controller !== null) controller.kind = kind
  }, [kind])

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
    if (savingRef.current) return
    onClose()
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
      let result: QuickCommandListResult
      if (editing) {
        result = (await context.call('quirky.terminal/updateQuickCommand', { id: command.id, ...fields })) as QuickCommandListResult
      } else {
        result = (await context.call('quirky.terminal/addQuickCommand', fields)) as QuickCommandListResult
      }
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
          <Button onClick={onClose} disabled={saving}>Cancel</Button>
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

            <FormRow label="Agent" htmlFor="qc-command-agent" error={agentLoadError ?? undefined}>
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
              onClick={() => void requestQuickCommandDialog(context, { action: 'toggle-append-enter' })}
            >
              <span className="qc-switch-track" aria-hidden="true" />
              Append Enter — run immediately
            </Button>

            <Button type="button" className="qc-advanced-toggle" aria-expanded={advancedOpen} onClick={() => void requestQuickCommandDialog(context, { action: 'toggle-advanced' })}>
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

            {error !== null ? <InlineError message={error} /> : null}
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
type OpenQuickCommandDialogProps = Omit<QuickCommandDialogProps, 'onClose'> & { onClose?(): void }
export function openQuickCommandDialog(props: OpenQuickCommandDialogProps): () => void {
  if (retiredDialogContexts.has(props.context)) throw new Error('Terminal is not active')
  const existing = dialogControllers.get(props.context)
  if (existing !== undefined) return existing.close

  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  let open = true
  let controller: DialogController
  const close = () => {
    if (!open) return
    open = false
    if (dialogControllers.get(props.context) === controller) dialogControllers.delete(props.context)
    props.onClose?.()
    queueMicrotask(() => {
      root.unmount()
      host.remove()
    })
  }
  controller = {
    dialog: props.command === null ? 'add' : 'edit',
    kind: props.command?.kind ?? 'terminal',
    advancedOpen: true,
    appendEnter: props.command?.kind === 'agent' ? true : (props.command?.appendEnter ?? true),
    close
  }
  dialogControllers.set(props.context, controller)
  root.render(
    <QuickCommandDialog
      context={props.context}
      command={props.command}
      repo={props.repo}
      onSaved={props.onSaved}
      onClose={close}
    />
  )
  return close
}

/** Handles the public command without throwing on malformed arguments or refused operations. */
export async function quickCommandDialogCommand(context: UiPluginContext, raw: unknown): Promise<QuickCommandDialogResult> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'action must be one of open, toggle-advanced, toggle-append-enter' }
  }
  const args = raw as QuickCommandDialogInput
  if (args.action === 'open') {
    const unexpected = Object.keys(raw).find((key) => !['action', 'command', 'repo'].includes(key))
    if (unexpected !== undefined) return { ok: false, reason: `unexpected argument ${unexpected}` }
    if (args.command !== undefined && typeof args.command !== 'string') return { ok: false, reason: 'command must be a string' }
    if (args.repo !== undefined && typeof args.repo !== 'string') return { ok: false, reason: 'repo must be a string' }
    if (args.command === '') return { ok: false, reason: 'command must be a quick command ID' }
    try {
      let command: QuickCommand | null = null
      if (typeof args.command === 'string') {
        const result = (await context.call('quirky.terminal/quickCommands', { all: true })) as QuickCommandListResult
        command = result.commands.find((entry) => entry.id === args.command) ?? null
        if (command === null) return { ok: false, reason: `no quick command ${args.command}` }
      }
      const existing = dialogControllers.get(context)
      if (existing !== undefined) return { ok: true, dialog: existing.dialog }
      const dialog = command === null ? 'add' : 'edit'
      openQuickCommandDialog({
        context,
        command,
        repo: typeof args.repo === 'string' ? args.repo : null
      })
      return { ok: true, dialog }
    } catch (error) {
      return { ok: false, reason: messageOf(error) }
    }
  }
  if (args.action === 'toggle-advanced' || args.action === 'toggle-append-enter') {
    const unexpected = Object.keys(raw).find((key) => key !== 'action')
    if (unexpected !== undefined) return { ok: false, reason: `unexpected argument ${unexpected}` }
    const controller = dialogControllers.get(context)
    if (controller === undefined) return { ok: false, reason: 'no quick command dialog is open' }
    if (args.action === 'toggle-advanced') {
      controller.advancedOpen = !controller.advancedOpen
      controller.setAdvancedOpen?.(controller.advancedOpen)
      return { ok: true, advanced: controller.advancedOpen }
    }
    if (controller.kind === 'agent') return { ok: false, reason: 'Append Enter applies only to terminal commands' }
    controller.appendEnter = !controller.appendEnter
    controller.setAppendEnter?.(controller.appendEnter)
    return { ok: true, appendEnter: controller.appendEnter }
  }
  return { ok: false, reason: 'action must be one of open, toggle-advanced, toggle-append-enter' }
}
