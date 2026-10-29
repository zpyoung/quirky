import { createRoot } from 'react-dom/client'
import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { Badge, Button } from '@quirky/ui'
import type { UiPluginContext } from '@quirky/protocol'
import { MobilePage, MOBILE_PAGE_ID, MOBILE_SETTINGS_ID } from './window/MobilePage'
import { MobileSettings } from './window/MobileSettings'
import { useMobileState } from './window/useMobileState'

const MOBILE_SIDEBAR_ID = 'sidebar-section:quirky.mobile/mobile'

type MountProps = { input?: unknown; report?(state: unknown): void }

function useUiLayout(context: UiPluginContext) {
  const subscribe = useCallback((notify: () => void) => context.onLayout(() => notify()), [context])
  const getSnapshot = useCallback(() => context.getLayout(), [context])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

function MobileSidebar({ context, report }: { context: UiPluginContext; report?: (state: unknown) => void }) {
  const mobile = useMobileState(context)
  const layout = useUiLayout(context)
  const hidden = mobile.state?.showMobileButton === false
  const onboardingSeen = mobile.state?.onboardingSeen === true

  useEffect(() => {
    report?.({ shown: !hidden, active: layout.view?.id === MOBILE_PAGE_ID, onboardingSeen, tryIt: !onboardingSeen })
  }, [report, hidden, layout.view?.id, onboardingSeen])

  if (hidden) return null

  const open = async () => {
    const showIntro = !onboardingSeen
    if (showIntro) {
      try {
        await mobile.configure({ onboardingSeen: true })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        context.toast('Could not update Mobile onboarding', message, { kind: 'error' })
      }
    }
    context.openView(MOBILE_PAGE_ID, showIntro ? { stage: 'intro' } : undefined)
  }

  return (
    <div className="ui-stack">
      <Button aria-label="Mobile" onClick={() => void open()}>
        <span aria-hidden="true">▣</span>
        <span>Mobile</span>
        {!onboardingSeen && <Badge tone="accent">Try it</Badge>}
      </Button>
    </div>
  )
}

/** Registers Mobile's sidebar, dedicated views and command-routed navigation. */
export function activate(context: UiPluginContext): void {
  context.provide(MOBILE_SIDEBAR_ID, (element: HTMLElement, props: MountProps) => {
    const root = createRoot(element)
    root.render(<MobileSidebar context={context} report={props.report} />)
    return () => root.unmount()
  })

  context.provide(MOBILE_PAGE_ID, (element: HTMLElement, props: MountProps) => {
    const root = createRoot(element)
    root.render(<MobilePage context={context} input={props.input} report={props.report} />)
    return () => root.unmount()
  })

  context.provide(MOBILE_SETTINGS_ID, (element: HTMLElement, props: MountProps) => {
    const root = createRoot(element)
    root.render(<MobileSettings context={context} report={props.report} />)
    return () => root.unmount()
  })

  context.provide('command:quirky.mobile/open', () => context.openView(MOBILE_PAGE_ID))
  context.provide('command:quirky.mobile/open-settings', () => context.openView(MOBILE_SETTINGS_ID))
}
