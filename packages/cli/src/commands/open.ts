import { takePositionals } from '../args'
import { ConnectionLostError, DaemonUnavailableError } from '../link'
import type { Command, Context } from './types'

const READY_TIMEOUT_MS = 15_000
const POLL_INTERVAL_MS = 100

class ReadinessDeadlineExceeded extends Error {
  constructor() {
    super('Quirky desktop did not become ready within 15 seconds')
    this.name = 'ReadinessDeadlineExceeded'
  }
}

function isRecoverableConnectionFailure(error: unknown): error is DaemonUnavailableError | ConnectionLostError {
  return error instanceof DaemonUnavailableError || error instanceof ConnectionLostError
}

async function hasConnectedDesktop(ctx: Context): Promise<boolean> {
  const status = await ctx.rpc.call('status.get', {})
  return status.clients.some((client) => client.role === 'desktop')
}

function withReadinessDeadline<T>(
  operation: () => Promise<T>,
  deadline: number,
  ctx: Context,
  onTimeout?: () => void
): Promise<T> {
  const remaining = deadline - ctx.now()
  if (remaining <= 0) {
    onTimeout?.()
    ctx.rpc.close()
    throw new ReadinessDeadlineExceeded()
  }

  const pending = Promise.resolve().then(operation)
  const expire = () => {
    onTimeout?.()
    ctx.rpc.close()
    void pending.then(
      () => ctx.rpc.close(),
      () => ctx.rpc.close()
    )
    return new ReadinessDeadlineExceeded()
  }
  let timer: ReturnType<typeof setTimeout>
  const { promise: timeout, reject } = Promise.withResolvers<never>()
  timer = setTimeout(() => reject(expire()), remaining)

  return Promise.race([pending, timeout])
    .then((value) => {
      if (ctx.now() >= deadline) throw expire()
      return value
    })
    .finally(() => clearTimeout(timer))
}

export const open: Command = {
  name: 'open',
  summary: 'wait up to 15 seconds for a connected desktop-role client, launching the app if needed',
  positionals: [],
  flags: {},
  methods: ['status.get'],
  plugin: null,
  async run(args, ctx) {
    takePositionals(args, [])
    if (ctx.platform !== undefined && ctx.platform !== 'darwin') {
      throw new Error('`quirky open` is only supported on macOS')
    }

    const deadline = ctx.now() + READY_TIMEOUT_MS
    let reconnect = false
    try {
      if (await withReadinessDeadline(() => hasConnectedDesktop(ctx), deadline, ctx)) {
        ctx.out.result({ ready: true }, () => 'Quirky desktop is ready')
        return
      }
    } catch (error) {
      if (!isRecoverableConnectionFailure(error)) throw error
      reconnect = true
    }

    const launchAbort = new AbortController()
    const launch = await withReadinessDeadline(
      () => ctx.openDesktopApp(launchAbort.signal),
      deadline,
      ctx,
      () => launchAbort.abort()
    )
    if (!launch.ok) throw new Error(launch.reason)

    while (ctx.now() < deadline) {
      try {
        const ready = await withReadinessDeadline(async () => {
          if (reconnect) {
            await ctx.rpc.reconnect()
            reconnect = false
          }
          return hasConnectedDesktop(ctx)
        }, deadline, ctx)
        if (ready) {
          ctx.out.result({ ready: true }, () => 'Quirky desktop is ready')
          return
        }
      } catch (error) {
        if (!isRecoverableConnectionFailure(error)) throw error
        reconnect = true
      }

      const remaining = deadline - ctx.now()
      if (remaining <= 0) break
      await ctx.sleep(Math.min(POLL_INTERVAL_MS, remaining))
    }

    throw new ReadinessDeadlineExceeded()
  }
}
