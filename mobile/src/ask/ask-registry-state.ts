import { isTerminalAskStatus } from '../../../src/shared/fork-ask-question-tool/ask-answer-envelope'
import type { AskStatus } from '../../../src/shared/fork-ask-question-tool/ask-answer-envelope'
import {
  validateAskSpec,
  type AskPartial,
  type AskSpec
} from '../../../src/shared/fork-ask-question-tool/ask-question-schema'
import type { AskStreamEvent, AskStreamFrameInput } from './ask-stream-frame-schema'

export type MobileAsk = {
  askId: string
  paneKey: string
  worktreeId: string
  status: AskStatus
  spec: AskSpec
  partial: AskPartial
  result: { summary: string; skipped: string[] } | null
  /** First-seen order; a pane's current ask is its earliest-registered live one. */
  arrival: number
}

export type AskResumeCursor = { seq: number; epoch: string }

export type AskRegistryState = {
  asks: ReadonlyMap<string, MobileAsk>
  cursor: AskResumeCursor | null
  collecting: ReadonlyMap<string, MobileAsk> | null
  nextArrival: number
}

export const EMPTY_ASK_REGISTRY_STATE: AskRegistryState = {
  asks: new Map(),
  cursor: null,
  collecting: null,
  nextArrival: 0
}

const MAX_RETAINED_TERMINAL_ASKS = 20

function askFromEvent(
  event: AskStreamEvent,
  previous: MobileAsk | undefined,
  arrival: number
): MobileAsk | null {
  // Handoff asks have no pane, and without a worktree there is no session to show the card in.
  const worktreeId = event.worktreeId ?? previous?.worktreeId
  const paneKey = event.paneKey ?? previous?.paneKey
  if (!worktreeId || !paneKey) {
    return null
  }
  let spec = previous?.spec
  if (event.spec !== undefined) {
    const validated = validateAskSpec(event.spec)
    if (validated.ok) {
      spec = validated.spec
    }
  }
  if (!spec) {
    return null
  }
  return {
    askId: event.askId,
    paneKey,
    worktreeId,
    status: event.status,
    spec,
    partial: event.partial ?? previous?.partial ?? {},
    result: event.result ?? previous?.result ?? null,
    arrival: previous?.arrival ?? arrival
  }
}

function pruneTerminalAsks(asks: Map<string, MobileAsk>): void {
  const terminal = [...asks.values()]
    .filter((ask) => isTerminalAskStatus(ask.status))
    .sort((a, b) => a.arrival - b.arrival)
  for (const ask of terminal.slice(0, Math.max(0, terminal.length - MAX_RETAINED_TERMINAL_ASKS))) {
    asks.delete(ask.askId)
  }
}

function commitSnapshot(state: AskRegistryState, seq: number, epoch: string): AskRegistryState {
  const staged = state.collecting ?? new Map<string, MobileAsk>()
  let nextArrival = state.nextArrival
  const asks = new Map<string, MobileAsk>()
  for (const [askId, ask] of staged) {
    const known = state.asks.get(askId)
    asks.set(askId, { ...ask, arrival: known ? known.arrival : nextArrival++ })
  }
  // Terminal summaries are absent from a snapshot; keep the ones this session already saw.
  for (const [askId, ask] of state.asks) {
    if (isTerminalAskStatus(ask.status) && !asks.has(askId)) {
      asks.set(askId, ask)
    }
  }
  pruneTerminalAsks(asks)
  return { asks, collecting: null, nextArrival, cursor: { seq, epoch } }
}

/**
 * Folds one `ask.subscribe` frame into the registry view. A snapshot burst is staged until its
 * watermark so a reconnect replaces the pending set atomically instead of flashing a half-built one.
 */
export function applyAskStreamFrame(
  state: AskRegistryState,
  frame: AskStreamFrameInput
): AskRegistryState {
  switch (frame.type) {
    case 'snapshot': {
      const staged = new Map(state.collecting ?? [])
      const ask = askFromEvent(frame.event, state.asks.get(frame.event.askId), state.nextArrival)
      if (ask) {
        staged.set(ask.askId, ask)
      }
      return { ...state, collecting: staged }
    }
    case 'watermark':
      return commitSnapshot(state, frame.seq, frame.epoch)
    case 'event': {
      const asks = new Map(state.asks)
      const ask = askFromEvent(frame.event, asks.get(frame.event.askId), state.nextArrival)
      let nextArrival = state.nextArrival
      if (ask) {
        if (!asks.has(ask.askId)) {
          nextArrival += 1
        }
        asks.set(ask.askId, ask)
        pruneTerminalAsks(asks)
      }
      const heldSeq = state.cursor?.epoch === frame.event.epoch ? state.cursor.seq : -1
      return {
        asks,
        collecting: state.collecting,
        nextArrival,
        cursor: { seq: Math.max(heldSeq, frame.event.seq), epoch: frame.event.epoch }
      }
    }
    case 'end':
      return frame.reason === 'epoch_changed' ? { ...state, cursor: null, collecting: null } : state
    case 'error':
      return state
  }
}

/** The ask each pane of `worktreeId` is currently showing: its earliest-registered live ask. */
export function currentLiveAsksForWorktree(
  state: AskRegistryState,
  worktreeId: string
): MobileAsk[] {
  const earliestByPane = new Map<string, MobileAsk>()
  for (const ask of state.asks.values()) {
    if (ask.worktreeId !== worktreeId || isTerminalAskStatus(ask.status)) {
      continue
    }
    const held = earliestByPane.get(ask.paneKey)
    if (!held || ask.arrival < held.arrival) {
      earliestByPane.set(ask.paneKey, ask)
    }
  }
  return [...earliestByPane.values()].sort((a, b) => a.arrival - b.arrival)
}

/** Asks of this worktree that finished, newest first, for the collapsed summary. */
export function settledAsksForWorktree(state: AskRegistryState, worktreeId: string): MobileAsk[] {
  return [...state.asks.values()]
    .filter((ask) => ask.worktreeId === worktreeId && isTerminalAskStatus(ask.status))
    .sort((a, b) => b.arrival - a.arrival)
}
