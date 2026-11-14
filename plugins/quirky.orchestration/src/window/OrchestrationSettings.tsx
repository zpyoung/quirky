import { Badge, Button, Dialog, EmptyState, InlineError, ListRow, NoticeLine, TextField, ToolPanelFrame } from '@quirky/ui'
import { useEffect, useMemo, useState } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import type { OrchestrationPolicy, OrchestrationSkillAgent, OrchestrationSkillStatus } from '../ui-contracts'
import { createLatestRequestGuard, ORCHESTRATION_EXAMPLES, ORCHESTRATION_INSTALL_COMMAND, type SetupSignals } from './setup-state'

const COPY_INSTALL_COMMAND_ID = 'command:quirky.orchestration/copy-install-command'
const COPY_PROMPT_COMMAND_ID = 'command:quirky.orchestration/copy-prompt'
const SKILL_STATES = ['missing', 'stale', 'ready', 'partial', 'error'] as const
const AGENT_STATES = ['ready', 'missing', 'stale', 'unsupported', 'error'] as const

type OrchestrationExample = (typeof ORCHESTRATION_EXAMPLES)[number]
type CopyResult = { ok: true } | { ok: false; message: string }


function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSkillAgent(value: unknown): value is OrchestrationSkillAgent {
  return isObject(value) && typeof value.id === 'string' && typeof value.label === 'string' &&
    AGENT_STATES.includes(value.state as (typeof AGENT_STATES)[number]) &&
    (value.path === null || typeof value.path === 'string') &&
    (value.detail === null || typeof value.detail === 'string')
}

function isSkillStatus(value: unknown): value is OrchestrationSkillStatus {
  return isObject(value) && SKILL_STATES.includes(value.state as (typeof SKILL_STATES)[number]) &&
    Array.isArray(value.agents) && value.agents.every(isSkillAgent) &&
    typeof value.installCommand === 'string' && typeof value.text === 'string'
}

function isPolicy(value: unknown): value is OrchestrationPolicy {
  return isObject(value) && typeof value.nestedWorkerMaxDepth === 'number' &&
    Number.isSafeInteger(value.nestedWorkerMaxDepth) && value.nestedWorkerMaxDepth >= 1 &&
    typeof value.canChange === 'boolean'
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function labelState(state: OrchestrationSkillAgent['state']): string {
  return state[0]!.toUpperCase() + state.slice(1)
}

function installAction(status: OrchestrationSkillStatus | null, busy: boolean): { label: string; disabled: boolean } {
  if (busy) return { label: 'Installing…', disabled: true }
  if (status === null) return { label: 'Install', disabled: true }
  const installable = status.agents.some((agent) => agent.state === 'missing' || agent.state === 'stale' || agent.state === 'error')
  if (!installable && status.state !== 'error') return { label: status.state === 'ready' ? 'Installed' : 'No installable targets', disabled: true }
  if (status.state === 'error' || status.agents.some((agent) => agent.state === 'error')) return { label: 'Retry', disabled: false }
  if (status.state === 'stale' || status.agents.some((agent) => agent.state === 'stale')) return { label: 'Update', disabled: false }
  return { label: 'Install', disabled: false }
}

type InstallCommandControlProps = {
  installCommand: string
  open: boolean
  copy: CopyResult | null
  onOpen: () => void
  onClose: () => void
  onCopy: () => void
}

function InstallCommandControl({ installCommand, open, copy, onOpen, onClose, onCopy }: InstallCommandControlProps) {
  return (
    <>
      <div className="ui-cluster">
        <span>Prefer your own terminal?</span>
        <Button onClick={onOpen}>Copy command</Button>
      </div>
      <Dialog
        open={open}
        title="Install orchestration skill"
        closeOnBackdrop={false}
        onClose={onClose}
        actions={
          <>
            <Button aria-label="Copy command to clipboard" onClick={onCopy}>Copy command</Button>
            <Button onClick={onClose}>Done</Button>
          </>
        }
      >
        <div className="ui-stack">
          <p>Run this command in a terminal to install the orchestration skill for detected agents.</p>
          <code className="ui-readout">{installCommand}</code>
          {copy?.ok === true ? <p className="ui-text-muted" role="status" data-orchestration-copy-status>Copied install command.</p> : null}
          {copy?.ok === false ? <InlineError message={copy.message} /> : null}
        </div>
      </Dialog>
    </>
  )
}

export function OrchestrationSettings({ context, signals }: { context: UiPluginContext; signals: SetupSignals }) {
  const guard = useMemo(() => createLatestRequestGuard(), [])
  const [status, setStatus] = useState<OrchestrationSkillStatus | null>(null)
  const [policy, setPolicy] = useState<OrchestrationPolicy | null>(null)
  const [depth, setDepth] = useState('1')
  const [checking, setChecking] = useState(true)
  const [installing, setInstalling] = useState(false)
  const [savingPolicy, setSavingPolicy] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [dialogCopy, setDialogCopy] = useState<CopyResult | null>(null)
  const [error, setError] = useState('')
  const [feedback, setFeedback] = useState('')

  const busy = checking || installing || savingPolicy

  async function refresh(): Promise<void> {
    const token = guard.next()
    setChecking(true)
    setError('')
    try {
      const [rawStatus, rawPolicy] = await Promise.all([
        context.call('quirky.orchestration/skillStatus', {}),
        context.call('quirky.orchestration/policyShow', {})
      ])
      if (!guard.isCurrent(token)) return
      if (!isSkillStatus(rawStatus) || !isPolicy(rawPolicy)) throw new Error('The orchestration setup API returned an invalid status.')
      setStatus(rawStatus)
      setPolicy(rawPolicy)
      setDepth(String(rawPolicy.nestedWorkerMaxDepth))
    } catch (cause) {
      if (guard.isCurrent(token)) setError(errorText(cause))
    } finally {
      if (guard.isCurrent(token)) setChecking(false)
    }
  }

  useEffect(() => {
    void refresh()
    return () => guard.stop()
  }, [context, guard])

  const recheck = async () => {
    if (busy) return
    await refresh()
    signals.statusChanged.emit()
  }

  const install = async () => {
    if (busy) return
    const token = guard.next()
    const agentIds = status?.agents
      .filter((agent) => agent.state === 'missing' || agent.state === 'stale' || agent.state === 'error')
      .map((agent) => agent.id)
    setInstalling(true)
    setError('')
    try {
      const raw = await context.call('quirky.orchestration/skillInstall', agentIds && agentIds.length > 0 ? { agents: agentIds } : {})
      if (!guard.isCurrent(token)) return
      if (!isSkillStatus(raw)) throw new Error('The install response did not include orchestration skill status.')
      setStatus(raw)
      setFeedback(raw.text)
      signals.statusChanged.emit()
    } catch (cause) {
      if (guard.isCurrent(token)) setError(errorText(cause))
    } finally {
      if (guard.isCurrent(token)) setInstalling(false)
    }
  }

  const savePolicy = async () => {
    if (busy || policy?.canChange !== true) return
    const value = Number(depth)
    if (!Number.isSafeInteger(value) || value < 1) {
      setError('Nested worker depth must be an integer greater than or equal to 1.')
      return
    }
    const token = guard.next()
    setSavingPolicy(true)
    setError('')
    try {
      const raw = await context.call('quirky.orchestration/policySet', { nestedWorkerMaxDepth: value })
      if (!guard.isCurrent(token)) return
      if (!isPolicy(raw)) throw new Error('The policy response is invalid.')
      setPolicy(raw)
      setDepth(String(raw.nestedWorkerMaxDepth))
      setFeedback(`Nested worker depth set to ${raw.nestedWorkerMaxDepth}.`)
    } catch (cause) {
      if (guard.isCurrent(token)) setError(errorText(cause))
    } finally {
      if (guard.isCurrent(token)) setSavingPolicy(false)
    }
  }

  const copyPrompt = async (example: OrchestrationExample) => {
    try {
      await context.executeCommand(COPY_PROMPT_COMMAND_ID, { example: example.id }, { activateOwner: false })
      setError('')
      const message = `Copied prompt: ${example.title}`
      setFeedback(message)
      context.toast(message, '')
    } catch (cause) {
      const message = `Failed to copy prompt: ${example.title}`
      setFeedback('')
      setError(`${message} ${errorText(cause)}`)
      context.toast(message, errorText(cause))
    }
  }

  const copyInstallCommand = async () => {
    try {
      await context.executeCommand(COPY_INSTALL_COMMAND_ID, {}, { activateOwner: false })
      const message = 'Copied install command.'
      setDialogCopy({ ok: true })
      context.toast(message, '')
    } catch (cause) {
      const message = 'Failed to copy install command.'
      setDialogCopy({ ok: false, message: `${message} ${errorText(cause)}` })
      context.toast(message, errorText(cause))
    }
  }

  const openInstallDialog = () => {
    setDialogCopy(null)
    setDialogOpen(true)
  }

  const closeInstallDialog = () => {
    setDialogOpen(false)
    setDialogCopy(null)
  }

  const action = installAction(status, installing)
  const installCommand = status?.installCommand ?? ORCHESTRATION_INSTALL_COMMAND
  const loadingSetup = checking && status === null

  return (
    <main className="ui-stack" style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: 'var(--ui-space-16)' }} aria-label="Orchestration settings">
      <ToolPanelFrame title="Orchestration">
        <p className="ui-text-muted">Coordinate multiple coding agents through Quirky.</p>
      </ToolPanelFrame>

      <ToolPanelFrame
        title="Orchestration skill"
        actions={
          <div className="ui-cluster">
            <Button disabled={action.disabled || busy} onClick={() => void install()}>{action.label}</Button>
            <Button disabled={busy} onClick={() => void recheck()}>{checking ? 'Checking…' : 'Re-check'}</Button>
          </div>
        }
      >
        <p>Enables agents to coordinate supervised work through Quirky's durable Runs, Tasks, Dispatches, and mailbox.</p>
        <div aria-live="polite" data-orchestration-skill-summary>
          {loadingSetup ? <NoticeLine>Checking skill coverage…</NoticeLine> : <p className="ui-text-muted">{status?.text ?? 'Skill coverage is unavailable.'}</p>}
        </div>
        <InstallCommandControl
          installCommand={installCommand}
          open={dialogOpen}
          copy={dialogCopy}
          onOpen={openInstallDialog}
          onClose={closeInstallDialog}
          onCopy={() => void copyInstallCommand()}
        />
        {error ? <InlineError message={error} /> : null}
        {feedback ? <p className="ui-text-muted" role="status" data-orchestration-feedback>{feedback}</p> : null}
      </ToolPanelFrame>

      <ToolPanelFrame title="Agent coverage">
        {loadingSetup
          ? <EmptyState message="Checking detected agent CLIs…" />
          : status?.agents.length === 0
            ? <EmptyState message={status.text} />
            : status && status.agents.length > 0
              ? <div className="ui-stack">
                  {status.agents.map((agent) => (
                    <div key={agent.id} className="ui-stack" data-orchestration-agent={agent.id}>
                      <ListRow
                        status={agent.state === 'ready' ? 'done' : agent.state === 'error' ? 'failing' : agent.state === 'unsupported' ? 'idle' : 'needs-you'}
                        title={<><span data-agent-state={agent.state}>{agent.label}</span><Badge tone={agent.state === 'ready' ? 'accent' : agent.state === 'error' ? 'failing' : agent.state === 'unsupported' ? 'neutral' : 'needs-you'}>{labelState(agent.state)}</Badge></>}
                        description={
                          <span className="ui-stack">
                            {agent.path ? <code className="ui-text-muted" style={{ overflowWrap: 'anywhere' }}>{agent.path}</code> : null}
                            {agent.detail && agent.state !== 'error' ? <span className="ui-text-muted">{agent.detail}</span> : null}
                          </span>
                        }
                      />
                      {agent.state === 'error' ? <InlineError message={agent.detail ?? 'This skill target needs attention.'} /> : null}
                    </div>
                  ))}
                </div>
              : <p className="ui-text-muted">Agent coverage is unavailable.</p>}
      </ToolPanelFrame>

      <ToolPanelFrame title="Nested worker depth">
        <p className="ui-text-muted">Maximum worker generations allowed to dispatch another worker. The default is 1; a coordinator is depth 0.</p>
        {policy === null ? (
          checking ? <NoticeLine>Checking nested worker depth…</NoticeLine> : <p className="ui-text-muted">Nested worker depth is unavailable.</p>
        ) : policy.canChange ? (
          <div className="ui-stack">
            <TextField
              id="nested-worker-depth"
              label="Nested worker depth"
              aria-label="Nested worker depth"
              type="number"
              min={1}
              step={1}
              value={depth}
              disabled={busy}
              onChange={(event) => setDepth(event.currentTarget.value)}
            />
            <div className="ui-cluster">
              <Button disabled={busy} onClick={() => void savePolicy()}>{savingPolicy ? 'Saving…' : 'Save depth'}</Button>
            </div>
          </div>
        ) : (
          <p className="ui-text-muted">Current depth: {policy.nestedWorkerMaxDepth}. This session or paired window is read-only.</p>
        )}
        <p className="ui-text-muted">Changes affect future admission only; active workers are not stopped. This is an orchestration policy, not a hostile-token sandbox or global access-control rule.</p>
      </ToolPanelFrame>

      <ToolPanelFrame title="How to use it">
        <div className="ui-stack">
          {ORCHESTRATION_EXAMPLES.map((example) => (
            <ListRow
              key={example.id}
              title={example.title}
              description={example.prompt}
              trailing={<Button aria-label={`Copy prompt: ${example.title}`} onClick={() => void copyPrompt(example)}>Copy prompt</Button>}
            />
          ))}
        </div>
      </ToolPanelFrame>
    </main>
  )
}
