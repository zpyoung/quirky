import { isTerminalAskStatus } from '../../../../../shared/fork-ask-question-tool/ask-answer-envelope'
import type {
  AskEnvelope,
  AskResultBody
} from '../../../../../shared/fork-ask-question-tool/ask-answer-envelope'
import type {
  AskPartial,
  AskRegistryEvent,
  AskSpec
} from '../../../../../shared/fork-ask-question-tool/ask-question-schema'
import type { AskRow } from '../../../../fork-ask-question-tool/ask-db'

const EMPTY_RESULT: AskResultBody = { answers: {}, skipped: [], summary: '' }

function resultFromRow(row: AskRow): AskResultBody {
  return row.answers_json ? (JSON.parse(row.answers_json) as AskResultBody) : EMPTY_RESULT
}

/** Builds the wire envelope for a terminal ask row — the hand-off lifecycle's counterpart to AskRegistry's private builder. */
export function envelopeFromAskRow(row: AskRow): AskEnvelope {
  const result = resultFromRow(row)
  const askId = row.ask_id
  switch (row.status) {
    case 'answered':
      return { status: 'answered', askId, ...result }
    case 'partial':
      return { status: 'partial', askId, ...result }
    case 'declined':
      return { status: 'declined', askId, ...result }
    case 'timed_out':
      return { status: 'timed_out', askId, ...result }
    case 'unavailable':
      return { status: 'unavailable', askId, reason: result.summary, ...result }
    case 'registered':
      throw new Error(`ask ${askId} has non-terminal status ${row.status}`)
  }
}

export function unknownAskEnvelope(askId: string): AskEnvelope {
  return {
    status: 'unavailable',
    askId,
    reason: `ask ${askId} is unknown or has expired`,
    ...EMPTY_RESULT
  }
}

/** The `AskRegistryEvent` for one row — a snapshot-frame source for asks this process never saw a live transition for. */
export function registryEventFromRow(row: AskRow, epoch: string): AskRegistryEvent {
  const base = {
    seq: row.seq,
    epoch,
    askId: row.ask_id,
    paneKey: row.pane_key,
    status: row.status,
    worktreeId: row.worktree_id
  }
  if (isTerminalAskStatus(row.status)) {
    return { ...base, result: resultFromRow(row) }
  }
  return {
    ...base,
    spec: JSON.parse(row.spec_json) as AskSpec,
    ...(row.partial_json ? { partial: JSON.parse(row.partial_json) as AskPartial } : {})
  }
}
