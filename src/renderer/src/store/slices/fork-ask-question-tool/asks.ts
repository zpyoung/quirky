import type { StateCreator } from 'zustand'
import type { AppState } from '../../types'
import type {
  AskPartial,
  AskRegistryEvent,
  AskRegistryResult,
  AskSpec
} from '../../../../../shared/fork-ask-question-tool/ask-question-schema'
import {
  isTerminalAskStatus,
  type AskStatus
} from '../../../../../shared/fork-ask-question-tool/ask-answer-envelope'
import type { RuntimeRpcResponse } from '../../../../../shared/runtime-rpc-envelope'
import { unwrapRuntimeRpcResult } from '@/runtime/runtime-rpc-result'

/** Normalized per-ask state the card renders (tech.md § C8). Validation stays in the shared schema module. */
export type AskCardModel = {
  askId: string
  paneKey: string | null
  worktreeId?: string | null
  createdAt?: string
  status: AskStatus
  spec: AskSpec | null
  partial: AskPartial
  result?: AskRegistryResult
}

type AskWatermark = { seq: number; epoch: string }
type AskSnapshotResult = { asks: AskRegistryEvent[]; seq: number; epoch: string }

const HYDRATE_RETRY_BASE_MS = 1000
const HYDRATE_RETRY_MAX_MS = 30_000
/** Bounds memory while hydration keeps failing; the eventual snapshot covers whatever is dropped. */
export const ASK_EVENT_BUFFER_LIMIT = 500

/** How long a terminal card stays visible before its pane's queue auto-advances. */
export const ASK_DISMISS_DELAY_MS = 4000

export type AsksSlice = {
  /** Per-pane FIFO; index 0 is the ask the card renders. A terminal entry occupies index 0 for
   * at most `ASK_DISMISS_DELAY_MS` before `dismissAsk` drops it and the next queued ask surfaces. */
  pendingAsksByPaneKey: Record<string, AskCardModel[]>
  /** Asks whose caller has no terminal pane (brain, scripts, remote); same FIFO and dismiss rules as a pane's queue. */
  globalAsks: AskCardModel[]
  /** Null until `hydrateAsks` resolves once; also the "is hydrated" gate for `applyAskRegistryEvent`. */
  askWatermark: AskWatermark | null
  /** Events received while `askWatermark` is null; replayed in order once hydration resolves. */
  _askEventBuffer: AskRegistryEvent[]
  /** Seeds pending asks, their partials, and the watermark via `ask.snapshot`, then replays
   * anything `applyAskRegistryEvent` buffered while this call was in flight. */
  hydrateAsks: () => Promise<void>
  /** Re-reads the snapshot to recover from any event missed while the window was away. */
  resyncAsks: () => Promise<void>
  /** Pending auto-dismiss timers keyed by askId; slice state so a fresh store starts clean. */
  _dismissTimers: Record<string, ReturnType<typeof setTimeout>>
  /** Applies one live registry event under the hydration-ordering rules in tech.md § C8. */
  applyAskRegistryEvent: (event: AskRegistryEvent) => void
  /** Removes a resolved ask from its pane (or from `globalAsks` when `paneKey` is null) so the
   * next queued one becomes the head. No-op for an unknown pane or askId. */
  dismissAsk: (paneKey: string | null, askId: string) => void
  /** `rightSidebarOpen` as it stood when the ask panel forced the sidebar open, so the panel can
   * put it back. Null while the panel is not holding a restore target. */
  askFocusRestoreOpen: boolean | null
  setAskFocusRestoreOpen: (value: boolean | null) => void
  /** The ask whose card the Questions panel is rendering right now; escalation reads it to tell
   * "on screen" from "in front of the user". */
  askPanelShownAskId: string | null
  setAskPanelShownAskId: (askId: string | null) => void
  /** Bumped when the user asks to open a specific ask, so the panel re-opens even for an ask they
   * dismissed earlier. */
  askPanelRevealNonce: number
  requestAskPanelReveal: () => void
}

type AsksSet = Parameters<StateCreator<AppState, [], [], AsksSlice>>[0]
type AsksGet = Parameters<StateCreator<AppState, [], [], AsksSlice>>[1]

/**
 * Merges a registry event onto the previously known card. A field the event omits keeps its
 * prior value rather than being cleared — events do not repeat fields that have not changed.
 */
function mergeAskCard(previous: AskCardModel | undefined, event: AskRegistryEvent): AskCardModel {
  return {
    askId: event.askId,
    paneKey: event.paneKey,
    worktreeId: event.worktreeId ?? previous?.worktreeId ?? null,
    createdAt: event.createdAt ?? previous?.createdAt,
    status: event.status,
    spec: event.spec ?? previous?.spec ?? null,
    partial: event.partial ?? previous?.partial ?? {},
    result: event.result ?? previous?.result
  }
}

/** Updates a pane's array in place by askId, or inserts by registration time (arrival order without one). */
function upsertCard(bucket: AskCardModel[], event: AskRegistryEvent): AskCardModel[] {
  const index = bucket.findIndex((card) => card.askId === event.askId)
  const card = mergeAskCard(index === -1 ? undefined : bucket[index], event)
  if (index === -1) {
    // a resumed stream can deliver a queued ask before the head, so registration time decides the slot
    const createdAt = card.createdAt
    const later = createdAt
      ? bucket.findIndex((existing) => existing.createdAt && existing.createdAt > createdAt)
      : -1
    return later === -1
      ? [...bucket, card]
      : [...bucket.slice(0, later), card, ...bucket.slice(later)]
  }
  return bucket.map((existing, i) => (i === index ? card : existing))
}

/**
 * Arms the auto-dismiss for a card that just went terminal. The timer lives in the store rather
 * than a component effect: an effect's cleanup fires on unmount, so switching tabs mid-flash would
 * leave the resolved card wedged at the head forever.
 */
function scheduleAskDismiss(
  set: AsksSet,
  get: AsksGet,
  paneKey: string | null,
  askId: string
): void {
  if (askId in get()._dismissTimers) {
    return
  }
  const timer = setTimeout(() => get().dismissAsk(paneKey, askId), ASK_DISMISS_DELAY_MS)
  set({ _dismissTimers: { ...get()._dismissTimers, [askId]: timer } })
}

function clearDismissTimers(timers: Record<string, ReturnType<typeof setTimeout>>): void {
  for (const timer of Object.values(timers)) {
    clearTimeout(timer)
  }
}

export const createAsksSlice: StateCreator<AppState, [], [], AsksSlice> = (set, get) => {
  let hydrateRetryTimer: ReturnType<typeof setTimeout> | null = null
  let hydrateFailures = 0

  return {
    pendingAsksByPaneKey: {},
    globalAsks: [],
    askWatermark: null,
    _askEventBuffer: [],
    _dismissTimers: {},
    askFocusRestoreOpen: null,
    askPanelShownAskId: null,
    setAskPanelShownAskId: (askId) => set({ askPanelShownAskId: askId }),
    askPanelRevealNonce: 0,
    requestAskPanelReveal: () => set({ askPanelRevealNonce: get().askPanelRevealNonce + 1 }),

    setAskFocusRestoreOpen: (value) => set({ askFocusRestoreOpen: value }),

    hydrateAsks: async () => {
      if (hydrateRetryTimer !== null) {
        clearTimeout(hydrateRetryTimer)
        hydrateRetryTimer = null
      }
      let snapshot: AskSnapshotResult
      try {
        const response = await window.api.runtime.call({ method: 'ask.snapshot', params: {} })
        snapshot = unwrapRuntimeRpcResult<AskSnapshotResult>(
          response as RuntimeRpcResponse<AskSnapshotResult>
        )
      } catch (error) {
        console.error('Failed to hydrate pending asks:', error)
        const delay = Math.min(HYDRATE_RETRY_BASE_MS * 2 ** hydrateFailures, HYDRATE_RETRY_MAX_MS)
        hydrateFailures += 1
        hydrateRetryTimer = setTimeout(() => {
          hydrateRetryTimer = null
          void get().hydrateAsks()
        }, delay)
        return
      }
      hydrateFailures = 0

      const seeded: Record<string, AskCardModel[]> = {}
      let seededGlobal: AskCardModel[] = []
      for (const event of snapshot.asks) {
        if (event.paneKey === null) {
          seededGlobal = upsertCard(seededGlobal, event)
          continue
        }
        seeded[event.paneKey] = upsertCard(seeded[event.paneKey] ?? [], event)
      }

      const buffered = get()._askEventBuffer
      clearDismissTimers(get()._dismissTimers)
      set({
        pendingAsksByPaneKey: seeded,
        globalAsks: seededGlobal,
        askWatermark: { seq: snapshot.seq, epoch: snapshot.epoch },
        _askEventBuffer: [],
        _dismissTimers: {}
      })
      for (const event of buffered) {
        get().applyAskRegistryEvent(event)
      }
    },

    resyncAsks: async () => {
      if (get().askWatermark === null) {
        return
      }
      // events during the re-read buffer and replay against the new snapshot's seq
      set({ askWatermark: null })
      await get().hydrateAsks()
    },

    applyAskRegistryEvent: (event) => {
      const state = get()
      const watermark = state.askWatermark
      if (!watermark) {
        // buffered until hydrateAsks resolves — applying early would race the snapshot read and
        // could drop whichever of the two lands second, silently losing an active card
        set({ _askEventBuffer: [...state._askEventBuffer, event].slice(-ASK_EVENT_BUFFER_LIMIT) })
        return
      }
      if (event.epoch !== watermark.epoch) {
        clearDismissTimers(state._dismissTimers)
        set({
          pendingAsksByPaneKey: {},
          globalAsks: [],
          askWatermark: null,
          _askEventBuffer: [],
          _dismissTimers: {}
        })
        void get().hydrateAsks()
        return
      }
      if (event.seq <= watermark.seq) {
        return
      }
      set({
        ...(event.paneKey === null
          ? { globalAsks: upsertCard(state.globalAsks, event) }
          : {
              pendingAsksByPaneKey: {
                ...state.pendingAsksByPaneKey,
                [event.paneKey]: upsertCard(state.pendingAsksByPaneKey[event.paneKey] ?? [], event)
              }
            }),
        askWatermark: { seq: event.seq, epoch: event.epoch }
      })
      if (isTerminalAskStatus(event.status)) {
        scheduleAskDismiss(set, get, event.paneKey, event.askId)
      }
    },

    dismissAsk: (paneKey, askId) => {
      const state = get()
      const timer = state._dismissTimers[askId]
      if (timer !== undefined) {
        clearTimeout(timer)
      }
      const nextTimers = { ...state._dismissTimers }
      delete nextTimers[askId]

      const bucket = paneKey === null ? state.globalAsks : state.pendingAsksByPaneKey[paneKey]
      const remaining = bucket?.filter((card) => card.askId !== askId)
      if (!bucket || !remaining || remaining.length === bucket.length) {
        if (timer !== undefined) {
          set({ _dismissTimers: nextTimers })
        }
        return
      }

      if (paneKey === null) {
        set({ globalAsks: remaining, _dismissTimers: nextTimers })
        return
      }

      const nextByPaneKey = { ...state.pendingAsksByPaneKey }
      if (remaining.length === 0) {
        delete nextByPaneKey[paneKey]
      } else {
        nextByPaneKey[paneKey] = remaining
      }
      set({ pendingAsksByPaneKey: nextByPaneKey, _dismissTimers: nextTimers })
    }
  }
}

const NO_ASKS: readonly AskCardModel[] = []

/** Everything queued on a pane, head first. A stable empty array keeps shallow-equality selectors
 * from re-rendering on every store write when the pane has nothing. */
export function selectPaneAskQueue(
  state: Pick<AsksSlice, 'pendingAsksByPaneKey'>,
  paneKey: string | null
): readonly AskCardModel[] {
  return paneKey ? (state.pendingAsksByPaneKey[paneKey] ?? NO_ASKS) : NO_ASKS
}

/** The card the pane renders. A terminal entry stays head for `ASK_DISMISS_DELAY_MS` so its result
 * flashes before `dismissAsk` advances the queue. */
export function selectHeadAsk(
  state: Pick<AsksSlice, 'pendingAsksByPaneKey'>,
  paneKey: string | null
): AskCardModel | null {
  return paneKey ? (state.pendingAsksByPaneKey[paneKey]?.[0] ?? null) : null
}

/** Non-terminal asks across every pane; the sidebar badge reads this. */
export function selectPendingAskCount(state: Pick<AsksSlice, 'pendingAsksByPaneKey'>): number {
  let count = 0
  for (const bucket of Object.values(state.pendingAsksByPaneKey)) {
    for (const card of bucket) {
      if (!isTerminalAskStatus(card.status)) {
        count += 1
      }
    }
  }
  return count
}
