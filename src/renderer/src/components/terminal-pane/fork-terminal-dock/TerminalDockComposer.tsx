import { useCallback, useMemo, type Ref } from 'react'
import { useAppStore } from '../../../store'
import type { AgentType } from '../../../../../shared/agent-status-types'
import { structuredAgentLabel } from '@/lib/structured-agent-session-launch-label'
import { Composer } from '../../chat/composer/Composer'
import type {
  ComposerHandle,
  ComposerSubmit,
  ComposerWorkspace
} from '../../chat/composer/composer-types'
import type { NativeChatResolvedTarget } from '../../native-chat/native-chat-composer-target'
import { useNativeChatInteractiveSend } from '../../native-chat/use-native-chat-interactive-send'
import { isTerminalInputQuarantined } from '../terminal-input-quarantine'
import { submitToTerminalAgent } from './terminal-dock-submit'
import { useTerminalInputQuarantined } from './use-terminal-input-quarantined'

export type TerminalDockComposerProps = {
  ref: Ref<ComposerHandle>
  terminalTabId: string
  paneKey: string
  targetPtyId: string | null
  agent: AgentType
  /** False greys the composer out: the terminal can't take input right now. */
  canSend: boolean
}

/**
 * The composer under an agent terminal. It types straight into the agent's PTY, with the same
 * editor, attachments and IME handling as the chat, and holds sends while the terminal's input is
 * quarantined after a re-attach.
 */
export function TerminalDockComposer({
  ref,
  terminalTabId,
  paneKey,
  targetPtyId,
  agent,
  canSend
}: TerminalDockComposerProps): React.JSX.Element {
  const working = useAppStore((state) => state.agentStatusByPaneKey[paneKey]?.state === 'working')
  const quarantined = useTerminalInputQuarantined(terminalTabId)
  const interactiveSend = useNativeChatInteractiveSend(terminalTabId, paneKey, targetPtyId, agent)
  const resolveTarget = useCallback((): NativeChatResolvedTarget | null => {
    if (!targetPtyId || isTerminalInputQuarantined(terminalTabId)) {
      return null
    }
    return { terminalTabId, ptyId: targetPtyId }
  }, [targetPtyId, terminalTabId])
  const workspace = useMemo<ComposerWorkspace>(
    () => ({ paneKey, terminalTabId, agent, targetPtyId, resolveTarget }),
    [agent, paneKey, resolveTarget, targetPtyId, terminalTabId]
  )
  const onSubmit: ComposerSubmit = (text, attachments) =>
    submitToTerminalAgent({ agent, target: resolveTarget(), text, attachments })

  return (
    <Composer
      ref={ref}
      mode="terminal"
      onSubmit={onSubmit}
      draftScopeKey={paneKey}
      disabled={!canSend || targetPtyId === null}
      quarantined={quarantined}
      working={working}
      canStop={working}
      onStop={interactiveSend.cancel}
      workspace={workspace}
      agentLabel={structuredAgentLabel(agent)}
    />
  )
}
