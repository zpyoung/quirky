import type { EvaluateInput, Evaluation, LineMatch, Origin, RuleFile } from './types'

export type MatcherRequest =
  | { id: number; op: 'evaluate'; file: RuleFile; input: EvaluateInput; origin: Origin }
  | { id: number; op: 'line'; pattern: string; ignoreCase: boolean; lines: string[] }

export type MatcherResponse =
  | { ready: true }
  | { id: number; result: Evaluation | LineMatch | null }

export class InvalidMatcherFrameError extends Error {
  constructor() {
    super('invalid matcher frame')
    this.name = 'InvalidMatcherFrameError'
  }
}

/** Incrementally decodes UTF-8 JSONL frames and releases its stream reader on every exit path. */
export function readMatcherFrames(stream: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = stream.getReader()
  let started = false
  let finished = false
  let released = false

  const release = () => {
    if (released) return
    released = true
    reader.releaseLock()
  }

  const cancel = async () => {
    try {
      await reader.cancel()
    } catch {
      return
    }
  }

  const frames = (async function* (): AsyncGenerator<unknown> {
    started = true
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let pending = ''
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) {
          try {
            pending += decoder.decode()
          } catch {
            throw new InvalidMatcherFrameError()
          }
          if (pending.length !== 0) throw new InvalidMatcherFrameError()
          finished = true
          return
        }

        try {
          pending += decoder.decode(value, { stream: true })
        } catch {
          throw new InvalidMatcherFrameError()
        }
        let boundary = pending.indexOf('\n')
        while (boundary >= 0) {
          let frame: unknown
          try {
            frame = JSON.parse(pending.slice(0, boundary))
          } catch {
            throw new InvalidMatcherFrameError()
          }
          pending = pending.slice(boundary + 1)
          yield frame
          boundary = pending.indexOf('\n')
        }
      }
    } finally {
      if (!finished) await cancel()
      release()
    }
  })()

  const returnFrames = frames.return.bind(frames)
  frames.return = async (value) => {
    if (!started) {
      await cancel()
      release()
    } else if (!finished) {
      await cancel()
    }
    return returnFrames(value)
  }

  return frames
}
