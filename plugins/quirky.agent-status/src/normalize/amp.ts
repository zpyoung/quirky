import type { Normalizer, NormalizerCache } from '../types'
import { cacheResetResult, readFirstString, readPrompt, result, summarizeToolInput } from './shared'

const THREADS = 'amp:threads'
const MAX_THREADS = 32
const THREAD_ID_MAX = 256

/** Whether each thread's last turn ended, least recently seen first. */
function threads(cache: NormalizerCache): Map<string, boolean> {
  let map = cache.get(THREADS) as Map<string, boolean> | undefined
  if (!map) {
    map = new Map()
    cache.set(THREADS, map)
  }
  return map
}

function threadId(payload: Record<string, unknown>): string {
  const id = readFirstString(payload, ['threadId', 'threadID', 'thread_id'])
  return id && id.length <= THREAD_ID_MAX ? id : ''
}

function remember(cache: NormalizerCache, id: string, ended: boolean): void {
  const map = threads(cache)
  map.delete(id)
  map.set(id, ended)
  while (map.size > MAX_THREADS) {
    const oldest = map.keys().next().value as string
    map.delete(oldest)
  }
}

/**
 * Amp multiplexes many threads through one session. Status posts are fire-and-forget, so a
 * tool event arriving after its thread's `agent.end` is stale and dropped.
 */
export const normalizeAmp: Normalizer = (payload, eventName, cache) => {
  const id = threadId(payload)
  if (eventName === 'session.start') {
    threads(cache).delete(id)
    return cacheResetResult(eventName)
  }
  if (eventName === 'agent.start') {
    remember(cache, id, false)
    return result(eventName, 'working', { newTurn: true, fields: { prompt: readPrompt(payload, { allowMessage: true }) } })
  }
  if (eventName === 'agent.end') {
    remember(cache, id, true)
    const cancelled = payload.status === 'cancelled'
    return result(eventName, 'done', { interrupted: cancelled ? true : undefined, fields: { prompt: readPrompt(payload) } })
  }
  if (eventName !== 'tool.call' && eventName !== 'tool.result') return null
  if (threads(cache).get(id) === true) return null
  return result(eventName, 'working', {
    fields: {
      toolName: readFirstString(payload, ['tool', 'toolName', 'name']),
      toolInput: summarizeToolInput(payload.input ?? payload.tool_input ?? payload.arguments),
    },
  })
}
