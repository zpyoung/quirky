export function createShutdown(options: {
  stop(): Promise<void>
  release(): void
  exit(code: number): void
  onDeadline?(): void
  log(message: string): void
  deadlineMs?: number
}): () => void {
  const deadlineMs = options.deadlineMs ?? 8000
  let started = false
  let finished = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const finish = (code: number) => {
    if (finished) return
    finished = true
    clearTimeout(timer)
    try {
      options.release()
    } finally {
      options.exit(code)
    }
  }

  return () => {
    if (started) return
    started = true
    timer = setTimeout(() => {
      try {
        options.log(`stop did not finish within ${deadlineMs} ms; exiting`)
        options.onDeadline?.()
      } finally {
        finish(1)
      }
    }, deadlineMs)

    try {
      void options.stop().then(
        () => finish(0),
        () => finish(0)
      )
    } catch {
      finish(0)
    }
  }
}
