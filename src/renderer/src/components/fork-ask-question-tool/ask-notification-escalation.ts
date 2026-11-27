import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { getWorktreeMapFromState } from '@/store/selectors'
import { translate } from '@/i18n/i18n'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import {
  isTerminalAskStatus,
  type AskStatus
} from '../../../../shared/fork-ask-question-tool/ask-answer-envelope'
import { createTerminalAttentionSurface } from '../terminal-pane/terminal-attention-surface'

/** How long a pending ask waits on an unfocused pane before escalating to an OS notification. */
export const ASK_NOTIFICATION_ESCALATION_DELAY_MS = 3 * 60_000

export type UseAskNotificationEscalationParams = {
  askId: string | null
  status: AskStatus | null
  worktreeId: string
  paneKey: string
}

/** Seen means the user can read the card: its pane is the focused leaf of the visible tab and the
 * Questions panel is open on it. A visible tab alone does not count. */
function isAskSeen(
  state: ReturnType<typeof useAppStore.getState>,
  worktreeId: string,
  paneKey: string,
  askId: string
): boolean {
  const parsed = parsePaneKey(paneKey)
  if (!parsed) {
    return false
  }
  const paneInFront =
    createTerminalAttentionSurface(state).isSurfaceViewed({
      workspaceId: worktreeId,
      surfaceKey: paneKey
    }) && state.terminalLayoutsByTabId?.[parsed.tabId]?.activeLeafId === parsed.leafId
  return paneInFront && state.rightSidebarOpen && state.askPanelShownAskId === askId
}

function dispatchAskEscalationNotification(
  worktreeId: string,
  paneKey: string,
  askId: string
): void {
  const state = useAppStore.getState()
  const worktree = getWorktreeMapFromState(state).get(worktreeId)
  const worktreeLabel = worktree?.displayName ?? worktreeId
  void window.api.notifications
    .dispatch({
      source: 'pending-ask',
      notificationId: `ask-pending-${askId}`,
      worktreeId,
      paneKey,
      isActiveWorktree: state.activeWorktreeId === worktreeId,
      title: translate(
        'components.fork-ask-question-tool.notification.title',
        'Pending question in {{worktreeLabel}}',
        { worktreeLabel }
      ),
      body: translate(
        'components.fork-ask-question-tool.notification.body',
        'Waiting for your answer.'
      )
    })
    .catch((err) => {
      console.warn('Failed to dispatch ask escalation notification:', err)
    })
}

/**
 * Arms an OS-notification escalation for a pending ask while its owning pane is unfocused, per
 * tech.md § C8 (Notification escalation). Focusing the pane, the ask resolving, or the ask
 * changing all cancel any in-flight timer.
 */
export function useAskNotificationEscalation({
  askId,
  status,
  worktreeId,
  paneKey
}: UseAskNotificationEscalationParams): void {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const armedAskIdRef = useRef<string | null>(null)
  const [focusTick, setFocusTick] = useState(0)

  useEffect(() => {
    const bump = (): void => setFocusTick((tick) => tick + 1)
    window.addEventListener('focus', bump)
    window.addEventListener('blur', bump)
    document.addEventListener('visibilitychange', bump)
    return () => {
      window.removeEventListener('focus', bump)
      window.removeEventListener('blur', bump)
      document.removeEventListener('visibilitychange', bump)
    }
  }, [])

  // focusTick is a re-render trigger only: window focus is not store state, so the selector must re-run
  void focusTick
  const seen = useAppStore((state) =>
    askId === null ? false : isAskSeen(state, worktreeId, paneKey, askId)
  )

  const isPending = askId !== null && status !== null && !isTerminalAskStatus(status)

  useEffect(() => {
    if (!isPending || askId === null || seen) {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      armedAskIdRef.current = null
      return
    }
    if (armedAskIdRef.current === askId) {
      return
    }
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
    }
    armedAskIdRef.current = askId
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      // the pane may have been seen during the delay; only a fresh check catches that
      if (!isAskSeen(useAppStore.getState(), worktreeId, paneKey, askId)) {
        dispatchAskEscalationNotification(worktreeId, paneKey, askId)
      }
    }, ASK_NOTIFICATION_ESCALATION_DELAY_MS)
  }, [askId, isPending, seen, worktreeId, paneKey])

  useEffect(
    () => () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      armedAskIdRef.current = null
    },
    []
  )
}
