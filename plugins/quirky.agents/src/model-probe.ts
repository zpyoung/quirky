import { isPlainObject } from './core/guards'
const MAX_OUTPUT_BYTES = 256 * 1024
const DRAIN_GRACE_MS = 250
const KILL_GRACE_MS = 250
const GROUP_POLL_MS = 20

type Child = ReturnType<typeof Bun.spawn>
export type ModelProbeResult = { ok: true; stdout: string } | { ok: false; reason: 'timeout' | 'too-much-output' | 'could-not-start' | 'nonzero-exit' | 'output-not-closed' | 'malformed-output' }
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
const MAX_CODEX_MODEL_PAGES = 32
const MAX_CODEX_MODELS = 4096
const CODEX_MODEL_PAGE_SIZE = 100

class ProbeFailure extends Error {
  constructor(readonly reason: Extract<ModelProbeResult, { ok: false }>['reason'], message: string) {
    super(message)
  }
}


/** Queries Codex's real stdio app-server `model/list` API using an account-prepared environment. */
export async function runCodexAppServerModelProbe(
  argv: string[],
  timeoutMs: number,
  env: Record<string, string>,
  cwd: string
): Promise<ModelProbeResult> {
  let child: Child
  try {
    const options = { cwd, env, stdin: 'pipe', stdout: 'pipe', stderr: 'ignore', detached: true } as const
    child = Bun.spawn(argv, options as unknown as Bun.SpawnOptions.OptionsObject<'pipe', 'pipe', 'ignore'>)
  } catch {
    return { ok: false, reason: 'could-not-start' }
  }

  const stdin = child.stdin as WritableStream<Uint8Array>
  const stdout = child.stdout as ReadableStream<Uint8Array>
  const writer = stdin.getWriter()
  const reader = stdout.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const timeout = Promise.withResolvers<ModelProbeResult>()
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined
  let buffer = ''
  let outputBytes = 0
  let settled = false

  const readMessage = async (): Promise<Record<string, unknown>> => {
    for (;;) {
      const newline = buffer.indexOf('\n')
      if (newline >= 0) {
        let frame = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (frame.endsWith('\r')) frame = frame.slice(0, -1)
        if (frame === '' || Buffer.byteLength(frame, 'utf8') > MAX_OUTPUT_BYTES) {
          throw new ProbeFailure('malformed-output', 'Codex app-server returned an invalid frame.')
        }
        let value: unknown
        try {
          value = JSON.parse(frame) as unknown
        } catch {
          throw new ProbeFailure('malformed-output', 'Codex app-server returned malformed JSON.')
        }
        if (!isPlainObject(value)) throw new ProbeFailure('malformed-output', 'Codex app-server returned a non-object message.')
        return value
      }
      const { done, value } = await reader.read()
      if (done) {
        buffer += decoder.decode()
        throw new ProbeFailure(buffer === '' ? 'output-not-closed' : 'malformed-output', 'Codex app-server closed before completing its response.')
      }
      outputBytes += value.byteLength
      if (outputBytes > MAX_OUTPUT_BYTES) throw new ProbeFailure('too-much-output', 'Codex app-server exceeded the output limit.')
      try {
        buffer += decoder.decode(value, { stream: true })
      } catch {
        throw new ProbeFailure('malformed-output', 'Codex app-server returned invalid UTF-8.')
      }
      if (Buffer.byteLength(buffer, 'utf8') > MAX_OUTPUT_BYTES) {
        throw new ProbeFailure('too-much-output', 'Codex app-server exceeded the output limit.')
      }
    }
  }

  const request = async (id: number, method: string, params: Record<string, unknown>): Promise<unknown> => {
    await writer.write(Buffer.from(`${JSON.stringify({ id, method, params })}\n`, 'utf8'))
    for (;;) {
      const message = await readMessage()
      if (Object.hasOwn(message, 'method')) {
        if (typeof message.method !== 'string' || Object.hasOwn(message, 'id')) {
          throw new ProbeFailure('malformed-output', 'Codex app-server sent an unsupported request.')
        }
        continue
      }
      if (message.id !== id || Object.hasOwn(message, 'result') === Object.hasOwn(message, 'error')) {
        throw new ProbeFailure('malformed-output', 'Codex app-server returned an unmatched response.')
      }
      if (Object.hasOwn(message, 'error')) throw new ProbeFailure('nonzero-exit', `Codex app-server rejected ${method}.`)
      return message.result
    }
  }

  const operation = async (): Promise<string> => {
    const initialized = await request(1, 'initialize', {
      clientInfo: { name: 'quirky_model_discovery', title: 'Quirky model discovery', version: '0.1.0' }
    })
    if (!isPlainObject(initialized)) throw new ProbeFailure('malformed-output', 'Codex app-server initialization response was invalid.')
    await writer.write(Buffer.from(`${JSON.stringify({ method: 'initialized', params: {} })}\n`, 'utf8'))

    const data: unknown[] = []
    let cursor: string | null = null
    for (let page = 0; page < MAX_CODEX_MODEL_PAGES; page += 1) {
      const result = await request(2 + page, 'model/list', {
        includeHidden: false,
        limit: CODEX_MODEL_PAGE_SIZE,
        ...(cursor === null ? {} : { cursor })
      })
      if (!isPlainObject(result) || !Array.isArray(result.data)) {
        throw new ProbeFailure('malformed-output', 'Codex app-server returned an invalid model/list page.')
      }
      const nextCursor = result.nextCursor
      if (!(nextCursor === null || typeof nextCursor === 'string')) {
        throw new ProbeFailure('malformed-output', 'Codex app-server returned an invalid model-list cursor.')
      }
      if (data.length + result.data.length > MAX_CODEX_MODELS) {
        throw new ProbeFailure('too-much-output', 'Codex app-server returned too many models.')
      }
      data.push(...result.data)
      if (result.nextCursor === null) return JSON.stringify({ data, nextCursor: null })
      if (nextCursor === '' || nextCursor === cursor) {
        throw new ProbeFailure('malformed-output', 'Codex app-server returned an invalid model-list cursor.')
      }
      cursor = nextCursor
    }
    throw new ProbeFailure('too-much-output', 'Codex app-server model listing exceeded the page limit.')
  }

  const work = operation().then(
    (stdout) => {
      settled = true
      timeout.resolve({ ok: true, stdout })
    },
    (error: unknown) => {
      settled = true
      timeout.resolve({
        ok: false,
        reason: error instanceof ProbeFailure ? error.reason : 'malformed-output'
      })
    }
  )
  timeoutTimer = setTimeout(() => {
    if (settled) return
    settled = true
    timeout.resolve({ ok: false, reason: 'timeout' })
  }, timeoutMs)
  timeoutTimer.unref()
  void child.exited.then((code) => {
    if (settled) return
    settled = true
    timeout.resolve({ ok: false, reason: code === 0 ? 'output-not-closed' : 'nonzero-exit' })
  })

  clearTimeout(timeoutTimer)
  try {
    await writer.close()
  } catch {
    // Closing stdin after the app-server exits is expected.
  }
  await terminateGroup(child)
  await cancelReader(reader)
  void work
  return result
}
