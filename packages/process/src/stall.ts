/**
 * Git exited but a pipe of its output never delivered its end. Bun 1.4.0 on Linux can lose the
 * epoll wakeup of a subprocess pipe when several children exit in one loop turn: the bytes stay
 * queued in the socket and the read stays pending for the life of the process. The stall guard
 * and retry built on this is a workaround for that Bun 1.4.0 bug and can go once Bun fixes it.
 */
export class PipeStalledError extends Error {
  constructor() {
    super('process exited but its output did not end')
    this.name = 'PipeStalledError'
  }
}
/** Default quiet period after process exit before an output read is considered stalled. */
export const PIPE_STALL_MS = 1_000


/** Returns a pending read unless the process exited and the stream stayed quiet past `stallMs`. */
export async function untilStalled<T>(exited: Promise<unknown>, pending: Promise<T>, stallMs = PIPE_STALL_MS): Promise<T> {
  const { promise: stalled, reject } = Promise.withResolvers<never>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let finished = false
  void exited.then(
    () => {
      if (!finished) timer = setTimeout(() => reject(new PipeStalledError()), stallMs)
    },
    () => {}
  )
  stalled.catch(() => {})
  try {
    return await Promise.race([pending, stalled])
  } finally {
    finished = true
    clearTimeout(timer)
  }
}

/** Reads one chunk and abandons the stream if its process exited without ending the pipe. */
export async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  exited: Promise<unknown>,
  stallMs = PIPE_STALL_MS
) {
  try {
    return await untilStalled(exited, reader.read(), stallMs)
  } catch (error) {
    if (error instanceof PipeStalledError) void reader.cancel().catch(() => {})
    throw error
  }
}
