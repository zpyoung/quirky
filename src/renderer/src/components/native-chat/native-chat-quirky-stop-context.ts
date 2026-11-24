import { createContext, useContext } from 'react'

/** What a structured chat tells its rows about an Quirky stop: the name of the machine whose Quirky runs
 *  it, as Quirky shows that host everywhere (null when it has none to show), whether that machine is a
 *  remote host rather than this desktop, and whether its host can continue a cut, which only a host
 *  known not to has no Continue for. */
export type NativeChatQuirkyStopView = {
  hostLabel: string | null
  remoteHost: boolean
  continueAvailable: boolean
  /** The cut turn whose row carries Continue right now, if any. */
  offeredTurnItemId: string | null
  continueNow: () => void
  /** The turn a usage limit ended whose row carries Continue right now, if any. */
  usageLimitTurnItemId: string | null
  usageLimitContinueDisabled?: boolean
  continueUsageLimit: (hadFocus?: boolean) => void
}

export const NativeChatQuirkyStopContext = createContext<NativeChatQuirkyStopView>({
  hostLabel: null,
  remoteHost: false,
  continueAvailable: false,
  offeredTurnItemId: null,
  continueNow: () => {},
  usageLimitTurnItemId: null,
  continueUsageLimit: () => {}
})

export function useNativeChatQuirkyStopView(): NativeChatQuirkyStopView {
  return useContext(NativeChatQuirkyStopContext)
}
