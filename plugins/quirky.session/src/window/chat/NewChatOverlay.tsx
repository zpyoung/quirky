import { useSyncExternalStore } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import { Dialog, InlineError } from '@quirky/ui'
import { AgentPicker } from './AgentPicker'
import { adoptNewChat, closeNewChatDialog, failNewChat, getNewChatDialog, noteChatCreated, subscribeNewChatDialog } from './newChat'

/** Renders the "New chat" dialog the `new-chat` command opens over whatever window is showing. */
export function NewChatOverlay({ context }: { context: UiPluginContext }) {
  const dialog = useSyncExternalStore(subscribeNewChatDialog, getNewChatDialog)
  if (dialog === null) return null
  const { created } = dialog
  return (
    <Dialog open title="New chat" onClose={() => closeNewChatDialog(dialog.id)}>
      {dialog.error !== null && (
        <InlineError
          message={dialog.error}
          action={created === null ? undefined : { label: 'Retry', onAction: () => void adoptNewChat(context, dialog, created) }}
        />
      )}
      {created === null && (
        <AgentPicker
          heading={false}
          key={dialog.id}
          context={context}
          worktree={dialog.workspace}
          onError={(message) => failNewChat(dialog.id, message)}
          onCreated={(session) => {
            noteChatCreated(dialog.id, session)
            void adoptNewChat(context, dialog, session)
          }}
        />
      )}
    </Dialog>
  )
}
