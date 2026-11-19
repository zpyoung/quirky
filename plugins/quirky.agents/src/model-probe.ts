import type { ProcessSpawner, SpawnExit, SpawnedProcess } from '@quirky/protocol'
import { isPlainObject } from './core/guards'

const MAX_OUTPUT_BYTES = 256 * 1024
const DRAIN_GRACE_MS = 250
const KILL_GRACE_MS = 250

export type ModelProbeResult = { ok: true; stdout: string } | { ok: false; reason: 'timeout' | 'too-much-output' | 'could-not-start' | 'nonzero-exit' | 'output-not-closed' | 'malformed-output' }

async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel()
  } catch {
    // The stream may already have released its reader.
  }
}

/** Starts a declared argv directly; process time and retained stdout are bounded independently. */
export async function runModelProbe(spawner: ProcessSpawner, argv: string[], timeoutMs: number): Promise<ModelProbeResult> {
  let handle: SpawnedProcess
  try {
    handle = spawner.spawn(argv, {
      cwd: process.cwd(),
      env: process.env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
      timeoutMs,
      killGraceMs: KILL_GRACE_MS
    })
  } catch {
    return { ok: false, reason: 'could-not-start' }
  }
  if (handle.pid === null) {
    await handle.exited.catch(() => undefined)
    return { ok: false, reason: 'could-not-start' }
  }

  const reader = handle.stdout.getReader()
  const chunks: Buffer[] = []
  let bytes = 0
  let tooMuchOutput = false
  let stdoutClosed = false
  let outputNotClosed = false
  let streamError: unknown
  let readerSettled = false
  let stdout = ''
  const output = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) {
          stdoutClosed = true
          stdout = Buffer.concat(chunks, bytes).toString('utf8')
          return
        }
        bytes += value.byteLength
        if (bytes > MAX_OUTPUT_BYTES) {
          tooMuchOutput = true
          void cancelReader(reader)
          void handle.stop({ graceMs: KILL_GRACE_MS })
          return
        }
        chunks.push(Buffer.from(value))
      }
    } catch (error) {
      streamError = error
      void handle.stop({ graceMs: KILL_GRACE_MS })
    } finally {
      readerSettled = true
      try {
        reader.releaseLock()
      } catch {
        // A pending read owns the lock until cancellation settles.
      }
    }
  })()

  let timedOut = false
  const timeoutTimer = setTimeout(() => {
    timedOut = true
    void handle.stop({ graceMs: KILL_GRACE_MS })
  }, timeoutMs)
  timeoutTimer.unref()

  let exit: SpawnExit
  try {
    exit = await handle.exited
  } catch {
    exit = { exitCode: null, signal: null, durationMs: 0 }
  }

  if (!readerSettled && !tooMuchOutput && !timedOut && exit.stopped === undefined && exit.spawnError === undefined) {
    const drained = await Promise.race([
      output.then(() => true),
      Bun.sleep(DRAIN_GRACE_MS).then(() => false)
    ])
    if (!drained) {
      outputNotClosed = true
      void cancelReader(reader)
      void handle.stop({ graceMs: KILL_GRACE_MS })
    }
  } else if (!readerSettled && (exit.stopped !== undefined || exit.spawnError !== undefined || timedOut)) {
    await Promise.race([output, Bun.sleep(DRAIN_GRACE_MS)])
  }

  clearTimeout(timeoutTimer)
  const stoppedExit = await handle.stop({ graceMs: KILL_GRACE_MS })
  if (stoppedExit.spawnError) exit = stoppedExit

  if (exit.spawnError) return { ok: false, reason: 'could-not-start' }
  if (tooMuchOutput) return { ok: false, reason: 'too-much-output' }
  if (timedOut || exit.stopped === 'timeout') return { ok: false, reason: 'timeout' }
  if (exit.stopped !== undefined) return { ok: false, reason: 'nonzero-exit' }
  if (outputNotClosed || (streamError instanceof Error && streamError.name === 'ProcessStalledError')) return { ok: false, reason: 'output-not-closed' }
  if (exit.exitCode !== 0 || streamError !== undefined || !stdoutClosed) return { ok: false, reason: 'nonzero-exit' }
  return { ok: true, stdout }
}

const MAX_CODEX_MODEL_PAGES = 32
const MAX_CODEX_MODELS = 4096
const CODEX_MODEL_PAGE_SIZE = 100

class ProbeFailure extends Error {
  constructor(readonly reason: Extract<ModelProbeResult, { ok: false }>['reason'], message: string) {
    super(message)
  }
}

async function boundedJsonResponse(response: Response, controller: AbortController, provider: string): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) throw new ProbeFailure('malformed-output', `${provider} returned an empty model-list response.`)
  const chunks: Buffer[] = []
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_OUTPUT_BYTES) {
        await reader.cancel()
        throw new ProbeFailure('too-much-output', `${provider} model-list response exceeded the output limit.`)
      }
      chunks.push(Buffer.from(value))
    }
  } catch (error) {
    if (error instanceof ProbeFailure) throw error
    throw new ProbeFailure(controller.signal.aborted ? 'timeout' : 'malformed-output', `${provider} model-list response could not be read.`)
  } finally {
    reader.releaseLock()
  }

  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes))) as unknown
  } catch {
    throw new ProbeFailure('malformed-output', `${provider} returned malformed model-list data.`)
  }
}


/** Queries Codex's real stdio app-server `model/list` API using an account-prepared environment. */
export async function runCodexAppServerModelProbe(
  spawner: ProcessSpawner,
  argv: string[],
  timeoutMs: number,
  env: Record<string, string>,
  cwd: string
): Promise<ModelProbeResult> {
  let handle: SpawnedProcess
  try {
    handle = spawner.spawn(argv, {
      cwd, env, stdin: 'pipe', stdout: 'pipe', stderr: 'ignore', timeoutMs, killGraceMs: KILL_GRACE_MS
    })
  } catch {
    return { ok: false, reason: 'could-not-start' }
  }
  if (handle.pid === null) {
    await handle.exited.catch(() => undefined)
    return { ok: false, reason: 'could-not-start' }
  }

  const reader = handle.stdout.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let buffer = ''
  let outputBytes = 0
  let streamError: unknown
  let observedExit: SpawnExit | undefined
  const exited = handle.exited.then((exit) => {
    observedExit = exit
    return exit
  })
  const send = async (message: Record<string, unknown>): Promise<void> => {
    const accepted = await handle.write(`${JSON.stringify(message)}\n`)
    if (!accepted) throw new ProbeFailure('output-not-closed', 'Codex app-server closed stdin before accepting a request.')
  }

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
      let chunk
      try {
        chunk = await reader.read()
      } catch (error) {
        streamError = error
        throw error
      }
      if (chunk.done) {
        try {
          buffer += decoder.decode()
        } catch {
          throw new ProbeFailure('malformed-output', 'Codex app-server returned invalid UTF-8.')
        }
        throw new ProbeFailure(buffer === '' ? 'output-not-closed' : 'malformed-output', 'Codex app-server closed before completing its response.')
      }
      outputBytes += chunk.value.byteLength
      if (outputBytes > MAX_OUTPUT_BYTES) throw new ProbeFailure('too-much-output', 'Codex app-server exceeded the output limit.')
      try {
        buffer += decoder.decode(chunk.value, { stream: true })
      } catch {
        throw new ProbeFailure('malformed-output', 'Codex app-server returned invalid UTF-8.')
      }
      if (Buffer.byteLength(buffer, 'utf8') > MAX_OUTPUT_BYTES) {
        throw new ProbeFailure('too-much-output', 'Codex app-server exceeded the output limit.')
      }
    }
  }

  const request = async (id: number, method: string, params: Record<string, unknown>): Promise<unknown> => {
    await send({ id, method, params })
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
    await send({ method: 'initialized', params: {} })

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
      if (result.nextCursor === null) {
        const stdout = JSON.stringify({ data, nextCursor: null })
        if (Buffer.byteLength(stdout, 'utf8') > MAX_OUTPUT_BYTES) {
          throw new ProbeFailure('too-much-output', 'Codex app-server model snapshot exceeded the output limit.')
        }
        return stdout
      }
      if (nextCursor === '' || nextCursor === cursor) {
        throw new ProbeFailure('malformed-output', 'Codex app-server returned an invalid model-list cursor.')
      }
      cursor = nextCursor
    }
    throw new ProbeFailure('too-much-output', 'Codex app-server model listing exceeded the page limit.')
  }

  type Exchange =
    | { kind: 'complete'; stdout: string }
    | { kind: 'failure'; error: unknown }
    | { kind: 'exit'; exit: SpawnExit }
    | { kind: 'timeout' }
  let timedOut = false
  const deadline = Promise.withResolvers<Exchange>()
  const timeoutTimer = setTimeout(() => {
    timedOut = true
    void handle.stop({ graceMs: KILL_GRACE_MS })
    deadline.resolve({ kind: 'timeout' })
  }, timeoutMs)
  timeoutTimer.unref()
  const operationResult: Promise<Exchange> = operation().then(
    (stdout) => ({ kind: 'complete', stdout }),
    (error: unknown) => ({ kind: 'failure', error })
  )
  const exitResult = exited.then((exit): Exchange => ({ kind: 'exit', exit }))
  const exchange = await Promise.race([operationResult, exitResult, deadline.promise])
  clearTimeout(timeoutTimer)
  await cancelReader(reader)
  try {
    reader.releaseLock()
  } catch {
    // A pending read owns the lock until cancellation settles.
  }
  void handle.closeInput().catch(() => undefined)
  const exitBeforeCleanup = observedExit
  const exit = await handle.stop({ graceMs: KILL_GRACE_MS })

  if (exit.spawnError || exitBeforeCleanup?.spawnError) return { ok: false, reason: 'could-not-start' }
  if (outputBytes > MAX_OUTPUT_BYTES || (exchange.kind === 'failure' && exchange.error instanceof ProbeFailure && exchange.error.reason === 'too-much-output')) {
    return { ok: false, reason: 'too-much-output' }
  }
  if (timedOut || exit.stopped === 'timeout' || exitBeforeCleanup?.stopped === 'timeout') return { ok: false, reason: 'timeout' }
  if (exit.stopped === 'aborted' || exitBeforeCleanup?.stopped === 'aborted') return { ok: false, reason: 'nonzero-exit' }
  if (exchange.kind === 'complete') return { ok: true, stdout: exchange.stdout }
  if (exchange.kind === 'timeout') return { ok: false, reason: 'timeout' }
  if (exchange.kind === 'exit') {
    if (exchange.exit.stopped !== undefined || exchange.exit.exitCode !== 0) return { ok: false, reason: 'nonzero-exit' }
    return { ok: false, reason: 'output-not-closed' }
  }
  if (streamError instanceof Error && streamError.name === 'ProcessStalledError') return { ok: false, reason: 'output-not-closed' }
  if (streamError !== undefined) return { ok: false, reason: 'nonzero-exit' }
  if (exchange.error instanceof ProbeFailure) {
    if (exchange.error.reason === 'output-not-closed') {
      const naturalExit = exitBeforeCleanup ?? (exit.stopped === undefined ? exit : undefined)
      if (naturalExit !== undefined && naturalExit.stopped === undefined && naturalExit.exitCode !== 0) return { ok: false, reason: 'nonzero-exit' }
    }
    return { ok: false, reason: exchange.error.reason }
  }
  return { ok: false, reason: 'malformed-output' }
}
const ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models'
const ANTHROPIC_API_VERSION = '2026-10-21'
const ANTHROPIC_PAGE_SIZE = 1000
const MAX_ANTHROPIC_MODEL_PAGES = 32
const MAX_ANTHROPIC_MODELS = 4096
const ANTHROPIC_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

type AnthropicModel = { id: string; label: string; options: { id: string; choices: string[] }[] }
/** Lists the selected account's available Claude API models without exposing credentials or partial pages. */
export async function runAnthropicModelsProbe(apiKey: string, timeoutMs: number): Promise<ModelProbeResult> {
  if (apiKey.trim() === '') return { ok: false, reason: 'could-not-start' }

  const controller = new AbortController()
  const timedOut = Promise.withResolvers<ModelProbeResult>()
  const timer = setTimeout(() => {
    controller.abort()
    timedOut.resolve({ ok: false, reason: 'timeout' })
  }, timeoutMs)
  timer.unref()

  const operation = (async (): Promise<string> => {
    const models: AnthropicModel[] = []
    const modelIds = new Set<string>()
    const cursors = new Set<string>()
    let afterId: string | null = null

    for (let pageNumber = 0; pageNumber < MAX_ANTHROPIC_MODEL_PAGES; pageNumber += 1) {
      const url = new URL(ANTHROPIC_MODELS_URL)
      url.searchParams.set('limit', String(ANTHROPIC_PAGE_SIZE))
      if (afterId !== null) url.searchParams.set('after_id', afterId)
      let response: Response
      try {
        response = await fetch(url, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${apiKey}`,
            'anthropic-version': ANTHROPIC_API_VERSION
          },
          credentials: 'omit',
          redirect: 'error',
          signal: controller.signal
        })
      } catch {
        throw new ProbeFailure(controller.signal.aborted ? 'timeout' : 'nonzero-exit', 'Anthropic model listing request failed.')
      }
      if (!response.ok) {
        try {
          await response.body?.cancel()
        } catch {}
        throw new ProbeFailure('nonzero-exit', 'Anthropic model listing request failed.')
      }

      const page = await boundedJsonResponse(response, controller, 'Anthropic')
      if (!isPlainObject(page) || !Array.isArray(page.data) || typeof page.has_more !== 'boolean' ||
        !(page.first_id === null || typeof page.first_id === 'string') ||
        !(page.last_id === null || typeof page.last_id === 'string')) {
        throw new ProbeFailure('malformed-output', 'Anthropic returned an invalid model-list page.')
      }
      if (page.data.length > ANTHROPIC_PAGE_SIZE || models.length + page.data.length > MAX_ANTHROPIC_MODELS) {
        throw new ProbeFailure('too-much-output', 'Anthropic returned too many models.')
      }
      const pageModels: AnthropicModel[] = []
      for (const value of page.data) {
        if (!isPlainObject(value) || value.type !== 'model' ||
          typeof value.id !== 'string' || value.id.trim() === '' ||
          typeof value.display_name !== 'string' || value.display_name.trim() === '' ||
          (value.lifecycle !== 'active' && value.lifecycle !== 'deprecated')) {
          throw new ProbeFailure('malformed-output', 'Anthropic returned an invalid model.')
        }
        if (modelIds.has(value.id)) throw new ProbeFailure('malformed-output', 'Anthropic returned a duplicate model.')
        modelIds.add(value.id)

        let options: { id: string; choices: string[] }[] = []
        if (value.capabilities !== null) {
          if (!isPlainObject(value.capabilities) || !isPlainObject(value.capabilities.effort) ||
            typeof value.capabilities.effort.supported !== 'boolean') {
            throw new ProbeFailure('malformed-output', 'Anthropic returned invalid model capabilities.')
          }
          const effort = value.capabilities.effort
          const choices: string[] = []
          for (const level of ANTHROPIC_EFFORT_LEVELS) {
            const capability = effort[level]
            if (level === 'xhigh' && capability === null) continue
            if (!isPlainObject(capability) || typeof capability.supported !== 'boolean') {
              throw new ProbeFailure('malformed-output', 'Anthropic returned invalid effort capabilities.')
            }
            if (effort.supported && capability.supported) choices.push(level)
          }
          if (choices.length > 0) options = [{ id: 'effort', choices }]
        }
        const model = {
          id: value.id,
          label: value.display_name,
          options
        }
        pageModels.push(model)
      }

      const firstId = pageModels[0]?.id ?? null
      const lastId = pageModels.at(-1)?.id ?? null
      if (page.first_id !== firstId || page.last_id !== lastId ||
        (afterId !== null && pageModels.length === 0) ||
        (page.has_more && (lastId === null || lastId === afterId))) {
        throw new ProbeFailure('malformed-output', 'Anthropic returned an invalid pagination cursor.')
      }
      models.push(...pageModels)
      if (Buffer.byteLength(JSON.stringify({ models }), 'utf8') > MAX_OUTPUT_BYTES) {
        throw new ProbeFailure('too-much-output', 'Anthropic model snapshot exceeded the output limit.')
      }
      if (!page.has_more) return JSON.stringify({ models })
      if (pageNumber === MAX_ANTHROPIC_MODEL_PAGES - 1 || lastId === null || cursors.has(lastId)) {
        throw new ProbeFailure('too-much-output', 'Anthropic model listing exceeded its pagination limit.')
      }
      cursors.add(lastId)
      afterId = lastId
    }
    throw new ProbeFailure('too-much-output', 'Anthropic model listing exceeded its pagination limit.')
  })()

  const result = await Promise.race([
    operation.then(
      (stdout): ModelProbeResult => ({ ok: true, stdout }),
      (error: unknown): ModelProbeResult => ({
        ok: false,
        reason: error instanceof ProbeFailure ? error.reason : controller.signal.aborted ? 'timeout' : 'nonzero-exit'
      })
    ),
    timedOut.promise
  ])
  clearTimeout(timer)
  return result
}
const GEMINI_MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models'
const GEMINI_PAGE_SIZE = 1000
const MAX_GEMINI_PAGES = 32
const MAX_GEMINI_RECORDS = 4096
const MAX_PROVIDER_MODELS = 500
const MAX_GEMINI_PAGE_TOKEN_LENGTH = 16_384
const GEMINI_API_KEY_LENGTH = 16_384

type GeminiModel = { id: string; label: string; description?: string; options: { id: string; choices: string[] }[] }

/** Lists Gemini API models using a key from an explicit prepared provider environment. */
export async function runGeminiModelsProbe(apiKey: string, timeoutMs: number): Promise<ModelProbeResult> {
  const key = apiKey.trim()
  if (key === '' || key.length > GEMINI_API_KEY_LENGTH || /[\u0000-\u001f\u007f]/.test(key)) {
    return { ok: false, reason: 'could-not-start' }
  }

  const controller = new AbortController()
  const timedOut = Promise.withResolvers<ModelProbeResult>()
  const timer = setTimeout(() => {
    controller.abort()
    timedOut.resolve({ ok: false, reason: 'timeout' })
  }, timeoutMs)
  timer.unref()

  const operation = (async (): Promise<string> => {
    const models: GeminiModel[] = []
    const modelIds = new Set<string>()
    const cursors = new Set<string>()
    let pageToken: string | null = null
    let recordCount = 0

    for (let pageNumber = 0; pageNumber < MAX_GEMINI_PAGES; pageNumber += 1) {
      const url = new URL(GEMINI_MODELS_URL)
      url.searchParams.set('pageSize', String(GEMINI_PAGE_SIZE))
      if (pageToken !== null) url.searchParams.set('pageToken', pageToken)
      let response: Response
      try {
        response = await fetch(url, {
          method: 'GET',
          headers: { Accept: 'application/json', 'x-goog-api-key': key },
          credentials: 'omit',
          redirect: 'error',
          signal: controller.signal
        })
      } catch {
        throw new ProbeFailure(controller.signal.aborted ? 'timeout' : 'nonzero-exit', 'Gemini model listing request failed.')
      }
      if (!response.ok) {
        try {
          await response.body?.cancel()
        } catch {}
        throw new ProbeFailure('nonzero-exit', 'Gemini model listing request failed.')
      }

      const page = await boundedJsonResponse(response, controller, 'Gemini')
      if (!isPlainObject(page) || !Array.isArray(page.models) ||
        Object.keys(page).some((name) => name !== 'models' && name !== 'nextPageToken')) {
        throw new ProbeFailure('malformed-output', 'Gemini returned an invalid model-list page.')
      }
      if (page.models.length > GEMINI_PAGE_SIZE || recordCount + page.models.length > MAX_GEMINI_RECORDS) {
        throw new ProbeFailure('too-much-output', 'Gemini returned too many model records.')
      }
      recordCount += page.models.length

      for (const value of page.models) {
        if (!isPlainObject(value) ||
          typeof value.name !== 'string' || !value.name.startsWith('models/') || value.name.length <= 'models/'.length ||
          typeof value.baseModelId !== 'string' || value.baseModelId.trim() === '' ||
          value.baseModelId.length > 128 || /[\u0000-\u001f\u007f]/.test(value.baseModelId) ||
          !Array.isArray(value.supportedGenerationMethods) ||
          !value.supportedGenerationMethods.every((method) => typeof method === 'string' && method.trim() !== '') ||
          new Set(value.supportedGenerationMethods).size !== value.supportedGenerationMethods.length ||
          (value.displayName !== undefined && typeof value.displayName !== 'string') ||
          (value.description !== undefined && value.description !== null && typeof value.description !== 'string')) {
          throw new ProbeFailure('malformed-output', 'Gemini returned an invalid model.')
        }
        if (!value.supportedGenerationMethods.includes('generateContent')) continue
        if (modelIds.has(value.baseModelId)) throw new ProbeFailure('malformed-output', 'Gemini returned a duplicate generation model.')
        modelIds.add(value.baseModelId)
        if (models.length >= MAX_PROVIDER_MODELS) {
          throw new ProbeFailure('too-much-output', 'Gemini returned too many generation models.')
        }
        const displayName = typeof value.displayName === 'string' && value.displayName.trim() !== ''
          ? value.displayName
          : value.baseModelId
        const description = typeof value.description === 'string' && value.description.trim() !== ''
          ? value.description
          : null
        models.push({ id: value.baseModelId, label: displayName, ...(description === null ? {} : { description }), options: [] })
      }

      if (!Object.hasOwn(page, 'nextPageToken')) {
        if (Buffer.byteLength(JSON.stringify({ models }), 'utf8') > MAX_OUTPUT_BYTES) {
          throw new ProbeFailure('too-much-output', 'Gemini model snapshot exceeded the output limit.')
        }
        return JSON.stringify({ models })
      }
      const nextPageToken = page.nextPageToken
      if (typeof nextPageToken !== 'string' || nextPageToken.trim() === '' ||
        nextPageToken.length > MAX_GEMINI_PAGE_TOKEN_LENGTH || /[\u0000-\u001f\u007f]/.test(nextPageToken) ||
        cursors.has(nextPageToken) || nextPageToken === pageToken) {
        throw new ProbeFailure('malformed-output', 'Gemini returned an invalid model-list cursor.')
      }
      if (pageNumber === MAX_GEMINI_PAGES - 1) {
        throw new ProbeFailure('too-much-output', 'Gemini model listing exceeded its pagination limit.')
      }
      cursors.add(nextPageToken)
      pageToken = nextPageToken
      if (Buffer.byteLength(JSON.stringify({ models }), 'utf8') > MAX_OUTPUT_BYTES) {
        throw new ProbeFailure('too-much-output', 'Gemini model snapshot exceeded the output limit.')
      }
    }
    throw new ProbeFailure('too-much-output', 'Gemini model listing exceeded its pagination limit.')
  })()

  const result = await Promise.race([
    operation.then(
      (stdout): ModelProbeResult => ({ ok: true, stdout }),
      (error: unknown): ModelProbeResult => ({
        ok: false,
        reason: error instanceof ProbeFailure ? error.reason : controller.signal.aborted ? 'timeout' : 'nonzero-exit'
      })
    ),
    timedOut.promise
  ])
  clearTimeout(timer)
  return result
}

const PI_MAX_MODELS = 500
const PI_THINKING_LEVELS: Record<string, true> = {
  off: true,
  minimal: true,
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true
}
type PiDiscoveredModel = { id: string; label: string; options: { id: string; choices: string[] }[] }

/** Queries Pi's declared RPC `get_available_models` operation in a bounded, sessionless process. */
export async function runPiRpcModelProbe(
  spawner: ProcessSpawner,
  argv: string[],
  timeoutMs: number,
  env: Record<string, string>,
  cwd: string
): Promise<ModelProbeResult> {
  let handle: SpawnedProcess
  try {
    handle = spawner.spawn(argv, {
      cwd, env, stdin: 'pipe', stdout: 'pipe', stderr: 'ignore', timeoutMs, killGraceMs: KILL_GRACE_MS
    })
  } catch {
    return { ok: false, reason: 'could-not-start' }
  }
  if (handle.pid === null) {
    await handle.exited.catch(() => undefined)
    return { ok: false, reason: 'could-not-start' }
  }

  const reader = handle.stdout.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let buffer = ''
  let outputBytes = 0
  let requestNumber = 0
  let streamError: unknown
  let observedExit: SpawnExit | undefined
  const exited = handle.exited.then((exit) => {
    observedExit = exit
    return exit
  })
  const send = async (message: Record<string, unknown>): Promise<void> => {
    const accepted = await handle.write(`${JSON.stringify(message)}\n`)
    if (!accepted) throw new ProbeFailure('output-not-closed', 'Pi RPC closed stdin before accepting a request.')
  }
  const readMessage = async (): Promise<Record<string, unknown> | null> => {
    for (;;) {
      const newline = buffer.indexOf('\n')
      if (newline >= 0) {
        let frame = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (frame.endsWith('\r')) frame = frame.slice(0, -1)
        if (frame === '' || Buffer.byteLength(frame, 'utf8') > MAX_OUTPUT_BYTES) {
          throw new ProbeFailure('malformed-output', 'Pi RPC returned an invalid frame.')
        }
        let value: unknown
        try {
          value = JSON.parse(frame) as unknown
        } catch {
          throw new ProbeFailure('malformed-output', 'Pi RPC returned malformed JSON.')
        }
        if (!isPlainObject(value)) throw new ProbeFailure('malformed-output', 'Pi RPC returned a non-object record.')
        return value
      }
      let chunk
      try {
        chunk = await reader.read()
      } catch (error) {
        streamError = error
        throw error
      }
      if (chunk.done) {
        try {
          buffer += decoder.decode()
        } catch {
          throw new ProbeFailure('malformed-output', 'Pi RPC returned invalid UTF-8.')
        }
        if (buffer !== '') throw new ProbeFailure('malformed-output', 'Pi RPC closed with an incomplete record.')
        return null
      }
      outputBytes += chunk.value.byteLength
      if (outputBytes > MAX_OUTPUT_BYTES) throw new ProbeFailure('too-much-output', 'Pi RPC exceeded the output limit.')
      try {
        buffer += decoder.decode(chunk.value, { stream: true })
      } catch {
        throw new ProbeFailure('malformed-output', 'Pi RPC returned invalid UTF-8.')
      }
      if (Buffer.byteLength(buffer, 'utf8') > MAX_OUTPUT_BYTES) {
        throw new ProbeFailure('too-much-output', 'Pi RPC exceeded the output limit.')
      }
    }
  }
  const request = async (type: string, params: Record<string, unknown> = {}): Promise<unknown> => {
    const id = `quirky-model-discovery-${requestNumber++}`
    await send({ id, type, ...params })
    for (;;) {
      const message = await readMessage()
      if (message === null) throw new ProbeFailure('output-not-closed', 'Pi RPC closed before completing a response.')
      if (message.type !== 'response') {
        if (Object.hasOwn(message, 'id')) throw new ProbeFailure('malformed-output', 'Pi RPC sent an unexpected correlated record.')
        continue
      }
      if (message.id !== id || message.command !== type || typeof message.success !== 'boolean') {
        throw new ProbeFailure('malformed-output', 'Pi RPC returned an unmatched response.')
      }
      if (!message.success) throw new ProbeFailure('malformed-output', `Pi RPC ${type} returned an error response.`)
      if (Object.hasOwn(message, 'error')) throw new ProbeFailure('malformed-output', 'Pi RPC returned an invalid successful response.')
      return message.data
    }
  }

  const operation = async (): Promise<{ stdout: string; exit: SpawnExit }> => {
    const available = await request('get_available_models')
    if (!isPlainObject(available) || !Array.isArray(available.models) ||
      Object.keys(available).some((name) => name !== 'models')) {
      throw new ProbeFailure('malformed-output', 'Pi RPC returned an invalid available-models response.')
    }
    if (available.models.length > PI_MAX_MODELS) {
      throw new ProbeFailure('too-much-output', 'Pi RPC returned too many models.')
    }

    const models: PiDiscoveredModel[] = []
    const modelIds = new Set<string>()
    for (const value of available.models) {
      if (!isPlainObject(value) ||
        typeof value.id !== 'string' || value.id.trim() === '' || /[\u0000-\u001f\u007f]/.test(value.id) ||
        typeof value.provider !== 'string' || value.provider.trim() === '' ||
        value.provider.includes('/') || /[\u0000-\u001f\u007f]/.test(value.provider) ||
        typeof value.name !== 'string' || value.name.trim() === '' ||
        typeof value.reasoning !== 'boolean') {
        throw new ProbeFailure('malformed-output', 'Pi RPC returned an invalid model.')
      }
      const provider = value.provider
      const modelId = value.id
      const label = value.name
      const reasoning = value.reasoning
      const id = `${provider}/${modelId}`
      if (id.length > 128) throw new ProbeFailure('malformed-output', 'Pi RPC returned an overlong model identity.')
      if (modelIds.has(id)) throw new ProbeFailure('malformed-output', 'Pi RPC returned a duplicate model identity.')
      modelIds.add(id)

      let options: PiDiscoveredModel['options'] = []
      if (reasoning) {
        const selected = await request('set_model', { provider, modelId })
        if (!isPlainObject(selected) || selected.provider !== provider || selected.id !== modelId) {
          throw new ProbeFailure('malformed-output', 'Pi RPC selected a different model identity.')
        }
        const availableLevels = await request('get_available_thinking_levels')
        if (!isPlainObject(availableLevels) || !Array.isArray(availableLevels.levels) ||
          availableLevels.levels.length === 0 ||
          !availableLevels.levels.every((level) => typeof level === 'string' && Object.hasOwn(PI_THINKING_LEVELS, level)) ||
          new Set(availableLevels.levels).size !== availableLevels.levels.length) {
          throw new ProbeFailure('malformed-output', 'Pi RPC returned invalid thinking levels.')
        }
        const choices = availableLevels.levels.filter((level): level is string => typeof level === 'string')
        if (choices.some((level) => level !== 'off')) options = [{ id: 'effort', choices }]
      }
      models.push({ id, label, options })
    }

    const stdout = JSON.stringify({ models })
    if (Buffer.byteLength(stdout, 'utf8') > MAX_OUTPUT_BYTES) {
      throw new ProbeFailure('too-much-output', 'Pi RPC model snapshot exceeded the output limit.')
    }
    void handle.closeInput().catch(() => undefined)
    for (;;) {
      const message = await readMessage()
      if (message === null) break
      if (message.type === 'response') throw new ProbeFailure('malformed-output', 'Pi RPC returned an unexpected extra response.')
    }
    return { stdout, exit: await exited }
  }

  type Exchange =
    | { kind: 'complete'; stdout: string; exit: SpawnExit }
    | { kind: 'failure'; error: unknown }
    | { kind: 'timeout' }
  let timedOut = false
  const deadline = Promise.withResolvers<Exchange>()
  const timeoutTimer = setTimeout(() => {
    timedOut = true
    void handle.stop({ graceMs: KILL_GRACE_MS })
    deadline.resolve({ kind: 'timeout' })
  }, timeoutMs)
  timeoutTimer.unref()
  const operationResult: Promise<Exchange> = operation().then(
    ({ stdout, exit }) => ({ kind: 'complete', stdout, exit }),
    (error: unknown) => ({ kind: 'failure', error })
  )
  const exchange = await Promise.race([operationResult, deadline.promise])
  clearTimeout(timeoutTimer)
  await cancelReader(reader)
  try {
    reader.releaseLock()
  } catch {
    // A pending read owns the lock until cancellation settles.
  }
  void handle.closeInput().catch(() => undefined)
  const exitBeforeCleanup = observedExit
  const exit = await handle.stop({ graceMs: KILL_GRACE_MS })
  const observed = exitBeforeCleanup ?? (exchange.kind === 'complete' ? exchange.exit : undefined)

  if (exit.spawnError || observed?.spawnError) return { ok: false, reason: 'could-not-start' }
  if (outputBytes > MAX_OUTPUT_BYTES || (exchange.kind === 'failure' && exchange.error instanceof ProbeFailure && exchange.error.reason === 'too-much-output')) {
    return { ok: false, reason: 'too-much-output' }
  }
  if (timedOut || exit.stopped === 'timeout' || observed?.stopped === 'timeout') return { ok: false, reason: 'timeout' }
  if (exit.stopped === 'aborted' || observed?.stopped !== undefined) return { ok: false, reason: 'nonzero-exit' }
  if (exchange.kind === 'complete') {
    if (exchange.exit.stopped !== undefined || exchange.exit.exitCode !== 0) return { ok: false, reason: 'nonzero-exit' }
    return { ok: true, stdout: exchange.stdout }
  }
  if (exchange.kind === 'timeout') return { ok: false, reason: 'timeout' }
  if (exchange.error instanceof ProbeFailure && exchange.error.reason === 'malformed-output') {
    return { ok: false, reason: 'malformed-output' }
  }
  if (streamError instanceof Error && streamError.name === 'ProcessStalledError') return { ok: false, reason: 'output-not-closed' }
  if (exchange.error instanceof ProbeFailure && exchange.error.reason === 'output-not-closed') {
    const naturalExit = observed ?? (exit.stopped === undefined ? exit : undefined)
    if (naturalExit !== undefined && naturalExit.stopped === undefined && naturalExit.exitCode !== 0) return { ok: false, reason: 'nonzero-exit' }
    return { ok: false, reason: 'output-not-closed' }
  }
  if (observed?.exitCode !== undefined && observed.exitCode !== 0) return { ok: false, reason: 'nonzero-exit' }
  if (streamError !== undefined) return { ok: false, reason: 'nonzero-exit' }
  if (exchange.error instanceof ProbeFailure) return { ok: false, reason: exchange.error.reason }
  return { ok: false, reason: 'malformed-output' }
}
