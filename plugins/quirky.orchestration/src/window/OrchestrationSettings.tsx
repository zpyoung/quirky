import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import type { OrchestrationPolicy, OrchestrationSkillAgent, OrchestrationSkillStatus } from '../ui-contracts'
import { announceSetupStatusChanged, createLatestRequestGuard, ORCHESTRATION_EXAMPLES } from './setup-state'

const INSTALL_COMMAND = 'quirky orchestration skill-install'
const SKILL_STATES = ['missing', 'stale', 'ready', 'partial', 'error'] as const
const AGENT_STATES = ['ready', 'missing', 'stale', 'unsupported', 'error'] as const

const rootStyle: CSSProperties = {
  display: 'flex',
  flex: '1 1 auto',
  flexDirection: 'column',
  gap: 16,
  minHeight: 0,
  minWidth: 0,
  overflowY: 'auto',
  padding: 24,
  color: 'var(--text, #d7dae0)',
  background: 'var(--bg, #16181d)'
}
const cardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  padding: 16,
  border: '1px solid var(--border, #2b2f3a)',
  borderRadius: 8,
  background: 'var(--bg-raised, #1d2027)'
}
const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }
const buttonStyle: CSSProperties = {
  border: '1px solid var(--border, #2b2f3a)',
  borderRadius: 6,
  background: 'var(--bg-hover, #262a33)',
  color: 'var(--text, #d7dae0)',
  padding: '7px 11px',
  cursor: 'pointer'
}
const mutedStyle: CSSProperties = { color: 'var(--muted, #8a909e)', margin: 0 }
const errorStyle: CSSProperties = { color: 'var(--danger, #e5534b)', margin: 0 }

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

export function OrchestrationSettings({ context }: { context: UiPluginContext }) {
  const guard = useMemo(() => createLatestRequestGuard(), [])
  const [status, setStatus] = useState<OrchestrationSkillStatus | null>(null)
  const [policy, setPolicy] = useState<OrchestrationPolicy | null>(null)
  const [depth, setDepth] = useState('1')
  const [checking, setChecking] = useState(true)
  const [installing, setInstalling] = useState(false)
  const [savingPolicy, setSavingPolicy] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [error, setError] = useState('')
  const [feedback, setFeedback] = useState('')

  const refresh = useCallback(async () => {
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
  }, [context, guard])

  useEffect(() => {
    void refresh()
    return () => guard.stop()
  }, [guard, refresh])

  const recheck = async () => {
    await refresh()
    announceSetupStatusChanged()
  }

  const install = async () => {
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
      announceSetupStatusChanged()
    } catch (cause) {
      if (guard.isCurrent(token)) setError(errorText(cause))
    } finally {
      if (guard.isCurrent(token)) setInstalling(false)
    }
  }

  const savePolicy = async () => {
    if (policy?.canChange !== true) return
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

  const copy = async (text: string, title: string, command = false) => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is not available in this window.')
      await navigator.clipboard.writeText(text)
      const message = command ? 'Copied install command.' : `Copied prompt: ${title}`
      setFeedback(message)
      context.toast(message, '')
    } catch (cause) {
      const message = command ? 'Failed to copy install command.' : `Failed to copy prompt: ${title}`
      setFeedback(`${message} ${errorText(cause)}`)
      context.toast(message, errorText(cause))
    }
  }

  const action = installAction(status, installing)
  const installCommand = status?.installCommand ?? INSTALL_COMMAND

  return (
    <main style={rootStyle} aria-label="Orchestration settings">
      <header>
        <h1 style={{ margin: '0 0 6px' }}>Orchestration</h1>
        <p style={mutedStyle}>Coordinate multiple coding agents through Quirky.</p>
      </header>

      <section style={cardStyle} aria-labelledby="orchestration-skill-title">
        <div>
          <h2 id="orchestration-skill-title" style={{ margin: '0 0 6px' }}>Orchestration skill</h2>
          <p style={mutedStyle}>Enables agents to coordinate supervised work through Quirky's durable Runs, Tasks, Dispatches, and mailbox.</p>
        </div>
        <div style={rowStyle}>
          <button type="button" style={buttonStyle} disabled={action.disabled || checking} onClick={() => void install()}>{action.label}</button>
          <button type="button" style={buttonStyle} disabled={checking || installing} onClick={() => void recheck()}>{checking ? 'Checking…' : 'Re-check'}</button>
        </div>
        <p style={mutedStyle} aria-live="polite">{checking && status === null ? 'Checking skill coverage…' : status?.text ?? 'Skill coverage is unavailable.'}</p>
        <div>
          <span>Prefer your own terminal? </span>
          <button type="button" style={{ ...buttonStyle, padding: 0, border: 0, background: 'transparent', color: 'var(--accent, #4f8ff7)' }} onClick={() => { setDialogOpen(true); setFeedback('') }}>Copy command</button>
        </div>
        {error && <p style={errorStyle} role="alert">{error}</p>}
        {feedback && <p style={mutedStyle} role="status">{feedback}</p>}
      </section>

      <section style={cardStyle} aria-labelledby="orchestration-coverage-title">
        <h2 id="orchestration-coverage-title" style={{ margin: 0 }}>Agent coverage</h2>
        {checking && status === null && <p style={mutedStyle}>Checking detected agent CLIs…</p>}
        {status?.agents.length === 0 && <p style={mutedStyle}>{status.text}</p>}
        {status && status.agents.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {status.agents.map((agent) => (
              <div key={agent.id} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 8 }}>
                <span style={{ border: '1px solid var(--border, #2b2f3a)', borderRadius: 999, padding: '3px 9px' }} data-agent-state={agent.state}>
                  {agent.label} · {labelState(agent.state)}
                </span>
                {agent.path && <code style={{ color: 'var(--muted, #8a909e)', overflowWrap: 'anywhere' }}>{agent.path}</code>}
                {agent.detail && <span style={agent.state === 'error' ? errorStyle : mutedStyle}>{agent.detail}</span>}
              </div>
            ))}
          </div>
        )}
      </section>

      <section style={cardStyle} aria-labelledby="nested-depth-title">
        <div>
          <h2 id="nested-depth-title" style={{ margin: '0 0 6px' }}>Nested worker depth</h2>
          <p style={mutedStyle}>Maximum worker generations allowed to dispatch another worker. The default is 1; a coordinator is depth 0.</p>
        </div>
        {policy?.canChange === true ? (
          <div style={rowStyle}>
            <label htmlFor="nested-worker-depth">Maximum depth</label>
            <input
              id="nested-worker-depth"
              aria-label="Nested worker depth"
              type="number"
              min={1}
              step={1}
              value={depth}
              onChange={(event) => setDepth(event.currentTarget.value)}
              style={{ width: 96, padding: 6, color: 'var(--text, #d7dae0)', background: 'var(--bg, #16181d)', border: '1px solid var(--border, #2b2f3a)', borderRadius: 5 }}
            />
            <button type="button" style={buttonStyle} disabled={savingPolicy} onClick={() => void savePolicy()}>{savingPolicy ? 'Saving…' : 'Save depth'}</button>
          </div>
        ) : (
          <p style={mutedStyle}>Current depth: {policy?.nestedWorkerMaxDepth ?? 'Checking…'}. This session or paired window is read-only.</p>
        )}
        <p style={mutedStyle}>Changes affect future admission only; active workers are not stopped. This is an orchestration policy, not a hostile-token sandbox or global access-control rule.</p>
      </section>

      <section style={cardStyle} aria-labelledby="orchestration-examples-title">
        <h2 id="orchestration-examples-title" style={{ margin: 0 }}>How to use it</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 260px), 1fr))', gap: 12 }}>
          {ORCHESTRATION_EXAMPLES.map((example) => (
            <article key={example.title} style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 10, padding: 12, border: '1px solid var(--border, #2b2f3a)', borderRadius: 6 }}>
              <h3 style={{ margin: 0 }}>{example.title}</h3>
              <p style={{ ...mutedStyle, flex: 1 }}>{example.prompt}</p>
              <button type="button" style={buttonStyle} aria-label={`Copy prompt: ${example.title}`} onClick={() => void copy(example.prompt, example.title)}>Copy prompt</button>
            </article>
          ))}
        </div>
      </section>

      {dialogOpen && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'grid', placeItems: 'center', padding: 16, background: 'rgba(0, 0, 0, .55)' }}>
          <section role="dialog" aria-modal="true" aria-labelledby="install-command-title" style={{ ...cardStyle, width: 'min(520px, 100%)', boxShadow: '0 12px 48px rgba(0,0,0,.45)' }}>
            <h2 id="install-command-title" style={{ margin: 0 }}>Install orchestration skill</h2>
            <p style={mutedStyle}>Run this command in a terminal to install the orchestration skill for detected agents.</p>
            <code style={{ display: 'block', padding: 12, border: '1px solid var(--border, #2b2f3a)', borderRadius: 5, overflowWrap: 'anywhere' }}>{installCommand}</code>
            {feedback && <p style={feedback.startsWith('Failed') ? errorStyle : mutedStyle} role="status">{feedback}</p>}
            <div style={{ ...rowStyle, justifyContent: 'flex-end' }}>
              <button type="button" style={buttonStyle} aria-label="Copy command to clipboard" onClick={() => void copy(installCommand, '', true)}>Copy command</button>
              <button type="button" style={buttonStyle} onClick={() => { setDialogOpen(false); setFeedback('') }}>Done</button>
            </div>
          </section>
        </div>
      )}
    </main>
  )
}
