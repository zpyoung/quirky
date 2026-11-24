import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Copy, FileJson, FolderOpen, History, LocateFixed } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { activateTabAndFocusPane } from '@/lib/activate-tab-and-focus-pane'
import { useAppStore } from '@/store'
import type { SessionInfoIdentity } from '../../../../../shared/fork-session-info/session-info-types'
import { openAiVaultSessionLogInQuirky } from '../ai-vault-session-log-open'
import type { FocusedSessionSelection } from './focused-session-info'
import { formatTimestamp } from './session-info-format'
import { requestSessionInfoVaultNavigation } from './session-info-vault-navigation'
import { SessionInfoAsOf, SessionInfoRow } from './SessionInfoRows'

function ActionButton({
  icon: Icon,
  label,
  onClick
}: {
  icon: typeof Copy
  label: string
  onClick: () => void
}): React.JSX.Element {
  return (
    <Button variant="outline" size="xs" className="min-w-0 justify-start" onClick={onClick}>
      <Icon className="size-3" />
      <span className="truncate">{label}</span>
    </Button>
  )
}

export function SessionInfoIdentitySection({
  identity,
  selection
}: {
  identity: SessionInfoIdentity
  selection: FocusedSessionSelection
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const resetTimer = useRef<number | null>(null)
  useEffect(
    () => () => {
      if (resetTimer.current !== null) {
        window.clearTimeout(resetTimer.current)
      }
    },
    []
  )
  const copySessionId = useCallback(() => {
    if (!identity.sessionId) {
      return
    }
    void window.api.ui
      .writeClipboardText(identity.sessionId)
      .then(() => {
        setCopied(true)
        if (resetTimer.current !== null) {
          window.clearTimeout(resetTimer.current)
        }
        resetTimer.current = window.setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => undefined)
  }, [identity.sessionId])
  const openVault = useCallback(() => {
    if (identity.sessionId) {
      requestSessionInfoVaultNavigation({
        sessionId: identity.sessionId,
        agent: identity.agent
      })
    }
    const state = useAppStore.getState()
    state.setRightSidebarOpen(true)
    state.setRightSidebarTab('vault')
  }, [identity.agent, identity.sessionId])
  const focusPane = useCallback(() => {
    if (!selection.tabId || !selection.leafId) {
      return
    }
    useAppStore.getState().setActiveTabType('terminal', identity.worktreeId ?? null)
    activateTabAndFocusPane(selection.tabId, selection.leafId, {
      flashFocusedPane: true,
      scrollToBottomIfOutputSinceLastView: true
    })
  }, [identity.worktreeId, selection.leafId, selection.tabId])
  const localTranscript = selection.isLocalExecution ? identity.transcriptPath : undefined

  return (
    <div>
      <dl>
        {identity.agent ? (
          <SessionInfoRow
            label={translate('fork.sessionInfo.agentLabel', 'Agent')}
            value={identity.agent}
          />
        ) : null}
        {identity.model ? (
          <SessionInfoRow
            label={translate('fork.sessionInfo.model', 'Model')}
            value={identity.model}
          />
        ) : null}
        {identity.sessionId ? (
          <SessionInfoRow
            label={translate('fork.sessionInfo.sessionId', 'Session ID')}
            value={identity.sessionId}
            mono
            title={identity.sessionId}
          />
        ) : null}
        <SessionInfoRow
          label={translate('fork.sessionInfo.pane', 'Pane')}
          value={selection.paneLabel ?? identity.paneKey ?? '—'}
          title={identity.paneKey}
        />
        <SessionInfoRow
          label={translate('fork.sessionInfo.workspace', 'Workspace')}
          value={selection.workspaceLabel ?? identity.worktreeId ?? '—'}
          title={identity.worktreeId}
        />
        {identity.startedAt ? (
          <SessionInfoRow
            label={translate('fork.sessionInfo.started', 'Started')}
            value={formatTimestamp(identity.startedAt)}
          />
        ) : null}
        {identity.cwd ? (
          <SessionInfoRow
            label={translate('fork.sessionInfo.cwd', 'Working directory')}
            value={identity.cwd}
            mono
            title={identity.cwd}
          />
        ) : null}
        {identity.branch ? (
          <SessionInfoRow
            label={translate('fork.sessionInfo.branch', 'Branch')}
            value={identity.branch}
            mono
          />
        ) : null}
        {identity.version ? (
          <SessionInfoRow
            label={translate('fork.sessionInfo.version', 'Version')}
            value={identity.version}
          />
        ) : null}
        {identity.outputStyle ? (
          <SessionInfoRow
            label={translate('fork.sessionInfo.outputStyle', 'Output style')}
            value={identity.outputStyle}
          />
        ) : null}
        {identity.transcriptPath ? (
          <SessionInfoRow
            label={translate('fork.sessionInfo.transcript', 'Transcript')}
            value={identity.transcriptPath}
            mono
            title={identity.transcriptPath}
          />
        ) : null}
      </dl>
      <SessionInfoAsOf updatedAt={identity.updatedAt} />
      <div className="mt-2 grid grid-cols-2 gap-1.5">
        {identity.sessionId ? (
          <ActionButton
            icon={copied ? Check : Copy}
            label={
              copied
                ? translate('fork.sessionInfo.copied', 'Copied')
                : translate('fork.sessionInfo.copySessionId', 'Copy ID')
            }
            onClick={copySessionId}
          />
        ) : null}
        <ActionButton
          icon={History}
          label={translate('fork.sessionInfo.openVault', 'Open Vault')}
          onClick={openVault}
        />
        <ActionButton
          icon={LocateFixed}
          label={translate('fork.sessionInfo.focusPane', 'Focus pane')}
          onClick={focusPane}
        />
        {localTranscript ? (
          <>
            <ActionButton
              icon={FileJson}
              label={translate('fork.sessionInfo.openTranscript', 'Open transcript')}
              onClick={() =>
                void openAiVaultSessionLogInQuirky({
                  filePath: localTranscript,
                  executionHostId: 'local'
                })
              }
            />
            <ActionButton
              icon={FolderOpen}
              label={translate('fork.sessionInfo.revealTranscript', 'Reveal transcript')}
              onClick={() => void window.api.shell.openInFileManager(localTranscript, 'local')}
            />
          </>
        ) : null}
      </div>
    </div>
  )
}
