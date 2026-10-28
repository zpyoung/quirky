import { useEffect, useState, type MouseEvent } from 'react'
import { CHORD_PLATFORM, type UiPluginContext } from '@quirky/protocol'

const OPEN_IN_APP = 'setting:quirky.browser/openLinksInApp'
const MODIFIER_INVERTS = 'setting:quirky.browser/openLinksInAppModifierInverts'

type RoutingSettings = { openInApp: boolean | null; modifierInverts: boolean | null }
type LinkClickEvent = Pick<MouseEvent<HTMLButtonElement>, 'ctrlKey' | 'metaKey' | 'shiftKey' | 'detail'>

function currentSettings(context: UiPluginContext): RoutingSettings {
  const openInApp = context.getSetting(OPEN_IN_APP)
  const modifierInverts = context.getSetting(MODIFIER_INVERTS)
  return {
    openInApp: typeof openInApp === 'boolean' ? openInApp : null,
    modifierInverts: typeof modifierInverts === 'boolean' ? modifierInverts : null
  }
}

function alternateChord(): string {
  return CHORD_PLATFORM === 'darwin' ? 'Shift+Cmd-click' : 'Shift+Ctrl-click'
}

function routingHint(settings: RoutingSettings): string {
  const chord = alternateChord()
  if (settings.openInApp === null || settings.modifierInverts === null) {
    return `Open on GitHub; ${chord} uses the alternate routing destination.`
  }

  const normal = settings.openInApp ? 'Quirky Browser' : 'system browser'
  const alternate = settings.modifierInverts
    ? settings.openInApp ? 'system browser' : 'Quirky Browser'
    : 'system browser'
  return `Open on GitHub in ${normal}; ${chord} opens in ${alternate}.`
}

function isAlternateClick(event: LinkClickEvent): boolean {
  if (!event.shiftKey || event.detail === 0) return false
  return CHORD_PLATFORM === 'darwin' ? event.metaKey : event.ctrlKey
}

export function useReviewLinkRouting(context: UiPluginContext) {
  const [settings, setSettings] = useState(() => currentSettings(context))

  useEffect(() => {
    let mounted = true
    setSettings(currentSettings(context))
    const unsubscribe = context.subscribe((event) => {
      if (!mounted || event.type !== 'setting.changed') return
      if (event.id === OPEN_IN_APP) {
        setSettings((previous) => ({
          ...previous,
          openInApp: typeof event.value === 'boolean' ? event.value : null
        }))
      } else if (event.id === MODIFIER_INVERTS) {
        setSettings((previous) => ({
          ...previous,
          modifierInverts: typeof event.value === 'boolean' ? event.value : null
        }))
      }
    })
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [context])

  return {
    title: routingHint(settings),
    invert: isAlternateClick
  }
}
