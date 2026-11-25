import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { structuredAgentSessionPaneKey } from '../../../../../shared/structured-agent-session-projection'
import { pendingPromptsAllUnanswerableHere } from '../../../../../shared/agent-session-approval-subject'
import { dispatchWasWithdrawn } from '../../../../../shared/structured-agent-session-dispatch-rejection'
import type { AgentType } from '../../../../../shared/agent-status-types'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import { isTuiAgent } from '../../../../../shared/tui-agent-config'
import { useAppStore } from '@/store'
import { structuredAgentLabel } from '@/lib/structured-agent-session-launch-label'
import { openStructuredAgentSessionProvisionalTab } from '@/lib/structured-agent-session-launch-surface'
import { executionHostIdForStructuredTarget } from '@/runtime/structured-agent-session-owner'
import { structuredAgentSessionDraftScopeKey } from '@/components/native-chat/native-chat-composer-draft-store'
import {
  NativeChatInstallSlot,
  useNativeChatInstallSlot
} from '@/components/native-chat/NativeChatInstallSlot'
import { useNativeChatImageRuntimeContext } from '@/components/native-chat/native-chat-image-runtime-context'
import { structuredSessionNotices } from '@/components/native-chat/native-chat-structured-session-notices'
import { nativeChatStructuredStopControls } from '@/components/native-chat/native-chat-structured-stop-controls'
import { structuredAgentSessionReadFailureNotice } from '@/components/native-chat/structured-agent-session-read-failure-notice'
import { useStructuredAgentSessionHostExecution } from '@/components/native-chat/StructuredAgentSessionStatusBridge'
import {
  isClaudeSignInFailureKind,
  useNativeChatClaudeSignIn
} from '@/components/native-chat/native-chat-claude-sign-in'
import type { StructuredAgentSessionQueuedMessagesController } from '@/components/native-chat/use-structured-agent-session-queued-messages'
import { useNativeChatAvailabilityNotice } from '@/components/native-chat/use-native-chat-availability-notice'
import { useNativeChatComposerError } from '@/components/native-chat/use-native-chat-composer-notice'
import {
  useNativeChatComposerRevealFocus,
  type NativeChatComposerFocusHandle
} from '@/components/native-chat/use-native-chat-composer-reveal-focus'
import { useNativeChatHostOutage } from '@/components/native-chat/use-native-chat-host-outage'
import { useNativeChatHostOutageNotice } from '@/components/native-chat/use-native-chat-host-outage-notice'
import { useNativeChatHostPermissionGate } from '@/components/native-chat/use-native-chat-host-permission-gate'
import { useNativeChatProvisionalLaunch } from '@/components/native-chat/use-native-chat-provisional-launch'
import { useNativeChatRewindHost } from '@/components/native-chat/use-native-chat-rewind-host'
import { useNativeChatTabOwnerWorktreeId } from '@/components/native-chat/use-native-chat-tab-owner'
import { useStructuredAgentSession } from '@/components/native-chat/use-structured-agent-session'
import { useStructuredAgentSessionDeliveryNotices } from '@/components/native-chat/use-structured-agent-session-delivery-notices'
import { useStructuredAgentSessionStartFailureFacts } from '@/components/native-chat/use-structured-agent-session-start-failure-facts'
import { ChatView } from '../ChatView'
import { AgentDock } from '../panels/AgentDock'
import { PlanPanel } from '../panels/PlanPanel'
import { VisualPanel } from '../panels/VisualPanel'
import { useChatMarkdownWiring } from '../turn/use-chat-markdown-wiring'
import type { ComposerHandle } from '../composer/composer-types'
import { BackgroundTasksPanel } from './BackgroundTasksPanel'
import { ChatFindBar } from './ChatFindBar'
import { chatFindGeometry, chatFindScrollDelta } from './chat-find-visibility'
import { ChatSessionComposer } from './ChatSessionComposer'
import { useChatFind } from './use-chat-find'
import { useChatSplitShortcut } from './use-chat-split-shortcut'
import { workspaceImageReaderFor } from './workspace-image-reading'

export type ChatSessionProps = {
  tabId: string
  groupId?: string
  sessionId: string
  target: RuntimeClientTarget
  agent: AgentType
  isVisible: boolean
  /** This pane's split group holds focus; a revealed sibling column must not take the caret. */
  isFocusedGroup: boolean
}

type OpenPanel = { kind: 'plan'; version: number } | { kind: 'visual'; viewId: string }

const TRANSCRIPT_SCROLL_SELECTOR = '[data-native-chat-scroll]'

/**
 * A structured chat tab: builds the session controller the way the app always has and hands it to
 * `ChatView` with the composer, panels, dock, background tasks and find supplied.
 */
export function ChatSession(props: ChatSessionProps): React.JSX.Element {
  const { tabId, groupId, sessionId, target, agent, isVisible, isFocusedGroup } = props
  const ownerWorktreeId = useNativeChatTabOwnerWorktreeId(tabId)
  const provisionalLaunch = useNativeChatProvisionalLaunch(ownerWorktreeId, sessionId)
  const hostExecution = useStructuredAgentSessionHostExecution(sessionId, target)
  const paneKey = useMemo(() => structuredAgentSessionPaneKey(tabId, sessionId), [sessionId, tabId])
  const queueFollowUps = useAppStore((store) => store.settings?.nativeChatQueueFollowUps !== false)
  const rootRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<ComposerHandle>(null)
  const composerFocus = useRef<NativeChatComposerFocusHandle>({
    focus: () => {
      const composer = composerRef.current
      composer?.focus()
      return composer !== null
    },
    contains: (node) =>
      node !== null &&
      (rootRef.current?.querySelector('[data-composer-mode]')?.contains(node) ?? false)
  })
  const { rewindHost } = useNativeChatRewindHost({ sessionId, target, isVisible }, composerFocus)
  const controller = useStructuredAgentSession({
    sessionId,
    target,
    agent,
    isVisible,
    composerScopeKey: structuredAgentSessionDraftScopeKey(sessionId),
    queueFollowUps,
    hostStopping: hostExecution.stopping,
    hostOptionStamp: hostExecution.optionStamp,
    providerStarting: hostExecution.phase === 'starting',
    providerRunning: hostExecution.phase === 'ready',
    rewind: rewindHost,
    transportEnabled: provisionalLaunch.transportEnabled,
    ...(provisionalLaunch.launch ? { launch: provisionalLaunch.launch } : {})
  })
  const refreshCommands = useRef(controller.refreshCommands)
  refreshCommands.current = controller.refreshCommands
  useEffect(() => {
    if (isVisible && provisionalLaunch.transportEnabled) {
      refreshCommands.current()
    }
  }, [isVisible, provisionalLaunch.transportEnabled])

  const agentLabel = structuredAgentLabel(agent)
  const stopControls = nativeChatStructuredStopControls(controller, hostExecution.stopping)
  const { composerError, reportComposerError } = useNativeChatComposerError(
    controller.commandRefusalCauses
  )
  const hostOutage = useNativeChatHostOutage(target)
  const hostNotice = useNativeChatHostOutageNotice(hostOutage)
  const hostPermission = useNativeChatHostPermissionGate(target, agent, agentLabel)
  const hostHeld = hostPermission.sendBlockedReason !== null
  const install = useNativeChatInstallSlot({ target, agent, isVisible }, agentLabel, 'strip')

  const queue = useMemo<StructuredAgentSessionQueuedMessagesController>(
    () =>
      hostHeld
        ? {
            ...controller.queuedMessages,
            steer: async () => undefined,
            resume: async () => false,
            steerNewest: () => false
          }
        : controller.queuedMessages,
    [controller.queuedMessages, hostHeld]
  )

  const needsFailureFacts =
    controller.queuedMessages.cards.some((card) => card.state === 'returned') ||
    controller.submissions.some(
      (submission) => submission.dispatchState === 'rejected' && !dispatchWasWithdrawn(submission)
    )
  const startFailures = useStructuredAgentSessionStartFailureFacts(
    controller.journalItems,
    needsFailureFacts || agent === 'claude'
  )
  const deliveryNotices = useStructuredAgentSessionDeliveryNotices({
    pending: controller.pending,
    submissions: controller.submissions,
    journalItems: controller.journalItems,
    startFailures,
    agentName: agentLabel
  })
  const readFailure =
    controller.status === 'error' && !(hostOutage && !controller.readRefusal)
      ? structuredAgentSessionReadFailureNotice(controller.readRefusal)
      : null
  const readFailedFinally = readFailure?.final === true
  const availability = useNativeChatAvailabilityNotice({
    unavailable: controller.unavailable,
    agent,
    agentLabel,
    launchFailure: provisionalLaunch.lifecycle === 'failed' ? provisionalLaunch.failure : null,
    journalItems: controller.journalItems,
    submissions: controller.submissions,
    deliveryNotices
  })
  const claudeSignIn = useNativeChatClaudeSignIn({
    agent,
    target,
    failure: provisionalLaunch.failure,
    failureRows: startFailures.filter((fact) => isClaudeSignInFailureKind(fact.kind)).length
  })
  const launch = { ...provisionalLaunch, retry: provisionalLaunch.retry }
  const notices = structuredSessionNotices({
    launch: install.slot.kind === 'install' ? { ...launch, lifecycle: null } : launch,
    agentLabel,
    sessionError: readFailure ? readFailure.text : controller.error,
    composerError,
    claudeSignIn,
    availability,
    hostPermission: hostPermission.notice
  })
  if (hostNotice) {
    notices.push(hostNotice)
  }

  const promptsUnanswerable = pendingPromptsAllUnanswerableHere(controller.prompts)
  const composerReady =
    (controller.prompts.length === 0 || promptsUnanswerable) && !readFailedFinally
  useNativeChatComposerRevealFocus({
    tabId,
    rootRef,
    composerRef: composerFocus,
    isVisible,
    isFocusedGroup,
    composerReady: composerReady && install.slot.kind !== 'install'
  })

  const revealFindMatch = useCallback((match: Range, bar: DOMRectReadOnly | null) => {
    const scroller = rootRef.current?.querySelector<HTMLElement>(TRANSCRIPT_SCROLL_SELECTOR)
    if (!scroller) {
      return
    }
    const geometry = chatFindGeometry(scroller)
    geometry.scrollIntoBoxes(match)
    if (geometry.inView(match, bar)) {
      return
    }
    const delta = chatFindScrollDelta(
      match.getBoundingClientRect(),
      scroller.getBoundingClientRect(),
      bar
    )
    const maxScrollTop = scroller.scrollHeight - scroller.clientHeight
    scroller.scrollTop = Math.min(Math.max(scroller.scrollTop + delta, 0), maxScrollTop)
  }, [])
  const find = useChatFind(isVisible && isFocusedGroup, rootRef, composerFocus, revealFindMatch)
  const onSplitKeyDown = useChatSplitShortcut(tabId, groupId)

  const [panel, setPanel] = useState<OpenPanel | null>(null)
  const closePanel = useCallback(() => setPanel(null), [])
  const onOpenPlan = useCallback((version: number) => setPanel({ kind: 'plan', version }), [])
  const onOpenVisual = useCallback((viewId: string) => setPanel({ kind: 'visual', viewId }), [])
  const journalItems = useMemo(() => [...controller.journalItems], [controller.journalItems])
  const markdown = useChatMarkdownWiring(tabId)
  const imageRuntimeContext = useNativeChatImageRuntimeContext(tabId)
  const readWorkspaceImage = useMemo(
    () => workspaceImageReaderFor(imageRuntimeContext),
    [imageRuntimeContext]
  )
  const send = controller.send
  const { sendThroughLaunch } = provisionalLaunch
  const sendPlanFeedback = useCallback(
    async (text: string) => sendThroughLaunch(text, false, () => send(text)),
    [send, sendThroughLaunch]
  )

  const onForked = useCallback(
    (forkedSessionId: string) => {
      if (ownerWorktreeId === null || !isTuiAgent(agent)) {
        return
      }
      openStructuredAgentSessionProvisionalTab({
        worktreeId: ownerWorktreeId,
        executionHostId: executionHostIdForStructuredTarget(target),
        sessionId: forkedSessionId,
        agent,
        afterTabId: tabId
      })
    },
    [agent, ownerWorktreeId, tabId, target]
  )

  const planPanel =
    panel?.kind === 'plan' ? (
      <PlanPanel
        items={journalItems}
        prompts={controller.prompts}
        respond={controller.respond}
        openVersion={panel.version}
        onClose={closePanel}
        onSendMessage={sendPlanFeedback}
        onOpenLink={markdown.onOpenLink}
      />
    ) : undefined
  const visualPanel =
    panel?.kind === 'visual' ? (
      <VisualPanel
        items={journalItems}
        sessionId={sessionId}
        target={target}
        workspaceRoot={imageRuntimeContext?.worktreePath ?? null}
        openViewId={panel.viewId}
        onClose={closePanel}
        worktreeId={ownerWorktreeId}
        onOpenLink={markdown.onOpenLink}
        {...(readWorkspaceImage ? { readWorkspaceImage } : {})}
      />
    ) : undefined

  return (
    <div
      ref={rootRef}
      data-native-chat-root="true"
      data-native-chat-working={controller.isWorking ? 'true' : 'false'}
      tabIndex={-1}
      onKeyDownCapture={(event) => {
        find.onKeyDownCapture(event)
        onSplitKeyDown(event)
      }}
      className="flex h-full min-h-0 w-full flex-col focus:outline-none"
    >
      <ChatView
        controller={controller}
        sessionId={sessionId}
        agent={agent}
        target={target}
        tabId={tabId}
        onOpenPlan={onOpenPlan}
        onOpenVisual={onOpenVisual}
        onForked={onForked}
        planPanel={planPanel}
        visualPanel={visualPanel}
        dock={<AgentDock roster={controller.subagentRoster} />}
        backgroundTasks={
          <BackgroundTasksPanel
            sessionId={sessionId}
            paneKey={paneKey}
            isVisible={isVisible}
            backgroundTasks={controller.backgroundTasks}
            stopBackgroundTask={controller.stopBackgroundTask}
          />
        }
        findBar={find.isOpen ? <ChatFindBar find={find} isVisible={isVisible} /> : undefined}
        composer={
          readFailedFinally ? undefined : (
            <>
              {composerReady ? (
                <NativeChatInstallSlot slot={install.slot} agentLabel={agentLabel} />
              ) : null}
              <ChatSessionComposer
                ref={composerRef}
                controller={controller}
                sessionId={sessionId}
                agent={agent}
                target={target}
                tabId={tabId}
                paneKey={paneKey}
                worktreeId={ownerWorktreeId ?? undefined}
                queue={queue}
                sendThroughLaunch={provisionalLaunch.sendThroughLaunch}
                starting={provisionalLaunch.starting}
                transportEnabled={provisionalLaunch.transportEnabled}
                sendBlockedReason={hostPermission.sendBlockedReason ?? install.sendBlockedReason}
                unavailableHint={install.unavailableHint}
                working={stopControls.composer.isWorking}
                onStop={stopControls.composer.onStop}
                notices={notices}
                onError={reportComposerError}
              />
            </>
          )
        }
      />
    </div>
  )
}
