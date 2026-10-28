import type { WorkerActivity, WorkerScan } from './contracts'
import { OWNER_IDLE_GRACE_MS, OWNER_RECHECK_MS, OWNER_STALL_THRESHOLD_MS } from './contracts'

const PROSE_QUESTION_CUE = /\b(?:who|what|when|where|why|how|which|whose|whom|am|is|are|was|were|do|does|did|can|could|would|will|should|have|has|had|may|might|must|shall|or)\b/i
const LOG_PREFIX = /^\s*(?:(?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?\s+)?(?:\[(?:TRACE|DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL)\]|(?:TRACE|DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL):?)(?:\s|$))/i
const FENCE_OPEN = /^[ \t]{0,3}(`{3,}|~{3,})/

function isTimestampAtOrBefore(value: number | undefined, now: number): value is number {
  return value !== undefined && Number.isFinite(value) && value <= now
}

function hasFreshLiveContact(worker: WorkerActivity, now: number): boolean {
  return Number.isFinite(now)
    && worker.contact === 'live'
    && Number.isFinite(worker.observedAtMs)
    && worker.observedAtMs <= now
    && now - worker.observedAtMs <= OWNER_RECHECK_MS
}

function mergeCheckAt(current: number | null, deadline: number, now: number): number | null {
  if (deadline <= now) return current
  const checkAt = Math.min(now + OWNER_RECHECK_MS, deadline)
  return current === null ? checkAt : Math.min(current, checkAt)
}

function encodeIdentity(parts: readonly (string | number)[]): string {
  return JSON.stringify(parts)
}

export function scanWorkers(workers: WorkerActivity[], hasOwner: boolean, now: number): WorkerScan {
  const result: WorkerScan = {
    deviations: [],
    observations: [],
    questions: [],
    nextCheckAtMs: null
  }
  if (!Number.isFinite(now)) return result

  for (const worker of [...workers].sort((left, right) =>
    left.dispatchId < right.dispatchId ? -1 : left.dispatchId > right.dispatchId ? 1 : 0
  )) {
    if (!hasFreshLiveContact(worker, now)) continue

    const idleSinceMs = worker.idleSinceMs
    if (worker.waitingAtPrompt === true
      && isTimestampAtOrBefore(idleSinceMs, worker.observedAtMs)) {
      const idleDurationMs = now - idleSinceMs
      if (idleDurationMs < OWNER_IDLE_GRACE_MS) {
        result.nextCheckAtMs = mergeCheckAt(
          result.nextCheckAtMs,
          idleSinceMs + OWNER_IDLE_GRACE_MS,
          now
        )
      } else if (hasOwner) {
        result.deviations.push({
          kind: 'stall',
          naturalKey: `stall:${encodeIdentity([worker.dispatchId, 'idle', idleSinceMs])}`,
          dispatchId: worker.dispatchId,
          trigger: 'idle',
          detail: `Worker has been waiting at a verified prompt for ${idleDurationMs}ms.`
        })
      } else {
        const message = worker.lastMessage ?? ''
        if (looksLikeProseQuestion(message)) {
          result.questions.push({
            key: `worker-question:${encodeIdentity([worker.dispatchId, idleSinceMs])}`,
            dispatchId: worker.dispatchId,
            messageId: `prose-question:${idleSinceMs}`,
            body: message
          })
        } else {
          result.observations.push({
            key: `worker-idle:${encodeIdentity([worker.dispatchId, idleSinceMs])}`,
            dispatchId: worker.dispatchId,
            idleSinceMs,
            detail: `Worker has been waiting at a verified prompt for ${idleDurationMs}ms.`
          })
        }
      }
    }

    if (hasOwner && isTimestampAtOrBefore(worker.lastProgressAtMs, now)) {
      const silentDurationMs = now - worker.lastProgressAtMs
      if (silentDurationMs < OWNER_STALL_THRESHOLD_MS) {
        result.nextCheckAtMs = mergeCheckAt(
          result.nextCheckAtMs,
          worker.lastProgressAtMs + OWNER_STALL_THRESHOLD_MS,
          now
        )
      } else {
        result.deviations.push({
          kind: 'stall',
          naturalKey: `stall:${encodeIdentity([worker.dispatchId, 'silent', worker.lastProgressAtMs])}`,
          dispatchId: worker.dispatchId,
          trigger: 'silent',
          detail: `Worker has had no mailbox progress for ${silentDurationMs}ms.`
        })
      }
    }
  }

  return result
}

function finalParagraphOutsideCode(message: string): string {
  const lines = message.replace(/\r\n?/g, '\n').split('\n')
  const visibleLines: string[] = []
  let fenceCharacter: string | null = null
  let fenceLength = 0

  for (const line of lines) {
    const fence = FENCE_OPEN.exec(line)
    if (fenceCharacter !== null) {
      if (fence !== null
        && fence[1][0] === fenceCharacter
        && fence[1].length >= fenceLength
        && /^[ \t]*$/.test(line.slice(fence[0].length))) {
        fenceCharacter = null
        fenceLength = 0
      }
      continue
    }

    if (fence !== null) {
      visibleLines.push('', '\u0000', '')
      fenceCharacter = fence[1][0]
      fenceLength = fence[1].length
    } else {
      visibleLines.push(line)
    }
  }

  const visibleMessage = visibleLines.join('\n').trimEnd()
  const paragraphs = visibleMessage.split(/\n[ \t]*\n/)
  const lastParagraph = paragraphs[paragraphs.length - 1] ?? ''
  return lastParagraph.replace(/\u0000/g, '').trim()
}

export function looksLikeProseQuestion(message: string): boolean {
  const paragraph = finalParagraphOutsideCode(message)
  if (paragraph.length === 0) return false

  const proseLines = paragraph
    .split('\n')
    .filter((line) => line.trim().length > 0 && !LOG_PREFIX.test(line))
  if (proseLines.length === 0) return false

  const prose = proseLines.join('\n').replace(/(`+)[^`\n]*\1/g, ' ')
  for (const match of prose.matchAll(/[^.!?]*\?/g)) {
    if (PROSE_QUESTION_CUE.test(match[0])) return true
  }
  return false
}
