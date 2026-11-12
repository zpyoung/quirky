import type { UiPluginContext } from '@quirky/protocol'
import type { Comment } from '../../src/contract'
import { mountFeedbackMode } from '../../src/mode'

declare global {
  interface Window {
    feedbackCalls: string[]
    startFeedback(comments: Comment[]): void
  }
}

window.feedbackCalls = []
window.startFeedback = (comments) => {
  const context = {
    pluginId: 'quirky.feedback',
    log() {},
    onLayout: () => () => {},
    toast() {},
    confirm: async () => false,
    call: async (method: string) => {
      window.feedbackCalls.push(method)
      if (method === 'quirky.feedback/list') return { comments, recovered: false }
      if (method === 'plugin.list') return []
      return { ok: true }
    }
  } as unknown as UiPluginContext
  mountFeedbackMode(context, { annotate: async () => {} })
}
