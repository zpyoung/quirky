import type { CliArgs, CliContext, CliModule } from '@quirky/protocol'

type Flags = CliArgs['flags']
type CommandArgs = { positionals: string[]; flags: Flags }

function optionalString(args: CommandArgs, ctx: CliContext, name: string): string | undefined {
  const value = args.flags[name]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw ctx.usage(`--${name} must be a string`)
  return value
}

function requiredPositional(args: CommandArgs, ctx: CliContext, label: string, index = 0): string {
  const value = args.positionals[index]
  if (value === undefined) throw ctx.usage(`missing <${label}>`)
  return value
}

function jsonResult(ctx: CliContext, value: unknown): void {
  ctx.out.result(value, () => JSON.stringify(value, null, 2) ?? 'null')
}

async function jsonFlag(args: CommandArgs, ctx: CliContext, name: string): Promise<unknown> {
  const raw = optionalString(args, ctx, name)
  if (raw === undefined) throw ctx.usage(`missing --${name}`)
  let text: string
  try {
    text = raw.startsWith('@') ? await ctx.readFile(raw.slice(1)) : raw
  } catch (error) {
    throw ctx.fail(`could not read --${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw ctx.usage(`--${name} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function invokeAction(id: string, args: CommandArgs, ctx: CliContext, selectSession = true): Promise<void> {
  const session = selectSession ? optionalString(args, ctx, 'session') : undefined
  const result = await ctx.call('ui.command.run', {
    id: `command:quirky.session-info/${id}`,
    ...(session === undefined ? {} : { args: { session } })
  })
  jsonResult(ctx, result)
}

export const commands: CliModule['commands'] = {
  async get(args, ctx) {
    const session = optionalString(args, ctx, 'session')
    const result = await ctx.call('quirky.session-info/get', session === undefined ? {} : { session })
    jsonResult(ctx, result)
  },

  async sections(args, ctx) {
    const value = args.flags.open
    const open = value === undefined ? undefined : Array.isArray(value) ? value : [value]
    if (open?.some((entry) => typeof entry !== 'string')) throw ctx.usage('--open must name a section')
    const result = await ctx.call('quirky.session-info/sections', open === undefined ? {} : { open })
    jsonResult(ctx, result)
  },

  async inspect(args, ctx) {
    const session = optionalString(args, ctx, 'session')
    const result = await ctx.call('quirky.session-info/inspect', session === undefined ? {} : { session })
    jsonResult(ctx, result)
  },

  async telemetry(args, ctx) {
    const session = requiredPositional(args, ctx, 'session')
    const payload = await jsonFlag(args, ctx, 'payload')
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) throw ctx.usage('--payload must be a JSON object')
    const result = await ctx.call('quirky.session-info/telemetry', { session, payload })
    jsonResult(ctx, result)
  },

  async 'enable-telemetry'(args, ctx) {
    const session = optionalString(args, ctx, 'session')
    const enabled = args.flags.enabled
    if (enabled !== undefined && typeof enabled !== 'boolean') throw ctx.usage('--enabled must be a boolean')
    const result = await ctx.call('quirky.session-info/enableTelemetry', {
      ...(session === undefined ? {} : { session }),
      ...(enabled === undefined ? {} : { enabled })
    })
    jsonResult(ctx, result)
  },

  async history(args, ctx) {
    const query = optionalString(args, ctx, 'query')
    const result = await ctx.call('quirky.session-info/history', query === undefined ? {} : { query })
    jsonResult(ctx, result)
  },

  async transcript(args, ctx) {
    const session = requiredPositional(args, ctx, 'session')
    const result = await ctx.call('quirky.session-info/transcript', { session })
    jsonResult(ctx, result)
  },

  async 'resume-command'(args, ctx) {
    const session = requiredPositional(args, ctx, 'session')
    const result = await ctx.call('quirky.session-info/resumeCommand', { session, ...(args.flags.fork === true ? { fork: true } : {}) })
    jsonResult(ctx, result)
  },

  async open(args, ctx) {
    await invokeAction('open', args, ctx, false)
  },
  async 'copy-id'(args, ctx) {
    await invokeAction('copy-id', args, ctx)
  },
  async 'open-history'(args, ctx) {
    await invokeAction('open-history', args, ctx)
  },
  async 'focus-pane'(args, ctx) {
    await invokeAction('focus-pane', args, ctx)
  },
  async 'open-transcript'(args, ctx) {
    await invokeAction('open-transcript', args, ctx)
  },
  async 'reveal-transcript'(args, ctx) {
    await invokeAction('reveal-transcript', args, ctx)
  },
  async resume(args, ctx) {
    await invokeAction('resume', args, ctx)
  },
  async fork(args, ctx) {
    await invokeAction('fork', args, ctx)
  },
  async 'copy-resume-command'(args, ctx) {
    await invokeAction('copy-resume-command', args, ctx)
  }
}
