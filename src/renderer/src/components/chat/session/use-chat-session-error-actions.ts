import { useMemo } from 'react'
import { AI_VAULT_AGENTS } from '../../../../../shared/ai-vault-types'
import { agentForksConversations } from '../../../../../shared/agent-resume-argv'
import type { AgentType } from '../../../../../shared/agent-status-types'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import { useAppStore } from '@/store'
import { continueNativeChatRestartOffer } from '@/components/native-chat-resume-on-restart-store'
import { runNativeChatCliFork } from '@/components/tab-bar/native-chat-cli-fork-run'
import { resolveTabSessionHistorySubject } from '@/components/tab-bar/tab-session-history-switch'
import type { ChatErrorActions } from '../turn/chat-error-actions'

type Input = {
  tabId: string
  sessionId: string
  agent: AgentType
  target: RuntimeClientTarget
  ownerWorktreeId: string | null
  /** Starts a launch that never published again; present only while that launch is failed. */
  retryLaunch: (() => void) | undefined
}

/**
 * The recovery actions the transcript's error rows offer. Restart retries a failed start, or asks
 * this machine's host to resume the chat; Open in terminal is the tab menu's "Continue with
 * Terminal Agent".
 */
export function useChatSessionErrorActions(input: Input): ChatErrorActions {
  const { tabId, sessionId, agent, target, ownerWorktreeId, retryLaunch } = input
  const forkAgent = AI_VAULT_AGENTS.find((candidate) => candidate === agent)
  const canFork = forkAgent !== undefined && agentForksConversations(agent)
  return useMemo<ChatErrorActions>(() => {
    const actions: ChatErrorActions = {}
    if (retryLaunch) {
      actions.onRestart = retryLaunch
    } else if (target.kind === 'local') {
      actions.onRestart = () => void continueNativeChatRestartOffer([sessionId])
    }
    if (ownerWorktreeId !== null && forkAgent !== undefined && canFork) {
      actions.onOpenInTerminal = () => {
        const tab = { id: tabId, worktreeId: ownerWorktreeId }
        const state = useAppStore.getState()
        const subject = resolveTabSessionHistorySubject(state, {
          tab,
          nativeChat: { sessionId, agent }
        })
        if (subject?.kind !== 'chat') {
          return
        }
        void runNativeChatCliFork({
          subject,
          tab,
          agent: forkAgent,
          commandOverrides: state.settings?.agentCmdOverrides
        })
      }
    }
    return actions
  }, [agent, canFork, forkAgent, ownerWorktreeId, retryLaunch, sessionId, tabId, target.kind])
}
