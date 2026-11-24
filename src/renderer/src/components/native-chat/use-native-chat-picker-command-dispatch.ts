import { useCallback, type Dispatch, type SetStateAction } from 'react'
import type { AgentType } from '../../../../shared/agent-status-types'
import { sendNativeChatMessage, sendNativeChatTypedCommand } from './native-chat-runtime-send'
import type { NativeChatResolvedTarget } from './native-chat-composer-target'
import { pushHistory, type HistoryState } from './fork-agent-composer/agent-composer-history'
import type { NativeChatPickerItem } from './native-chat-composer-state'
import type { NativeChatSendLifecycle } from './use-native-chat-send-lifecycle'
import type { NativeChatPtySessionOptionsSurface } from './native-chat-pty-session-options'
import type { SendOutcome } from './fork-agent-composer/native-chat-send-outcome'
import { buildComposerSendOptions } from './fork-agent-composer/composer-send-options'
import { createComposerPayloadRestore } from './fork-agent-composer/use-agent-composer-send'
import type { ComposerSendTier } from './fork-agent-composer/composer-send-tier'
import type { AgentComposerImageAttachment } from './fork-agent-composer/AgentComposerField'
import {
  answerNativeChatCommandInComposer,
  type NativeChatLocalCommandAnswer
} from './use-native-chat-local-command-answer'

const NO_ATTACHMENTS: readonly AgentComposerImageAttachment[] = []

export function useNativeChatPickerCommandDispatch(args: {
  agent: AgentType
  disabled: boolean
  isDispatchingSessionOption: boolean
  /** Restores an unsent command into this pane's draft; absent, nothing is restored. */
  paneKey?: string
  sendTier?: ComposerSendTier
  onSendOutcome?: (outcome: SendOutcome) => void
  readTerminalScreen?: () => string | null
  resolveTarget: () => NativeChatResolvedTarget | null
  onSlashCommand?: (command: string, output?: string) => void
  answerCommandLocally?: NativeChatLocalCommandAnswer
  onSubmitted?: () => void
  sessionOptionsSurface: NativeChatPtySessionOptionsSurface | null
  trackPendingSend: NativeChatSendLifecycle['trackPendingSend']
  setHistory?: Dispatch<SetStateAction<HistoryState>>
  setDraft: (value: string) => void
  setCaret: Dispatch<SetStateAction<number>>
  setActiveSuggestion: Dispatch<SetStateAction<number>>
  imageAttachments?: readonly AgentComposerImageAttachment[]
  clearSkillOrigin: () => void
  clearImageAttachments: () => void
  restoreImageAttachments?: (attachments: readonly AgentComposerImageAttachment[]) => void
  setNotice: (notice: string | null) => void
}): (command: Extract<NativeChatPickerItem, { kind: 'command' }>) => void {
  const {
    agent,
    disabled,
    isDispatchingSessionOption,
    paneKey,
    sendTier,
    onSendOutcome,
    readTerminalScreen,
    resolveTarget,
    onSlashCommand,
    answerCommandLocally,
    onSubmitted,
    sessionOptionsSurface,
    trackPendingSend,
    setHistory,
    setDraft,
    setCaret,
    setActiveSuggestion,
    imageAttachments = NO_ATTACHMENTS,
    clearSkillOrigin,
    clearImageAttachments,
    restoreImageAttachments,
    setNotice
  } = args
  return useCallback(
    (command) => {
      const text = `/${command.name}`
      const target = resolveTarget()
      if (!target || disabled || isDispatchingSessionOption) {
        return
      }
      if (
        answerNativeChatCommandInComposer({
          draft: text,
          answerCommandLocally,
          sessionOptionsSurface,
          onSlashCommand,
          onSubmitted,
          setDraft,
          setCaret,
          clearSkillOrigin,
          setNotice
        })
      ) {
        setActiveSuggestion(0)
        return
      }
      const restorePayload =
        paneKey === undefined
          ? undefined
          : createComposerPayloadRestore({
              paneKey,
              text,
              imageAttachments,
              setDraft,
              setCaret,
              setNotice,
              restoreImageAttachments
            })
      // Same tiered send-options pipeline as a normal chat send, so a picker
      // command reports exactly once and restores on `may-not-have-sent`.
      const sendOptions = buildComposerSendOptions({
        text,
        tier: sendTier ?? 'input',
        readTerminalScreen,
        onOutcome: (outcome) => {
          if (outcome === 'may-not-have-sent') {
            restorePayload?.()
          }
          onSendOutcome?.(outcome)
        }
      })
      trackPendingSend(
        agent === 'codex'
          ? sendNativeChatTypedCommand(target, text)
          : sendNativeChatMessage(target, text, sendOptions)
      )
      onSlashCommand?.(text)
      sessionOptionsSurface?.recordOutgoingCommand(text)
      onSubmitted?.()
      setHistory?.((previous) => pushHistory(previous, text))
      setDraft('')
      setCaret(0)
      setActiveSuggestion(0)
      clearSkillOrigin()
      clearImageAttachments()
      setNotice(null)
    },
    [
      agent,
      answerCommandLocally,
      clearImageAttachments,
      clearSkillOrigin,
      disabled,
      imageAttachments,
      isDispatchingSessionOption,
      onSendOutcome,
      onSlashCommand,
      onSubmitted,
      paneKey,
      readTerminalScreen,
      resolveTarget,
      restoreImageAttachments,
      sendTier,
      sessionOptionsSurface,
      setActiveSuggestion,
      setCaret,
      setDraft,
      setHistory,
      setNotice,
      trackPendingSend
    ]
  )
}
