import { RpcError, RpcErrorCode, type CliArgs, type CliContext, type CliModule } from '@quirky/protocol'
import { readSpecArgument } from './cli-spec'
import { catalogGuide } from './src/core/catalog'

const NO_SESSION = 'quirky view works only inside a Quirky agent session'
const POLL_MS = 60_000
const MAX_CONSECUTIVE_CONNECTION_FAILURES = 10

const USAGE = `usage:
  quirky view open --spec @file.json [--placement inline|pane]   prints {"viewId": ...}
  quirky view update --id <viewId> --spec @file.json
  quirky view close --id <viewId>
  quirky view wait --id <viewId> [--timeout-ms N]                prints {"action": ...} or {"status":"timeout"}
  quirky view --help

Draw a view from a fixed catalog of components. The spec is checked before anything renders; a
refused spec prints its errors and exits 2, so fix it and run the command again. A button or field in
the view sends an action: it is the result of a pending \`quirky view wait\`, or else it arrives as a
follow-up message.`

/** The usage and the component catalog: everything an agent needs to draw a view. */
export function helpText(): string {
  return `${USAGE}\n\n${catalogGuide()}`
}

function requireSession(ctx: CliContext): void {
  if (!ctx.env.QUIRKY_SESSION_ID || !ctx.env.QUIRKY_SESSION_TOKEN) throw ctx.fail(NO_SESSION)
}

function idFlag(args: CliArgs): string {
  return String(args.flags.id)
}

/** Calls a view method; a refusal for bad input is a usage error, which the CLI reports with exit code 2. */
async function call(ctx: CliContext, method: string, params: Record<string, unknown>): Promise<unknown> {
  try {
    return await ctx.call(method, params)
  } catch (error) {
    if (error instanceof RpcError && error.code === RpcErrorCode.InvalidParams) throw ctx.usage(error.message)
    throw error
  }
}

function positiveFlag(args: CliArgs, ctx: CliContext, name: string): number | undefined {
  const value = args.flags[name]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || value < 1) throw ctx.usage(`--${name} must be at least 1`)
  return value
}

/**
 * Long-polls `quirky.view/wait` and prints the first action, or `{status: "timeout"}` once
 * `timeoutMs` passes. A dropped connection is re-established and the wait continues; a closed view
 * ends the wait with `{status: "closed"}`.
 */
export async function waitForAction(ctx: CliContext, viewId: string, timeoutMs?: number): Promise<void> {
  const startedAt = ctx.now()
  let failures = 0
  for (;;) {
    const left = timeoutMs === undefined ? Infinity : timeoutMs - (ctx.now() - startedAt)
    if (left <= 0) {
      ctx.out.jsonLine({ status: 'timeout' })
      return
    }
    let result: { action?: unknown; status?: string }
    try {
      result = (await ctx.call('quirky.view/wait', { viewId, timeoutMs: Math.min(POLL_MS, Math.ceil(left)) })) as typeof result
      failures = 0
    } catch (error) {
      if (error instanceof RpcError || ++failures > MAX_CONSECUTIVE_CONNECTION_FAILURES) throw error
      await ctx.sleep(Math.min(500 * failures, 5000))
      await ctx.reconnect().catch(() => {})
      continue
    }
    if (result.status === 'timeout') continue
    ctx.out.jsonLine(result)
    return
  }
}

/** The subcommand usage and component catalog, appended to `quirky view --help`. */
export const help: NonNullable<CliModule['help']> = {
  view: helpText()
}

export const commands: CliModule['commands'] = {
  /** Prints the usage and the component catalog. */
  async view(_args, ctx) {
    ctx.out.line(helpText())
  },

  /** Opens a view for the caller's session and prints its ID; the daemon checks the spec. */
  async 'view-open'(args, ctx) {
    requireSession(ctx)
    const spec = await readSpecArgument(String(args.flags.spec), ctx)
    const placement = args.flags.placement
    const { viewId } = (await call(ctx, 'quirky.view/open', { spec, ...(placement === undefined ? {} : { placement }) })) as { viewId: string }
    ctx.out.jsonLine({ viewId })
  },

  async 'view-update'(args, ctx) {
    requireSession(ctx)
    const spec = await readSpecArgument(String(args.flags.spec), ctx)
    await call(ctx, 'quirky.view/update', { viewId: idFlag(args), spec })
    ctx.out.jsonLine({ viewId: idFlag(args) })
  },

  async 'view-close'(args, ctx) {
    requireSession(ctx)
    await call(ctx, 'quirky.view/close', { viewId: idFlag(args) })
    ctx.out.jsonLine({ viewId: idFlag(args), closed: true })
  },

  async 'view-wait'(args, ctx) {
    requireSession(ctx)
    await waitForAction(ctx, idFlag(args), positiveFlag(args, ctx, 'timeout-ms'))
  }
}
