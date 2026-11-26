import { useState } from 'react'
import { useQuirkyAsksForWorktree } from '../ask/use-quirky-asks-for-worktree'
import type { MobileSessionController } from './use-mobile-session-controller'
import { MobileQuirkyAskCard } from './MobileQuirkyAskCard'
import { MobileQuirkyAskSummary } from './MobileQuirkyAskSummary'

/**
 * The agent-raised `quirky ask` for this workspace, docked above the input area: the current
 * question while one is waiting, otherwise the outcome of the latest one until dismissed.
 */
export function MobileSessionQuirkyAsk({
  controller
}: {
  controller: MobileSessionController
}): React.JSX.Element | null {
  const { client, connState, hostCapabilities, worktreeId } = controller
  const { liveAsks, settledAsks } = useQuirkyAsksForWorktree({
    client,
    hostCapabilities,
    worktreeId
  })
  const [dismissedAskIds, setDismissedAskIds] = useState<ReadonlySet<string>>(new Set())
  if (!client) {
    return null
  }
  const current = liveAsks[0]
  if (current) {
    return (
      <MobileQuirkyAskCard
        key={current.askId}
        ask={current}
        client={client}
        connected={connState === 'connected'}
        queuedCount={liveAsks.length - 1}
      />
    )
  }
  const settled = settledAsks.find((ask) => !dismissedAskIds.has(ask.askId))
  if (!settled) {
    return null
  }
  return (
    <MobileQuirkyAskSummary
      ask={settled}
      onDismiss={() => setDismissedAskIds((previous) => new Set(previous).add(settled.askId))}
    />
  )
}
