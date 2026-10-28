import { useCallback, useState } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import { messageOf } from '../panel/format'
import type { FixAction, LaunchParams } from './types'

const STARTED: Readonly<Record<FixAction, string>> = {
  fixCommitFailure: 'Started an AI agent for the commit failure.',
  fixPushFailure: 'Started an AI agent for the push failure.',
  resolveConflicts: 'Started an AI agent for the conflicts.',
  branchSummary: 'Started an AI agent for the branch summary.',
  pullRequestDetails: 'Started an AI agent for pull-request details.',
  pullRequestReview: 'Started an AI agent for the pull-request review.',
  reviewConversation: 'Started an AI agent to draft a pull-request conversation reply.'
}

export type AiFix = {
  /** A launch is in flight. */
  busy: boolean
  /**
   * Opens an agent tab for the action: with the saved recipe and default agent, or with what
   * a launch dialog chose. Toasts the outcome; resolves with whether the agent started.
   */
  start(action: FixAction, launch?: LaunchParams): Promise<boolean>
}

/** Starts AI Fix and Resolve with AI launches in one worktree. */
export function useAiFix(context: UiPluginContext, worktree: string): AiFix {
  const [busy, setBusy] = useState(false)
  const start = useCallback(
    async (action: FixAction, launch?: LaunchParams): Promise<boolean> => {
      setBusy(true)
      try {
        await context.call('quirky.git/aiFix', { worktree, action, ...launch })
        context.toast(STARTED[action], '')
        return true
      } catch (error) {
        context.toast('Could not start an AI agent', messageOf(error))
        return false
      } finally {
        setBusy(false)
      }
    },
    [context, worktree]
  )
  return { busy, start }
}
