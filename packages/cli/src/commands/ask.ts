import { RpcError, type AskEnvelope } from '@quirky/protocol'
import { UsageError, flagInt } from '../args'
import { parseAskSpec } from './spec'
import { requireFlag, takePositionals } from './support'
import type { Command, Context } from './types'
import type { ParsedArgs } from '../args'

const POLL_MS = 60_000
const MAX_CONSECUTIVE_CONNECTION_FAILURES = 10

function timeoutFlag(args: ParsedArgs): number | undefined {
  const value = flagInt(args, 'timeout-ms')
  if (value !== undefined && value < 1) throw new UsageError('--timeout-ms must be at least 1')
  return value
}

/**
 * Long-polls `ask.wait` until the ask reaches a terminal status or `timeoutMs` elapses, then prints
 * the envelope as one JSON line. On timeout the ask is cancelled so its card leaves the UI, and the
 * last pending envelope is printed with status `timed_out`. A dropped connection is re-established
 * and the wait continues.
 */
export async function waitForAsk(ctx: Context, askId: string, timeoutMs?: number): Promise<void> {
  const startedAt = ctx.now()
  let last: AskEnvelope = { status: 'pending', askId, answers: {}, skipped: [] }
  let failures = 0
  for (;;) {
    const remaining = timeoutMs === undefined ? Infinity : timeoutMs - (ctx.now() - startedAt)
    if (remaining <= 0) {
      await ctx.rpc.call('ask.cancel', { askId }).catch(() => {})
      ctx.out.jsonLine({ ...last, status: 'timed_out' })
      return
    }
    let envelope: AskEnvelope
    try {
      envelope = await ctx.rpc.call('ask.wait', { askId, timeoutMs: Math.min(POLL_MS, Math.ceil(remaining)) })
      failures = 0
    } catch (error) {
      if (error instanceof RpcError || ++failures > MAX_CONSECUTIVE_CONNECTION_FAILURES) throw error
      await ctx.sleep(Math.min(500 * failures, 5000))
      await ctx.rpc.reconnect().catch(() => {})
      continue
    }
    if (envelope.status !== 'pending') {
      ctx.out.jsonLine(envelope)
      return
    }
    last = envelope
  }
}

export const ask: Command = {
  name: 'ask',
  usage: 'ask --spec <json|@file> [--timeout-ms N]',
  summary: 'ask the user questions and wait for the answers (same output shape as `orca ask`); on --timeout-ms the ask is cancelled and printed as timed_out',
  flags: { spec: 'string', 'timeout-ms': 'int' },
  async run(args, ctx) {
    takePositionals(args, [])
    const spec = parseAskSpec(requireFlag(args, 'spec'), (path) => ctx.readFile(path))
    const timeoutMs = timeoutFlag(args)
    const sessionId = ctx.env.QUIRKY_SESSION_ID || undefined
    const worktreeId = ctx.env.QUIRKY_WORKTREE_ID || undefined
    const { askId } = await ctx.rpc.call('ask.create', {
      spec,
      ...(sessionId ? { sessionId } : {}),
      ...(worktreeId ? { worktreeId } : {})
    })
    ctx.out.jsonLine({ status: 'registered', askId })
    await waitForAsk(ctx, askId, timeoutMs)
  }
}

export const askWait: Command = {
  name: 'ask wait',
  usage: 'ask wait --id <askId> [--timeout-ms N]',
  summary: 'resume waiting for an ask; on --timeout-ms the ask is cancelled and printed as timed_out',
  flags: { id: 'string', 'timeout-ms': 'int' },
  async run(args, ctx) {
    takePositionals(args, [])
    const askId = requireFlag(args, 'id')
    await waitForAsk(ctx, askId, timeoutFlag(args))
  }
}

export const askCancel: Command = {
  name: 'ask cancel',
  usage: 'ask cancel --id <askId>',
  summary: 'cancel a pending ask and print its envelope',
  flags: { id: 'string' },
  async run(args, ctx) {
    takePositionals(args, [])
    const envelope = await ctx.rpc.call('ask.cancel', { askId: requireFlag(args, 'id') })
    ctx.out.jsonLine(envelope)
  }
}
