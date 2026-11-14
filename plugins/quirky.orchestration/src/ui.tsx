import { Button, ToolPanelFrame } from '@quirky/ui'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
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
import { placeSetupCard, type PlacementRect, type SetupPlacement } from './setup-placement'

const SETTINGS_VIEW_ID = 'view:quirky.orchestration/settings'
const REMOTE_WORKER_OUTPUT_VIEW_ID = 'view:quirky.orchestration/remote-worker-output'
const SETUP_OVERLAY_ID = 'overlay:quirky.orchestration/floating-setup'
const OPEN_SETTINGS_COMMAND_ID = 'command:quirky.orchestration/open-settings'
const DISMISS_SETUP_COMMAND_ID = 'command:quirky.orchestration/dismiss-setup'


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
function useSetupPlacement(cardRef: { current: HTMLElement | null }, enabled: boolean): SetupPlacement {
  const [placement, setPlacement] = useState<SetupPlacement>({ left: 16, top: 16, maxHeight: window.innerHeight })

  useLayoutEffect(() => {
    const card = cardRef.current
    if (!enabled || !card) return

    let button: HTMLElement | null = null
    let statusBar: HTMLElement | null = null
    let resizeObserver: ResizeObserver | null = null
    let buttonObserver: MutationObserver | null = null
    let bodyObserver: MutationObserver | null = null
    let active = true

    const update = () => {
      if (!active) return
      const nextButton = document.querySelector<HTMLElement>('[data-floating-button]')
      if (nextButton !== button) {
        if (button) resizeObserver?.unobserve(button)
        buttonObserver?.disconnect()
        button = nextButton
        if (button) {
          resizeObserver?.observe(button)
          if (typeof MutationObserver !== 'undefined') {
            buttonObserver = new MutationObserver(update)
            buttonObserver.observe(button, { attributes: true, attributeFilter: ['style'] })
          }
        }
      }

      const nextStatusBar = document.querySelector<HTMLElement>('[data-region="status-bar"]')
      if (nextStatusBar !== statusBar) {
        if (statusBar) resizeObserver?.unobserve(statusBar)
        statusBar = nextStatusBar
        if (statusBar) resizeObserver?.observe(statusBar)
      }

      const measure = (element: HTMLElement): PlacementRect => {
        const { left, top, width, height } = element.getBoundingClientRect()
        return { left, top, width, height }
      }
      const nextPlacement = placeSetupCard({
        viewport: { width: window.innerWidth, height: window.innerHeight },
        button: button ? measure(button) : null,
        statusBar: statusBar ? measure(statusBar) : null,
        card: measure(card)
      })
      setPlacement((current) =>
        current.left === nextPlacement.left &&
        current.top === nextPlacement.top &&
        current.maxHeight === nextPlacement.maxHeight
          ? current
          : nextPlacement
      )
    }

    resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    resizeObserver?.observe(card)
    window.addEventListener('resize', update)
    if (typeof MutationObserver !== 'undefined' && document.body) {
      bodyObserver = new MutationObserver((records) => {
        const changed = records.some((record) =>
          [...record.addedNodes, ...record.removedNodes].some((node) => {
            if (node === button || node === statusBar) return true
            if (node instanceof Element && ((button && node.contains(button)) || (statusBar && node.contains(statusBar)))) return true
            if (!button && node instanceof Element && node.matches('[data-floating-button]')) return true
            return !statusBar && node instanceof Element && node.matches('[data-region="status-bar"]')
          })
        )
        if (changed) update()
      })
      bodyObserver.observe(document.body, { childList: true })
    }
    update()

    return () => {
      active = false
      window.removeEventListener('resize', update)
      resizeObserver?.disconnect()
      buttonObserver?.disconnect()
      bodyObserver?.disconnect()
    }
  }, [cardRef, enabled])

  return placement
}


function FloatingSetupOverlay({ context, report }: FloatingSetupProps) {
  const guard = useMemo(() => createLatestRequestGuard(), [])
  const cardRef = useRef<HTMLElement>(null)
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
  const placement = useSetupPlacement(cardRef, shown)

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
      ref={cardRef}
      aria-label="Enable orchestration"
      style={{
        position: 'fixed',
        left: placement.left,
        top: placement.top,
        zIndex: 900,
        width: 'min(30ch, calc(100vw - 2 * var(--ui-space-16)))',
        maxHeight: placement.maxHeight,
        overflowY: 'auto',
        overscrollBehavior: 'contain',
        pointerEvents: 'auto'
      }}
    >
      <ToolPanelFrame title="Enable orchestration">
        <p className="ui-text-muted">Set up the skill so agents can coordinate supervised work through Quirky.</p>
        {error && <p className="ui-error-text" role="alert">{error}</p>}
        <div className="ui-cluster">
          <Button onClick={() => void dismiss()}>Dismiss</Button>
          <Button variant="primary" onClick={() => void openSettings()}>Enable</Button>
        </div>
      </ToolPanelFrame>
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
