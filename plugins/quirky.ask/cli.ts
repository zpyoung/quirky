import { RpcError, type AskEnvelope, type CliArgs, type CliContext, type CliModule } from '@quirky/protocol'
import { parseSpecArgument } from './cli-spec'

const POLL_MS = 60_000
const MAX_CONSECUTIVE_CONNECTION_FAILURES = 10

function timeoutFlag(args: CliArgs, ctx: CliContext): number | undefined {
  const value = args.flags['timeout-ms']
  if (value === undefined) return undefined
  if (typeof value !== 'number' || value < 1) throw ctx.usage('--timeout-ms must be at least 1')
  return value
}

function idFlag(args: CliArgs): string {
  return String(args.flags.id)
}

/**
 * Long-polls `quirky.ask/wait` until the ask reaches a terminal status or `timeoutMs` elapses, then
 * prints the envelope as one JSON line. On timeout the ask is cancelled so its card leaves the UI,
 * and the last pending envelope is printed with status `timed_out`. A dropped connection is
 * re-established and the wait continues.
 */
export async function waitForAsk(ctx: CliContext, askId: string, timeoutMs?: number): Promise<void> {
  const startedAt = ctx.now()
  let last: AskEnvelope = { status: 'pending', askId, answers: {}, skipped: [] }
  let failures = 0
  for (;;) {
    const remaining = timeoutMs === undefined ? Infinity : timeoutMs - (ctx.now() - startedAt)
    if (remaining <= 0) {
      await ctx.call('quirky.ask/cancel', { askId }).catch(() => {})
      ctx.out.jsonLine({ ...last, status: 'timed_out' })
      return
    }
    let envelope: AskEnvelope
    try {
      envelope = (await ctx.call('quirky.ask/wait', {
        askId,
        timeoutMs: Math.min(POLL_MS, Math.ceil(remaining))
      })) as AskEnvelope
      failures = 0
    } catch (error) {
      if (error instanceof RpcError || ++failures > MAX_CONSECUTIVE_CONNECTION_FAILURES) throw error
      await ctx.sleep(Math.min(500 * failures, 5000))
      await ctx.reconnect().catch(() => {})
      continue
    }
    if (envelope.status !== 'pending') {
      ctx.out.jsonLine(envelope)
      return
    }
    last = envelope
  }
}

export const commands: CliModule['commands'] = {
  /** Registers an ask for the caller's session and worktree, then waits for its envelope. */
  async ask(args, ctx) {
    const spec = await parseSpecArgument(String(args.flags.spec), ctx)
    const timeoutMs = timeoutFlag(args, ctx)
    const { askId } = (await ctx.call('quirky.ask/create', { spec })) as { askId: string }
    ctx.out.jsonLine({ status: 'registered', askId })
    await waitForAsk(ctx, askId, timeoutMs)
  },

  async wait(args, ctx) {
    await waitForAsk(ctx, idFlag(args), timeoutFlag(args, ctx))
  },

  async cancel(args, ctx) {
    ctx.out.jsonLine(await ctx.call('quirky.ask/cancel', { askId: idFlag(args) }))
  }
}
