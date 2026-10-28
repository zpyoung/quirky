import { useCallback, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { MountFunction, QuirkyEvent, UiPluginContext } from '@quirky/protocol'
import type { OrchestrationSkillStatus } from './ui-contracts'
import { OrchestrationSettings } from './window/OrchestrationSettings'
import { RemoteWorkerOutputView } from './window/RemoteWorkerOutputView'
import {
  announceSetupDismissed,
  createLatestRequestGuard,
  dismissSetup,
  isSetupDismissed,
  SETUP_DISMISSED_EVENT,
  SETUP_STATUS_CHANGED_EVENT
} from './window/setup-state'

const SETTINGS_VIEW_ID = 'view:quirky.orchestration/settings'
const REMOTE_WORKER_OUTPUT_VIEW_ID = 'view:quirky.orchestration/remote-worker-output'
const SETUP_OVERLAY_ID = 'overlay:quirky.orchestration/floating-setup'
const OPEN_SETTINGS_COMMAND_ID = 'command:quirky.orchestration/open-settings'
const DISMISS_SETUP_COMMAND_ID = 'command:quirky.orchestration/dismiss-setup'

const buttonStyle = {
  border: '1px solid var(--border, #2b2f3a)',
  borderRadius: 6,
  background: 'var(--bg-hover, #262a33)',
  color: 'var(--text, #d7dae0)',
  padding: '7px 11px',
  cursor: 'pointer'
} as const

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSkillStatus(value: unknown): value is OrchestrationSkillStatus {
  if (!isObject(value) || !Array.isArray(value.agents) || typeof value.state !== 'string') return false
  if (typeof value.installCommand !== 'string' || typeof value.text !== 'string') return false
  return value.agents.every((agent) => isObject(agent) && typeof agent.id === 'string' && typeof agent.label === 'string' && typeof agent.state === 'string')
}

function isFloatingState(value: unknown): value is { enabled: boolean; open: boolean } {
  return isObject(value) && typeof value.enabled === 'boolean' && typeof value.open === 'boolean'
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type FloatingSetupProps = { context: UiPluginContext; report?: (state: unknown) => void }

function FloatingSetupOverlay({ context, report }: FloatingSetupProps) {
  const guard = useMemo(() => createLatestRequestGuard(), [])
  const [floating, setFloating] = useState<{ enabled: boolean; open: boolean } | null>(null)
  const [status, setStatus] = useState<OrchestrationSkillStatus | null>(null)
  const [dismissed, setDismissed] = useState(isSetupDismissed)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    const token = guard.next()
    try {
      const [rawFloating, rawStatus] = await Promise.all([
        context.call('quirky.terminal/floating', {}),
        context.call('quirky.orchestration/skillStatus', {})
      ])
      if (!guard.isCurrent(token)) return
      if (!isFloatingState(rawFloating) || !isSkillStatus(rawStatus)) throw new Error('Could not read current orchestration setup state.')
      setFloating(rawFloating)
      setStatus(rawStatus)
      setError('')
    } catch (cause) {
      if (guard.isCurrent(token)) setError(errorText(cause))
    }
  }, [context, guard])

  useEffect(() => {
    void refresh()
    const unsubscribe = context.subscribe((event: QuirkyEvent) => {
      if (event.type === 'quirky.terminal/floating') void refresh()
    })
    const onSetupStatus = () => { void refresh() }
    const onSetupDismissed = () => { setDismissed(true) }
    window.addEventListener(SETUP_STATUS_CHANGED_EVENT, onSetupStatus)
    window.addEventListener(SETUP_DISMISSED_EVENT, onSetupDismissed)
    return () => {
      guard.stop()
      unsubscribe()
      window.removeEventListener(SETUP_STATUS_CHANGED_EVENT, onSetupStatus)
      window.removeEventListener(SETUP_DISMISSED_EVENT, onSetupDismissed)
    }
  }, [context, guard, refresh])

  const hasReadySkill = status?.agents.some((agent) => agent.state === 'ready') === true
  const shown = floating?.enabled === true && floating.open && !dismissed && !hasReadySkill
  useEffect(() => { report?.({ shown, floating, status, error: error || null }) }, [shown, floating, status, error, report])

  if (!shown) return null
  const openSettings = async () => {
    try {
      await context.executeCommand(OPEN_SETTINGS_COMMAND_ID)
    } catch (cause) {
      setError(errorText(cause))
    }
  }
  const dismiss = async () => {
    try {
      await context.executeCommand(DISMISS_SETUP_COMMAND_ID)
    } catch (cause) {
      setError(errorText(cause))
    }
  }

  return (
    <aside
      aria-label="Enable orchestration"
      style={{
        position: 'fixed',
        right: 16,
        bottom: 16,
        zIndex: 900,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        width: 'min(300px, calc(100vw - 32px))',
        boxSizing: 'border-box',
        padding: 14,
        border: '1px solid var(--border, #2b2f3a)',
        borderRadius: 8,
        color: 'var(--text, #d7dae0)',
        background: 'var(--bg-raised, #1d2027)',
        boxShadow: '0 8px 28px rgba(0,0,0,.3)'
      }}
    >
      <strong>Enable orchestration</strong>
      <span style={{ color: 'var(--muted, #8a909e)' }}>Set up the skill so agents can coordinate supervised work through Quirky.</span>
      {error && <span role="alert" style={{ color: 'var(--danger, #e5534b)' }}>{error}</span>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button type="button" style={buttonStyle} onClick={() => void dismiss()}>Dismiss</button>
        <button type="button" style={buttonStyle} onClick={() => void openSettings()}>Enable</button>
      </div>
    </aside>
  )
}

function setViewStyle(element: HTMLElement): void {
  Object.assign(element.style, { display: 'flex', flex: '1 1 auto', minWidth: '0', minHeight: '0', overflow: 'hidden' })
}

export function activate(context: UiPluginContext): void {
  const mountSettings: MountFunction = (element) => {
    setViewStyle(element)
    const root = createRoot(element)
    root.render(<OrchestrationSettings context={context} />)
    return () => root.unmount()
  }
  context.provide(SETTINGS_VIEW_ID, mountSettings)
  const mountRemoteWorkerOutput: MountFunction = (element, props) => {
    setViewStyle(element)
    const root = createRoot(element)
    root.render(<RemoteWorkerOutputView context={context} input={props.input} />)
    return () => root.unmount()
  }
  context.provide(REMOTE_WORKER_OUTPUT_VIEW_ID, mountRemoteWorkerOutput)

  context.provide(SETUP_OVERLAY_ID, (element: HTMLElement, props: { report?: (state: unknown) => void }) => {
    element.style.display = 'contents'
    const root = createRoot(element)
    root.render(<FloatingSetupOverlay context={context} report={props.report} />)
    return () => root.unmount()
  })

  context.provide(OPEN_SETTINGS_COMMAND_ID, () => context.openView(SETTINGS_VIEW_ID))
  context.provide(DISMISS_SETUP_COMMAND_ID, () => {
    dismissSetup()
    announceSetupDismissed()
  })
}
