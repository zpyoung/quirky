import { useCallback, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import { useStructuredAgentSessionHostCapability } from '@/runtime/structured-agent-session-host-capability'
import { structuredAgentLabel } from '@/lib/structured-agent-session-launch-label'
import { AGENT_SESSION_V1_CHAT_METHODS_RUNTIME_CAPABILITY } from '../../../../shared/agent-session-runtime-capabilities'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { StructuredPromptItem } from '../native-chat/use-structured-agent-session'
import type { useStructuredAgentSession } from '../native-chat/use-structured-agent-session'
import { ChatHeader, type ChatHeaderStatus } from './header/ChatHeader'
import { projectChatTurns } from './chat-turns'
import { ChatTurnEnvContext, type ChatTurnEnv } from './turn/chat-turn-env'
import { ChatTurnList } from './turn/ChatTurnList'
import { useChatMarkdownWiring } from './turn/use-chat-markdown-wiring'
import './chat-view.css'

export type ChatViewController = ReturnType<typeof useStructuredAgentSession>

const NEAR_BOTTOM_PX = 64

export type ChatViewProps = {
  controller: ChatViewController
  sessionId: string
  agent: AgentType
  target: RuntimeClientTarget
  composer?: ReactNode
  planPanel?: ReactNode
  visualPanel?: ReactNode
  dock?: ReactNode
  backgroundTasks?: ReactNode
  findBar?: ReactNode
  onOpenPlan?(version: number): void
  onOpenVisual?(viewId: string): void
  onForked?(sessionId: string): void
  /** The agent-session tab showing this chat. It names the workspace links and files resolve in
   *  and the tab whose title Rename edits; without it both are off and the title is read-only. */
  tabId?: string
}

function useTabTitle(tabId: string | undefined): string | undefined {
  return useAppStore((state) => {
    if (tabId === undefined) {
      return undefined
    }
    for (const tabs of Object.values(state.unifiedTabsByWorktree)) {
      const tab = tabs.find((entry) => entry.id === tabId && entry.contentType === 'agent-session')
      if (tab) {
        return tab.customLabel?.trim() || tab.generatedLabel?.trim() || tab.label
      }
    }
    return undefined
  })
}

/**
 * The structured chat: header, the turns, and slots for the panels, dock, background tasks, find
 * bar and composer, which the mount supplies. It draws what `controller` holds and sends nothing
 * itself beyond answers to asks and the comments a Changes card hands back.
 */
export function ChatView({
  controller,
  sessionId,
  agent,
  target,
  composer,
  planPanel,
  visualPanel,
  dock,
  backgroundTasks,
  findBar,
  onOpenPlan,
  onOpenVisual,
  onForked,
  tabId
}: ChatViewProps): React.JSX.Element {
  const { journalItems, prompts, send, respond, cancel, turnId, rewind, subagentRoster } =
    controller
  const turns = useMemo(
    () => projectChatTurns(journalItems, { sessionAgent: agent }),
    [journalItems, agent]
  )
  const hostServesV1ChatMethods = useStructuredAgentSessionHostCapability(
    target,
    AGENT_SESSION_V1_CHAT_METHODS_RUNTIME_CAPABILITY
  )
  const markdown = useChatMarkdownWiring(tabId)
  const setTabCustomTitle = useAppStore((state) => state.setTabCustomTitle)
  const tabTitle = useTabTitle(tabId)

  const answerableAskIds = useMemo(() => new Set(prompts.map((prompt) => prompt.itemId)), [prompts])
  const env = useMemo<ChatTurnEnv>(
    () => ({
      sessionId,
      target,
      roster: subagentRoster,
      rewind: rewind.surface,
      answerableAskIds,
      respond,
      cancelAsk: (item: StructuredPromptItem) => {
        void cancel(turnId ?? undefined, { itemId: item.itemId, expectedRevision: item.revision })
      },
      markdown,
      onOpenPlan,
      onOpenVisual,
      onSendComments: (text) => send(text) !== false,
      hostServesV1ChatMethods
    }),
    [
      answerableAskIds,
      cancel,
      hostServesV1ChatMethods,
      markdown,
      onOpenPlan,
      onOpenVisual,
      respond,
      rewind.surface,
      send,
      sessionId,
      subagentRoster,
      target,
      turnId
    ]
  )

  const agentsRunning = useMemo(() => {
    let running = 0
    for (const { entry } of subagentRoster.values()) {
      running += entry.state === 'working' ? 1 : 0
    }
    return running
  }, [subagentRoster])
  const status: ChatHeaderStatus = controller.isWorking
    ? { kind: 'working', startedAt: controller.workingStartedAt ?? null }
    : prompts.length > 0
      ? { kind: 'waiting' }
      : turns.some((turn) => turn.user !== null)
        ? { kind: 'done', agentsRunning }
        : { kind: 'ready', agentsRunning }

  const scroller = useRef<HTMLDivElement | null>(null)
  const stuckToBottom = useRef(true)
  const heightBelowTop = useRef<number | null>(null)
  const onScroll = useCallback(() => {
    const element = scroller.current
    if (element) {
      stuckToBottom.current =
        element.scrollHeight - element.scrollTop - element.clientHeight < NEAR_BOTTOM_PX
    }
  }, [])
  useLayoutEffect(() => {
    const element = scroller.current
    if (element && stuckToBottom.current) {
      element.scrollTop = element.scrollHeight
    }
  }, [journalItems])
  useLayoutEffect(() => {
    const element = scroller.current
    if (element && heightBelowTop.current !== null) {
      element.scrollTop = element.scrollHeight - heightBelowTop.current
      heightBelowTop.current = null
    }
  }, [controller.olderHistoryGeneration])
  const loadOlder = (): void => {
    const element = scroller.current
    if (element) {
      heightBelowTop.current = element.scrollHeight - element.scrollTop
    }
    void controller.loadOlder()
  }

  return (
    <ChatTurnEnvContext.Provider value={env}>
      <div
        data-chat-view=""
        className="flex h-full min-h-0 min-w-0 flex-col bg-chat-canvas text-chat-foreground"
      >
        <ChatHeader
          title={tabTitle ?? structuredAgentLabel(agent)}
          agentLabel={structuredAgentLabel(agent)}
          status={status}
          contextUsage={controller.contextUsage}
          journalItems={journalItems}
          sessionAgent={agent}
          target={target}
          sessionId={sessionId}
          forkAvailable={hostServesV1ChatMethods}
          onRename={
            tabId !== undefined && tabTitle !== undefined
              ? (title) => setTabCustomTitle(tabId, title)
              : undefined
          }
          onForked={onForked}
        />
        <div className="flex min-h-0 flex-1">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="relative min-h-0 flex-1">
              {findBar && <div className="absolute top-2 right-3 z-10">{findBar}</div>}
              <div
                ref={scroller}
                onScroll={onScroll}
                className="chat-view-list h-full overflow-y-auto scrollbar-sleek"
              >
                <div className="mx-auto flex w-full max-w-(--chat-content-max-width) flex-col gap-4 px-3 py-4 sm:px-4">
                  {controller.hasOlder && (
                    <div className="flex justify-center">
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        disabled={controller.loadingOlder}
                        onClick={loadOlder}
                      >
                        {controller.loadingOlder ? 'Loading older messages' : 'Load older messages'}
                      </Button>
                    </div>
                  )}
                  {controller.status === 'error' && (
                    <p role="alert" className="text-sm text-destructive">
                      Could not load this chat.
                    </p>
                  )}
                  <ChatTurnList turns={turns} />
                </div>
              </div>
            </div>
            {backgroundTasks}
            {dock}
            {composer}
          </div>
          {planPanel}
          {visualPanel}
        </div>
      </div>
    </ChatTurnEnvContext.Provider>
  )
}
