import { RpcError, type AskEnvelope, type CliArgs, type CliContext, type CliModule } from '@quirky/protocol'
import { parseSpecArgument } from './cli-spec'

const POLL_MS = 60_000
const MAX_CONSECUTIVE_CONNECTION_FAILURES = 10

function positiveFlag(args: CliArgs, ctx: CliContext, name: 'timeout-ms' | 'chunk-ms'): number | undefined {
  const value = args.flags[name]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || value < 1) throw ctx.usage(`--${name} must be at least 1`)
  return value
}

function idFlag(args: CliArgs): string {
  return String(args.flags.id)
}

type WaitLimits = {
  /** Expire the ask through the daemon once this many ms have passed. */
  timeoutMs?: number
  /** Stop waiting after this many ms and print a pending envelope; the ask stays answerable. */
  chunkMs?: number
}

/**
 * Long-polls `quirky.ask/wait` until the ask reaches a terminal status, then prints the envelope as
 * one JSON line. When `timeoutMs` passes first, the ask is expired through the daemon and that
 * envelope is printed; when `chunkMs` passes first, a pending envelope pointing at `quirky ask wait`
 * is printed instead. A dropped connection is re-established and the wait continues.
 */
export async function waitForAsk(ctx: CliContext, askId: string, limits: WaitLimits = {}): Promise<void> {
  const startedAt = ctx.now()
  let failures = 0
  for (;;) {
    const elapsed = ctx.now() - startedAt
    const timeoutLeft = limits.timeoutMs === undefined ? Infinity : limits.timeoutMs - elapsed
    const chunkLeft = limits.chunkMs === undefined ? Infinity : limits.chunkMs - elapsed
    const expiring = timeoutLeft <= 0
    if (!expiring && chunkLeft <= 0) {
      ctx.out.jsonLine({ status: 'pending', askId, instruction: `quirky ask wait --id ${askId}` })
      return
    }
    let envelope: AskEnvelope
    try {
      envelope = (await (expiring
        ? ctx.call('quirky.ask/expire', { askId })
        : ctx.call('quirky.ask/wait', { askId, timeoutMs: Math.min(POLL_MS, Math.ceil(Math.min(timeoutLeft, chunkLeft))) }))) as AskEnvelope
      failures = 0
    } catch (error) {
      if (error instanceof RpcError || ++failures > MAX_CONSECUTIVE_CONNECTION_FAILURES) throw error
      await ctx.sleep(Math.min(500 * failures, 5000))
      await ctx.reconnect().catch(() => {})
      continue
    }
    if (expiring || envelope.status !== 'pending') {
      ctx.out.jsonLine(envelope)
      return
    }
  }
}

export const commands: CliModule['commands'] = {
  /** Registers an ask for the caller's session and worktree, then waits for its envelope; the daemon owns `--timeout-ms`. */
  async ask(args, ctx) {
    const spec = await parseSpecArgument(String(args.flags.spec), ctx)
    const timeoutMs = positiveFlag(args, ctx, 'timeout-ms')
    const chunkMs = positiveFlag(args, ctx, 'chunk-ms')
    const { askId } = (await ctx.call('quirky.ask/create', {
      spec,
      ...(timeoutMs === undefined ? {} : { timeoutMs })
    })) as { askId: string }
    ctx.out.jsonLine({ status: 'registered', askId })
    await waitForAsk(ctx, askId, chunkMs === undefined ? {} : { chunkMs })
  },

  async wait(args, ctx) {
    const timeoutMs = positiveFlag(args, ctx, 'timeout-ms')
    const chunkMs = positiveFlag(args, ctx, 'chunk-ms')
    await waitForAsk(ctx, idFlag(args), {
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(chunkMs === undefined ? {} : { chunkMs })
    })
  },

  async cancel(args, ctx) {
    ctx.out.jsonLine(await ctx.call('quirky.ask/cancel', { askId: idFlag(args) }))
  }
}
