import { createHash, randomUUID } from 'node:crypto'
import {
  KERNEL_METHOD_SCHEMAS,
  RpcError,
  RpcErrorCode,
  type CallOptions,
  type AskEnvelope,
  type MethodName,
  type ParamsOf,
  type QuirkyClient,
  type ResultOf
} from '@quirky/protocol'

/** The CLI could not reach (or start) the daemon; the message is the connection failure's. */
export class DaemonUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DaemonUnavailableError'
  }
}

/** Every attempt to get a reply was lost; `base` is the request-ID base that `--retry-request` takes. */
export class ConnectionLostError extends Error {
  constructor(readonly base: string) {
    super(`connection lost; rerun with --retry-request ${base}`)
    this.name = 'ConnectionLostError'
  }
}

/**
 * What commands use to reach the daemon. `reconnect` replaces a dropped connection; `call` always
 * goes to the current one. `callAny` reaches methods the CLI has no static types for, such as plugin methods.
 */
export interface DaemonLink {
  readonly requestBase: string
  call<M extends MethodName>(method: M, params: ParamsOf<M>, options?: CallOptions): Promise<ResultOf<M>>
  callAny(method: string, params: Record<string, unknown>, options?: CallOptions): Promise<unknown>
  reconnect(): Promise<void>
  close(): void
}

export type DaemonLinkOptions = {
  /** The request-ID base (`--retry-request`); a fresh UUID when absent. */
  requestBase?: string
  /** Adds `yes: true` to calls of destructive methods. */
  yes?: boolean
  /** Names destructive methods beyond the kernel's and the ones `api.describe` reported through this link. */
  isDestructive?: (method: string) => boolean
  /** Receives the notice printed while a confirmation is pending. */
  stderr?: (text: string) => void
}

/** Longest `--retry-request` value, so every request ID stays within the daemon's 128-character limit. */
export const MAX_REQUEST_BASE = 64

const MAX_RESENDS = 2
const ASK_WAIT_MS = 60_000

const isConnectionLost = (error: unknown) => error instanceof Error && error.name === 'ConnectionLost'

/**
 * Connects on first use, so commands that fail validation or print help never touch the daemon.
 * Calls without an explicit transport ID use `<base>:<method-hash>#<k>`; each selected ID is
 * reused across connection-loss resends, while confirmation retries use a fresh ID.
 */
export function createDaemonLink(connect: () => Promise<QuirkyClient>, options: DaemonLinkOptions = {}): DaemonLink {
  const base = options.requestBase ?? randomUUID()
  const counts = new Map<string, number>()
  const destructive = new Set<string>()
  let current: Promise<QuirkyClient> | null = null

  const get = () =>
    (current ??= connect().catch((error) => {
      throw new DaemonUnavailableError(error instanceof Error ? error.message : String(error))
    }))

  const reconnect = async () => {
    const previous = current
    current = null
    if (previous) (await previous.catch(() => null))?.close()
    await get()
  }

  const needsYes = (method: string) =>
    options.yes === true && (isKernelDestructive(method) || destructive.has(method) || options.isDestructive?.(method) === true)

  const nextRequestId = (method: string) => {
    const k = (counts.get(method) ?? 0) + 1
    counts.set(method, k)
    return `${base}:${createHash('sha256').update(method).digest('hex').slice(0, 12)}#${k}`
  }

  const attempt = async (
    method: string,
    params: Record<string, unknown>,
    callOptions?: CallOptions
  ): Promise<unknown> => {
    const requestId = callOptions?.requestId ?? nextRequestId(method)
    for (let resends = 0; ; resends++) {
      try {
        const client = await get()
        return await client.callAny(method, params, {
          requestId,
          ...(callOptions?.timeoutMs === undefined ? {} : { timeoutMs: callOptions.timeoutMs })
        })
      } catch (error) {
        if (!isConnectionLost(error)) throw error
        if (resends >= MAX_RESENDS) throw new ConnectionLostError(base)
        // the daemon may have run the call, so an unreachable daemon here still owes the user the base
        await reconnect().catch(() => {
          throw new ConnectionLostError(base)
        })
      }
    }
  }

  const awaitAnswer = async (askId: string): Promise<AskEnvelope> => {
    for (;;) {
      try {
        const client = await get()
        const envelope = (await client.callAny('quirky.ask/wait', { askId, timeoutMs: ASK_WAIT_MS })) as AskEnvelope
        if (envelope.status !== 'pending') return envelope
      } catch (error) {
        if (!isConnectionLost(error)) throw error
        await reconnect()
      }
    }
  }

  const invoke = async (
    method: string,
    params: Record<string, unknown>,
    callOptions?: CallOptions
  ): Promise<unknown> => {
    const sent = needsYes(method) ? { ...params, yes: true } : params
    let result: unknown
    try {
      result = await attempt(method, sent, callOptions)
    } catch (error) {
      const pending = confirmationOf(error)
      if (!pending) throw error
      options.stderr?.(`confirm in Quirky: ${pending.action} (ask ${pending.askId}); or rerun with --yes\n`)
      const envelope = await awaitAnswer(pending.askId)
      if (envelope.status === 'declined') throw new RpcError(RpcErrorCode.Conflict, 'declined')
      const confirmationOptions = callOptions?.requestId === undefined
        ? callOptions
        : { ...callOptions, requestId: randomUUID() }
      return attempt(method, { ...sent, confirmation: pending.askId }, confirmationOptions)
    }
    if (method === 'api.describe') learnDestructive(result)
    return result
  }

  const learnDestructive = (description: unknown) => {
    const methods = (description as { methods?: { name: string; destructive?: boolean }[] } | null)?.methods
    for (const entry of methods ?? []) if (entry.destructive) destructive.add(entry.name)
  }

  return {
    requestBase: base,
    call: (method, params, callOptions) => invoke(method, params as Record<string, unknown>, callOptions) as Promise<never>,
    callAny: (method, params, callOptions) => invoke(method, params, callOptions),
    reconnect,
    close() {
      void current?.then((client) => client.close()).catch(() => {})
    }
  }
}

function isKernelDestructive(method: string): boolean {
  if (!Object.hasOwn(KERNEL_METHOD_SCHEMAS, method)) return false
  return Boolean((KERNEL_METHOD_SCHEMAS as Record<string, { destructive?: unknown }>)[method].destructive)
}

function confirmationOf(error: unknown): { askId: string; action: string } | null {
  if (!(error instanceof RpcError) || error.code !== RpcErrorCode.ConfirmationRequired) return null
  const data = error.data as { askId?: unknown; action?: unknown } | undefined
  return typeof data?.askId === 'string' ? { askId: data.askId, action: String(data.action ?? 'confirm the action') } : null
}
