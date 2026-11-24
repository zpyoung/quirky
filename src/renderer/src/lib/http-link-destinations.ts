import { translate } from '@/i18n/i18n'
import { openHttpLink, type HttpLinkSourceOwner } from '@/lib/http-link-routing'

// Catalog keys keep their original terminal namespace: they are opaque ids with
// shipped translations, and the popover is now shared with native chat.

export type HttpLinkDestination = 'quirky' | 'system'

export type HttpLinkActionDestinations = {
  primary: HttpLinkDestination
  alternate?: HttpLinkDestination
}

export type HttpLinkAction = {
  external?: boolean
  label: string
  run: () => void | Promise<void>
}

export function canSourceOwnerOpenInQuirky(
  sourceOwner: HttpLinkSourceOwner,
  canOpenOwnedBrowser: boolean
): boolean {
  return (
    sourceOwner.kind === 'local' ||
    ((sourceOwner.kind === 'runtime' || sourceOwner.kind === 'ssh') && canOpenOwnedBrowser)
  )
}

/** Which destinations a clicked link offers, primary first; a remote source that
 *  cannot reach Quirky's managed browser offers only the system browser. */
export function httpLinkActionDestinationsFor(
  settings: { openLinksInApp?: boolean } | null | undefined,
  sourceOwner: HttpLinkSourceOwner,
  canOpenOwnedBrowser: boolean
): HttpLinkActionDestinations {
  if (!canSourceOwnerOpenInQuirky(sourceOwner, canOpenOwnedBrowser)) {
    return { primary: 'system' }
  }
  return settings?.openLinksInApp === true
    ? { primary: 'quirky', alternate: 'system' }
    : { primary: 'system', alternate: 'quirky' }
}

export function httpLinkDestinationLabel(destination: HttpLinkDestination): string {
  return destination === 'quirky'
    ? translate(
        'auto.components.terminal.pane.TerminalLinkActionPopover.quirkyBrowser',
        'Quirky Browser'
      )
    : translate(
        'auto.components.terminal.pane.TerminalLinkActionPopover.systemBrowser',
        'System Browser'
      )
}

/** One action per offered destination; surfaces share the labels and the open call. */
export function buildHttpLinkActions(
  destinations: HttpLinkActionDestinations | undefined,
  open: (destination: HttpLinkDestination | undefined) => void | Promise<void>
): { primary: HttpLinkAction; alternate?: HttpLinkAction } {
  const primaryDestination = destinations?.primary
  const primary: HttpLinkAction = {
    external: primaryDestination === 'system',
    label: primaryDestination
      ? httpLinkDestinationLabel(primaryDestination)
      : translate('auto.components.terminal.pane.TerminalLinkActionPopover.openLink', 'Open link'),
    run: () => open(primaryDestination)
  }
  const alternateDestination = destinations?.alternate
  if (!alternateDestination) {
    return { primary }
  }
  return {
    primary,
    alternate: {
      external: alternateDestination === 'system',
      label: httpLinkDestinationLabel(alternateDestination),
      run: () => open(alternateDestination)
    }
  }
}

export type HttpLinkRoutingPreferenceRequester = (
  url: string
) => boolean | Promise<boolean> | null | undefined

export type RoutedHttpLinkOptions = {
  worktreeId: string
  sourceOwner?: HttpLinkSourceOwner
  modifierHeld?: boolean
  forceDestination?: HttpLinkDestination
  requestOpenLinksInAppPreference?: HttpLinkRoutingPreferenceRequester
}

export function openRoutedHttpLink(url: string, deps: RoutedHttpLinkOptions): void {
  // Why: the clicked link's owner beats the global active runtime for both local and remote routes.
  const sourceOwner = deps.sourceOwner ?? { kind: 'local' }
  if (deps.forceDestination) {
    openHttpLink(url, {
      allowRemoteInApp: true,
      worktreeId: deps.worktreeId,
      forceInApp: deps.forceDestination === 'quirky',
      forceSystemBrowser: deps.forceDestination === 'system',
      sourceOwner
    })
    return
  }
  if (deps.modifierHeld) {
    // Why: the modifier states a destination outright, so it also skips the
    // one-time routing prompt; openHttpLink resolves which destination it means.
    openHttpLink(url, {
      allowRemoteInApp: true,
      worktreeId: deps.worktreeId,
      modifierHeld: true,
      sourceOwner
    })
    return
  }

  // Why: remote sources use the persisted routing preference and never prompt the viewing client.
  const preferenceDecision =
    sourceOwner.kind === 'local' ? deps.requestOpenLinksInAppPreference?.(url) : null
  if (preferenceDecision === null || preferenceDecision === undefined) {
    openHttpLink(url, { allowRemoteInApp: true, worktreeId: deps.worktreeId, sourceOwner })
    return
  }

  // Why: the first link click may need an async preference dialog.
  // Suppress the browser's default link handling first, then route after the
  // persisted choice is available.
  void Promise.resolve(preferenceDecision)
    .then((openInQuirky) => {
      openHttpLink(url, {
        allowRemoteInApp: true,
        worktreeId: deps.worktreeId,
        forceSystemBrowser: !openInQuirky,
        sourceOwner
      })
    })
    .catch(() => {
      openHttpLink(url, {
        allowRemoteInApp: true,
        worktreeId: deps.worktreeId,
        forceSystemBrowser: true,
        sourceOwner
      })
    })
}
