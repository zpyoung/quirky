const MAX_OUTPUT_BYTES = 256 * 1024
const DRAIN_GRACE_MS = 250
const KILL_GRACE_MS = 250
const GROUP_POLL_MS = 20

type Child = ReturnType<typeof Bun.spawn>
export type ModelProbeResult = { ok: true; stdout: string } | { ok: false; reason: 'timeout' | 'too-much-output' | 'could-not-start' | 'nonzero-exit' | 'output-not-closed' }
type ProbeRace = { kind: 'exit'; code: number | null } | { kind: 'timeout' } | { kind: 'too-much-output' }

function signalGroup(child: Child, signal: NodeJS.Signals): void {
  try {
    process.kill(-child.pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      // the process already exited
    }
  }
}

function groupAlive(child: Child): boolean {
  try {
    process.kill(-child.pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function terminateGroup(child: Child): Promise<void> {
  signalGroup(child, 'SIGTERM')
  const deadline = Date.now() + KILL_GRACE_MS
  while (groupAlive(child) && Date.now() < deadline) await Bun.sleep(GROUP_POLL_MS)
  if (groupAlive(child)) signalGroup(child, 'SIGKILL')
  await Promise.race([child.exited, Bun.sleep(KILL_GRACE_MS)])
}

async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel()
  } catch {
    // the stream may already have released its reader
  }
}

/** Starts a declared argv directly; process time and retained stdout are bounded independently. */
export async function runModelProbe(argv: string[], timeoutMs: number): Promise<ModelProbeResult> {
  let child: Child
  try {
    const options = { cwd: process.cwd(), env: process.env, stdin: 'ignore', stdout: 'pipe', stderr: 'ignore', detached: true } as const
    child = Bun.spawn(argv, options as unknown as Bun.SpawnOptions.OptionsObject<'ignore', 'pipe', 'ignore'>)
  } catch {
    return { ok: false, reason: 'could-not-start' }
  }

  const tooMuchOutput = Promise.withResolvers<ProbeRace>()
  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader()
  const chunks: Buffer[] = []
  let bytes = 0
  const output = (async (): Promise<string | null> => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return Buffer.concat(chunks, bytes).toString('utf8')
        bytes += value.byteLength
        if (bytes > MAX_OUTPUT_BYTES) {
          tooMuchOutput.resolve({ kind: 'too-much-output' })
          signalGroup(child, 'SIGTERM')
          return null
        }
        chunks.push(Buffer.from(value))
      }
    } catch {
      return null
    } finally {
      reader.releaseLock()
    }
  })()
  const timeoutResult = Promise.withResolvers<ProbeRace>()
  const timeoutTimer = setTimeout(() => timeoutResult.resolve({ kind: 'timeout' }), timeoutMs)
  timeoutTimer.unref()
  const exited: Promise<ProbeRace> = child.exited.then((code) => ({ kind: 'exit', code }))
  const first = await Promise.race([exited, timeoutResult.promise, tooMuchOutput.promise])
  clearTimeout(timeoutTimer)
  if (first.kind !== 'exit') {
    await terminateGroup(child)
    await cancelReader(reader)
    void output
    return { ok: false, reason: first.kind }
  }

  const drained = await Promise.race([
    output.then((stdout) => ({ complete: true as const, stdout })),
    Bun.sleep(DRAIN_GRACE_MS).then(() => ({ complete: false as const, stdout: null }))
  ])
  if (!drained.complete) {
    await terminateGroup(child)
    await cancelReader(reader)
    return { ok: false, reason: 'output-not-closed' }
  }
  await terminateGroup(child)
  if (drained.stdout === null || first.code !== 0) return { ok: false, reason: 'nonzero-exit' }
  return { ok: true, stdout: drained.stdout }
}
