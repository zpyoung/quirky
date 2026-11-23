import { RpcError, RpcErrorCode, type CliArgs, type CliContext, type CliModule } from '@quirky/protocol'
import { readSpecArgument } from './cli-spec'
import { catalogGuide } from './src/core/catalog'

const NO_SESSION = 'quirky view works only inside a Quirky agent session'
const POLL_MS = 60_000
const MAX_CONSECUTIVE_CONNECTION_FAILURES = 10

const USAGE = `usage:
  quirky view open --spec @file.json [--placement inline|pane]   prints {"viewId": ...}
  quirky view update --id <viewId> --spec @file.json             makes the spec the next version
  quirky view patch --id <viewId> --ops <json|@file>             prints {"viewId": ..., "version": N}
  quirky view get --id <viewId> [--at-version N]                 prints {"viewId","title","version","latestVersion","spec"}
  quirky view close --id <viewId>
  quirky view done --id <viewId> [--undo]                        marks the visual's work as over; updating it later makes it live again
  quirky view wait --id <viewId> [--timeout-ms N]                prints {"action": ...} or {"status":"timeout"}
  quirky view --help

Draw a view from a fixed catalog of components. The spec is checked before anything renders; a
refused spec prints its errors and exits 2, so fix it and run the command again. A button or field in
the view sends an action: it is the result of a pending \`quirky view wait\`, or else it arrives as a
follow-up message.

Every open, update and patch is a version the user can step back to. A refused one is not a version,
and the last good one stays on screen. Change a small part with \`patch\`: --ops is a JSON array of
{"op": "add"|"replace"|"remove", "path": "/root/children/0/props/text", "value": ...} using JSON Pointer
paths ("-" appends to an array, "~1" stands for "/" and "~0" for "~"), at most 200 ops, applied all or
nothing. When a message points at a view and version, \`get\` loads it (--at-version N for an older one),
so you can patch from what the user saw. If the window cannot draw a version, you get a message saying
so: fix it with update or patch.`

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

  /** Applies RFC 6902 ops to the view's latest spec; a refusal is a usage error, so it exits 2. */
  async 'view-patch'(args, ctx) {
    requireSession(ctx)
    const ops = await readSpecArgument(String(args.flags.ops), ctx, '--ops')
    const { version } = (await call(ctx, 'quirky.view/patch', { viewId: idFlag(args), ops })) as { version: number }
    ctx.out.jsonLine({ viewId: idFlag(args), version })
  },

  /** Prints a view at its latest version, or at `--at-version`, for an agent reloading a visual it was pointed at. */
  async 'view-get'(args, ctx) {
    requireSession(ctx)
    const version = positiveFlag(args, ctx, 'at-version')
    const record = (await call(ctx, 'quirky.view/get', { viewId: idFlag(args), ...(version === undefined ? {} : { version }) })) as {
      viewId: string
      title: string
      version: number
      latestVersion: number
      spec: unknown
    }
    ctx.out.jsonLine({ viewId: record.viewId, title: record.title, version: record.version, latestVersion: record.latestVersion, spec: record.spec })
  },

  async 'view-close'(args, ctx) {
    requireSession(ctx)
    await call(ctx, 'quirky.view/close', { viewId: idFlag(args) })
    ctx.out.jsonLine({ viewId: idFlag(args), closed: true })
  },

  /** Marks a view's work as over, or live again with `--undo`; prints nothing on success. */
  async 'view-done'(args, ctx) {
    requireSession(ctx)
    await call(ctx, 'quirky.view/done', { viewId: idFlag(args), done: args.flags.undo !== true })
  },

  async 'view-wait'(args, ctx) {
    requireSession(ctx)
    await waitForAction(ctx, idFlag(args), positiveFlag(args, ctx, 'timeout-ms'))
  }
}
