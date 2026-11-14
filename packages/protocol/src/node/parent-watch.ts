/** Parse the explicit owner pid without accepting ambiguous daemon startup flags. */
export function parseExitWithParent(argv: readonly string[]): number | null {
  const flags = argv.filter(arg => arg === '--exit-with-parent' || arg.startsWith('--exit-with-parent='))
  if (flags.length === 0) return null
  const value = flags[0]!.slice('--exit-with-parent='.length)
  const pid = Number(value)
  if (flags.length !== 1 || !/^\d+$/.test(value) || !Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error('invalid --exit-with-parent')
  }
  return pid
}

/** Notify once when a supervised process no longer has its original parent. */
export function watchParent(options: {
  parentPid: number
  onLost(): void
  intervalMs?: number
  readPpid?: () => number
}): () => void {
  const readPpid = options.readPpid ?? (() => process.ppid)
  const timer = setInterval(() => {
    if (readPpid() === options.parentPid) return
    clearInterval(timer)
    options.onLost()
  }, options.intervalMs ?? 250)
  return () => clearInterval(timer)
}
