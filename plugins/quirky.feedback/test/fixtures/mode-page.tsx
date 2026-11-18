import type { UiPluginContext } from '@quirky/protocol'
import type { Comment } from '../../src/contract'
import { mountFeedbackMode } from '../../src/mode'

declare global {
  interface Window {
    feedbackCalls: string[]
    startFeedback(comments: Comment[], options?: { holdList?: boolean; recovered?: boolean }): void
    resolveFeedbackList(): void
    rejectFeedbackList(message: string): void
  }
}

window.feedbackCalls = []
window.startFeedback = (comments, options = {}) => {
  const response = { comments, recovered: options.recovered ?? false }
  let holdList = options.holdList ?? false
  let resolvePending: ((value: typeof response) => void) | null = null
  let rejectPending: ((reason: unknown) => void) | null = null
  window.resolveFeedbackList = () => {
    holdList = false
    resolvePending?.(response)
    resolvePending = null
    rejectPending = null
  }
  window.rejectFeedbackList = (message) => {
    holdList = false
    rejectPending?.(new Error(message))
    resolvePending = null
    rejectPending = null
  }
  const context = {
    pluginId: 'quirky.feedback',
    log() {},
    onLayout: () => () => {},
    toast() {},
    confirm: async () => false,
    executeCommand: async (command: string) => { window.feedbackCalls.push(command) },
    call: async (method: string) => {
      window.feedbackCalls.push(method)
      if (method === 'quirky.feedback/list') {
        if (!holdList) return response
        const pending = Promise.withResolvers<typeof response>()
        resolvePending = pending.resolve
        rejectPending = pending.reject
        return pending.promise
      }
      if (method === 'plugin.list') return []
      return { ok: true }
    }
  } as unknown as UiPluginContext
  mountFeedbackMode(context)
}
