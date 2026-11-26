import { forwardRef, useMemo } from 'react'
import { isAgentSessionConversationCommand } from '../../../../../shared/agent-session-conversation-command'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import type { AgentType } from '../../../../../shared/agent-status-types'
import type { StructuredAgentSessionQueuedMessagesController } from '@/components/native-chat/use-structured-agent-session-queued-messages'
import type { NativeChatComposerNotice } from '@/components/native-chat/native-chat-composer-notice'
import type { NativeChatComposerErrorDetail } from '@/components/native-chat/native-chat-composer-error-detail'
import type { useStructuredAgentSession } from '@/components/native-chat/use-structured-agent-session'
import { NativeChatPromptSlotNotices } from '@/components/native-chat/NativeChatComposerNotices'
import { structuredAgentLabel } from '@/lib/structured-agent-session-launch-label'
import { translate } from '@/i18n/i18n'
import {
  useHostStructuredAgent,
  useStructuredAgentAcceptsImages
} from '@/runtime/use-host-structured-agent'
import { structuredAgentSessionDraftScopeKey } from '@/components/native-chat/native-chat-composer-draft-store'
import { Composer } from '../composer/Composer'
import { composerCommandsFor, type ComposerCommand } from '../composer/composer-commands'
import type {
  ComposerHandle,
  ComposerQueueMove,
  ComposerSubmit,
  ComposerWorkspace
} from '../composer/composer-types'

type Controller = ReturnType<typeof useStructuredAgentSession>

/** Why a paired chat's files can't upload yet: its host has not created the chat. */
function sessionAttachmentNotReadyNotice(agent: AgentType, starting: boolean): string {
  const label = structuredAgentLabel(agent)
  return starting
    ? translate(
        'components.native-chat.composer.sessionAttachmentsStarting',
        '{{agent}} chat is still opening. Wait for it to open, then attach the files again.',
        { agent: label }
      )
    : translate(
        'components.native-chat.composer.sessionAttachmentsFailed',
        '{{agent}} chat could not open. Use Retry in the chat, then attach the files again.',
        { agent: label }
      )
}

export type ChatSessionComposerProps = {
  controller: Controller
  sessionId: string
  agent: AgentType
  target: RuntimeClientTarget
  tabId: string
  paneKey: string
  /** The workspace the tab belongs to, which `@` file search reads. */
  worktreeId: string | undefined
  /** The queue as shown: the controller's, with steering held while the host may take no turn. */
  queue: StructuredAgentSessionQueuedMessagesController
  /** Sends now, restarts a failed start with the message, or refuses while the chat starts. */
  sendThroughLaunch: (
    text: string,
    withImages: boolean,
    send: () => boolean | 'queued'
  ) => boolean | 'queued'
  starting: boolean
  transportEnabled: boolean
  /** Present while this chat's host may not take a turn; a send is refused with its notice. */
  sendBlockedReason: string | null
  /** Present while the chat's program must be installed first; the composer is disabled. */
  unavailableHint: string | undefined
  /** Whether Stop is offered and what it does; absent while nothing can be stopped. */
  working: boolean
  onStop: (() => void) | undefined
  notices: readonly NativeChatComposerNotice[]
  onError: (message: string | null, detail?: NativeChatComposerErrorDetail) => void
}

/**
 * The chat's composer wired to its session: sends and queue from the controller, the `/` list from
 * what the session reports, plan mode where the agent declares it, and the notices a refused send
 * or a held host leaves above the card.
 */
export const ChatSessionComposer = forwardRef<ComposerHandle, ChatSessionComposerProps>(
  function ChatSessionComposer(props, ref) {
    const {
      controller,
      sessionId,
      agent,
      target,
      tabId,
      paneKey,
      worktreeId,
      queue,
      sendThroughLaunch,
      starting,
      transportEnabled,
      sendBlockedReason,
      unavailableHint,
      working,
      onStop,
      notices,
      onError
    } = props
    const hostAgent = useHostStructuredAgent(target, agent)
    const acceptsImages = useStructuredAgentAcceptsImages(target, agent, controller.acceptsImages)
    const planModeAvailable = hostAgent?.capabilities.planMode === true
    const runtimeEnvironmentId = target.kind === 'local' ? null : (target.environmentId ?? null)

    const commands = useMemo(
      () =>
        composerCommandsFor({
          conversationCommands: controller.conversationCommands,
          sessionCommands: controller.sessionCommands
        }),
      [controller.conversationCommands, controller.sessionCommands]
    )
    const settings = useMemo(
      () => ({ surface: controller.optionSurface, setOption: controller.setStructuredOption }),
      [controller.optionSurface, controller.setStructuredOption]
    )
    const queueMove = useMemo<ComposerQueueMove>(
      () => ({ target, sessionId, fence: controller.fence }),
      [controller.fence, sessionId, target]
    )
    const workspace = useMemo<ComposerWorkspace>(
      () => ({
        paneKey,
        terminalTabId: tabId,
        agent,
        ...(worktreeId === undefined ? {} : { worktreeId }),
        targetPtyId: null,
        structuredSession: {
          sessionId,
          runtimeEnvironmentId,
          ...(transportEnabled
            ? {}
            : {
                sessionPending: true,
                sessionPendingNotice: sessionAttachmentNotReadyNotice(agent, starting)
              })
        }
      }),
      [
        agent,
        paneKey,
        runtimeEnvironmentId,
        sessionId,
        starting,
        tabId,
        transportEnabled,
        worktreeId
      ]
    )

    const onSubmit: ComposerSubmit = (text, attachments, options) => {
      if (sendBlockedReason !== null) {
        onError(sendBlockedReason)
        return false
      }
      onError(null)
      const steer = options?.intent === 'steer'
      return sendThroughLaunch(text, attachments.length > 0, () => {
        const sent = controller.send(text, attachments)
        if (steer && sent === 'queued') {
          controller.queuedMessages.steerNewest()
        }
        return sent
      })
    }
    const onRunCommand = (command: ComposerCommand): void => {
      if (!isAgentSessionConversationCommand(command.name)) {
        return
      }
      void controller.runConversationCommand(command.name).then((outcome) => {
        onError(
          outcome.error,
          outcome.refusedWhile === undefined ? undefined : { refusedWhile: outcome.refusedWhile }
        )
      })
    }

    return (
      <>
        <NativeChatPromptSlotNotices notices={notices} />
        <Composer
          ref={ref}
          mode="chat"
          onSubmit={onSubmit}
          queue={queue}
          settings={settings}
          draftScopeKey={structuredAgentSessionDraftScopeKey(sessionId)}
          disabled={unavailableHint !== undefined}
          acceptsImages={acceptsImages}
          commands={commands}
          onRunCommand={onRunCommand}
          planModeAvailable={planModeAvailable}
          working={working}
          canStop={controller.canStop}
          {...(onStop ? { onStop } : {})}
          queueMove={queueMove}
          workspace={workspace}
          agentLabel={structuredAgentLabel(agent)}
        />
      </>
    )
  }
)
