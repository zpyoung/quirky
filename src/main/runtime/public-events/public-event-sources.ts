import type { IpcMainEvent } from 'electron'
import { z } from 'zod'
import type { StructuredAgentSessionProjectedStatus } from '../../../shared/structured-agent-session-projection'
import type { StructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-host'
import {
  getStructuredAgentSessionHost,
  onStructuredAgentSessionsHeldChanged
} from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { QuirkyRuntimeService } from '../quirky-runtime'
import { getRuntimeDesktopSurface } from '../runtime-desktop-surface'
import type { RuntimeStore } from '../runtime-store-contract'
import type { PublicEventBus, PublicEventInput } from './public-event-bus'

export const UI_FOCUS_CHANGED_CHANNEL = 'ui:focusChanged'

const STATUS_SUBSCRIBER_ID = 'public-events-status'
const COMPLETION_SUBSCRIBER_ID = 'public-events-completions'

const FocusChangedPayload = z.object({
  worktreeId: z.string().optional(),
  tabId: z.string().optional(),
  tabType: z.string().optional(),
  view: z.string().optional()
})

type AgentSessionHostTaps = Pick<
  StructuredAgentSessionHost,
  'subscribeStatus' | 'subscribeTurnCompletions'
>

type PublicEventSourceDeps = {
  bus: PublicEventBus
  runtime: Pick<
    QuirkyRuntimeService,
    'onClientEvent' | 'onWorktreeLifecycle' | 'onNotificationDispatched'
  >
  store: Pick<RuntimeStore, 'onSettingsChanged'> | null
  /** The window whose renderer reports focus; other senders are ignored. */
  getWindow: () => { webContents: unknown } | null
}

/**
 * Turns each runtime signal an agent might wait on into a public event. A chat's status edges
 * become turn.started and turn.needs-input; its turn completions become turn.finished or
 * turn.failed. Returns a function that detaches every tap.
 */
function tapAgentSessionHost(host: AgentSessionHostTaps, bus: PublicEventBus): () => void {
  const statuses = new Map<string, StructuredAgentSessionProjectedStatus | null>()
  const needsInputPublished = new Set<string>()
  const publish = (input: PublicEventInput): void => bus.publish(input)

  const stopStatus = host.subscribeStatus({
    id: STATUS_SUBSCRIBER_ID,
    emit: (event) => {
      if (event.type === 'snapshot') {
        for (const session of event.sessions) {
          statuses.set(session.sessionId, session.status)
        }
        return
      }
      if (event.type === 'end') {
        return
      }
      const { sessionId, workspaceId, status } = event.session
      const previous = statuses.get(sessionId)
      statuses.set(sessionId, status)
      if (status === previous) {
        return
      }
      if (status !== 'attention') {
        needsInputPublished.delete(sessionId)
      }
      if (status === 'working') {
        publish({
          topic: 'chat',
          type: 'turn.started',
          data: { sessionId, worktreeId: workspaceId }
        })
      }
      if (status === 'attention') {
        // the prompt edge lands in the same tick with its request id; only publish bare when it does not
        queueMicrotask(() => {
          if (statuses.get(sessionId) !== 'attention' || needsInputPublished.has(sessionId)) {
            return
          }
          needsInputPublished.add(sessionId)
          publish({
            topic: 'chat',
            type: 'turn.needs-input',
            data: { sessionId, worktreeId: workspaceId }
          })
        })
      }
    }
  })

  const stopCompletions = host.subscribeTurnCompletions({
    id: COMPLETION_SUBSCRIBER_ID,
    includePrompts: true,
    emit: (event) => {
      if (event.type === 'completion') {
        const { sessionId, turnId, outcome, scope } = event.completion
        publish({
          topic: 'chat',
          type: outcome === 'failure' ? 'turn.failed' : 'turn.finished',
          data: { sessionId, turnId, outcome, worktreeId: scope.workspaceId }
        })
      } else if (event.type === 'prompt') {
        const { sessionId, promptId, scope } = event.prompt
        needsInputPublished.add(sessionId)
        publish({
          topic: 'chat',
          type: 'turn.needs-input',
          data: { sessionId, requestId: promptId, worktreeId: scope.workspaceId }
        })
      }
    }
  })

  return () => {
    stopStatus()
    stopCompletions()
  }
}

/**
 * The structured chat host is built after the runtime and replaced across restarts, so the taps
 * follow whichever host the registry holds when chats start being held.
 */
function followAgentSessionHost(bus: PublicEventBus): () => void {
  let attachedHost: StructuredAgentSessionHost | null = null
  let detach = (): void => {}
  const attach = (): void => {
    const host = getStructuredAgentSessionHost()
    if (host === attachedHost) {
      return
    }
    detach()
    attachedHost = host
    detach = host ? tapAgentSessionHost(host, bus) : () => {}
  }
  attach()
  const stopWatching = onStructuredAgentSessionsHeldChanged(attach)
  return () => {
    stopWatching()
    detach()
  }
}

/** Wires every runtime source into the bus; the returned function detaches them all. */
export function installPublicEventSources({
  bus,
  runtime,
  store,
  getWindow
}: PublicEventSourceDeps): () => void {
  const stops: (() => void)[] = []

  stops.push(
    runtime.onClientEvent(
      (event) => {
        if (event.type === 'workspaceViewChanged') {
          bus.publish({ topic: 'ui', type: 'view.changed', data: { view: 'workspace' } })
        }
      },
      { consumesTerminalSideEffects: false }
    )
  )

  stops.push(
    runtime.onWorktreeLifecycle((event) => {
      bus.publish({
        topic: 'workspace',
        type: event.kind === 'created' ? 'worktree.created' : 'worktree.removed',
        data: { worktreeId: event.worktreeId }
      })
    })
  )

  stops.push(
    runtime.onNotificationDispatched((event) => {
      if (event.type !== 'notification') {
        return
      }
      bus.publish({
        topic: 'notifications',
        type: 'notification.raised',
        data: {
          id:
            event.notificationId ??
            `${event.notificationEpoch ?? ''}:${event.notificationSeq ?? ''}`,
          title: event.title,
          ...(event.worktreeId === undefined ? {} : { worktreeId: event.worktreeId })
        }
      })
    })
  )

  const stopSettings = store?.onSettingsChanged?.((updates) => {
    const keys = Object.keys(updates)
    if (keys.length > 0) {
      bus.publish({ topic: 'workspace', type: 'settings.changed', data: { keys } })
    }
  })
  if (stopSettings) {
    stops.push(stopSettings)
  }

  stops.push(followAgentSessionHost(bus))

  const onFocusChanged = (event: IpcMainEvent, payload: unknown): void => {
    if (event.sender !== getWindow()?.webContents) {
      return
    }
    const parsed = FocusChangedPayload.safeParse(payload)
    if (parsed.success) {
      bus.publish({ topic: 'ui', type: 'focus.changed', data: parsed.data })
    }
  }
  const surface = getRuntimeDesktopSurface()
  surface.onIpc(UI_FOCUS_CHANGED_CHANNEL, onFocusChanged)
  stops.push(() => surface.removeIpcListener(UI_FOCUS_CHANGED_CHANNEL, onFocusChanged))

  return () => {
    for (const stop of stops) {
      stop()
    }
  }
}
