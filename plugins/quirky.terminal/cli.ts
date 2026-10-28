import type { CliArgs, CliContext, CliModule, MobileTerminalState, PtySnapshot } from '@quirky/protocol'
import { paneCommands } from './src/cli/pane'
import { quickFloatingCommands } from './src/cli/quick-floating'
import { workspaceCommands } from './src/cli/workspace'
import { artifactCommands } from './src/cli/artifacts'
import type { EmulatorFrame, EmulatorListing } from './src/emulator'

function singleSessionArg(args: CliArgs, ctx: CliContext): string {
  if (args.positionals.length > 1) throw ctx.usage(`unexpected argument "${args.positionals[1]}"`)
  return sessionIdOr(args.positionals[0], ctx)
}

function noArgs(args: CliArgs, ctx: CliContext): void {
  if (args.positionals.length > 0) throw ctx.usage(`unexpected argument "${args.positionals[0]}"`)
}

function sessionIdOr(explicit: string | undefined, ctx: CliContext): string {
  const id = explicit ?? ctx.env.QUIRKY_SESSION_ID
  if (!id) throw ctx.usage('no session id; pass <sessionId> or set QUIRKY_SESSION_ID')
  return id
}
function optionalSessionParams(args: CliArgs, ctx: CliContext): { session?: string } {
  if (args.positionals.length > 1) throw ctx.usage(`unexpected argument "${args.positionals[1]}"`)
  return args.positionals[0] ? { session: args.positionals[0] } : {}
}

function terminalSize(cols: number | null, rows: number | null): string {
  return cols === null || rows === null ? 'unknown' : `${cols}x${rows}`
}

const named: CliModule['commands'] = {
  ...workspaceCommands,
  ...paneCommands,
  ...quickFloatingCommands,
  ...artifactCommands,

  async emulators(args, ctx) {
    noArgs(args, ctx)
    const listing = await ctx.call('quirky.terminal/emulators', {}) as EmulatorListing
    ctx.out.result(listing, () => listing.available
      ? listing.devices.map((device) => `${device.id}  ${device.name}  ${device.state}`).join('\n') || 'No available iOS simulators.'
      : listing.reason ?? 'iOS Simulator is unavailable.')
  },
  async 'emulator-frame'(args, ctx) {
    if (args.positionals.length !== 1) throw ctx.usage('expected one exact simulator UDID')
    const frame = await ctx.call('quirky.terminal/emulatorFrame', { device: args.positionals[0] }) as EmulatorFrame
    ctx.out.result(frame, () => `${frame.device}  ${frame.mime}  ${new Date(frame.capturedAt).toISOString()}`)
  },

  async read(args, ctx) {
    const session = singleSessionArg(args, ctx)
    const lines = args.flags.lines as number | undefined
    if (lines !== undefined && lines < 1) throw ctx.usage('--lines must be at least 1')
    const result = (await ctx.call('quirky.terminal/read', { session, ...(lines ? { lines } : {}) })) as { lines: string[] }
    ctx.out.result(result, () => result.lines.join('\n'))
  },

  async send(args, ctx) {
    const { positionals } = args
    if (positionals.length > 2) throw ctx.usage(`unexpected argument "${positionals[2]}"`)
    if (positionals.length === 0) throw ctx.usage('missing <text>')
    const implicitSession = positionals.length === 1 && ctx.env.QUIRKY_SESSION_ID
    const session = implicitSession ? (ctx.env.QUIRKY_SESSION_ID as string) : sessionIdOr(positionals[0], ctx)
    const text = implicitSession ? positionals[0] : positionals[1]
    if (text === undefined) throw ctx.usage('missing <text>')
    const enter = args.flags.enter === true
    const result = await ctx.call('quirky.terminal/send', { session, text, ...(enter ? { enter } : {}) })
    ctx.out.result(result, () => `sent to ${session}`)
  },

  async snapshot(args, ctx) {
    const session = singleSessionArg(args, ctx)
    const result = (await ctx.call('quirky.terminal/snapshot', { session })) as PtySnapshot
    // the host owns the screen model; lines 0 asks for the visible rows alone, without history
    const rows = ctx.out.json ? [] : ((await ctx.call('quirky.terminal/read', { session, lines: 0 })) as { lines: string[] }).lines
    ctx.out.result(result, () => rows.join('\n'))
  },

  async history(args, ctx) {
    const session = singleSessionArg(args, ctx)
    const { lines, before, ansi } = args.flags as { lines?: number; before?: string; ansi?: boolean }
    if (lines !== undefined && lines < 1) throw ctx.usage('--lines must be at least 1')
    const result = (await ctx.call('quirky.terminal/history', {
      session,
      ...(lines === undefined ? {} : { lines }),
      ...(before === undefined ? {} : { before }),
      ...(ansi === true ? { format: 'ansi' } : {})
    })) as { lines: string[]; cursor: string | null }
    ctx.out.result(result, () => result.lines.join('\n'))
    if (!ctx.out.json && result.cursor !== null) process.stderr.write(`next: ${result.cursor}\n`)
  },

  async sessions(args, ctx) {
    noArgs(args, ctx)
    const result = (await ctx.call('quirky.terminal/sessions', {})) as {
      sessions: { sessionId: string; state: string; shellState: string; pid: number; workspace: string }[]
    }
    ctx.out.result(result, () =>
      ctx.format.table(
        ['ID', 'STATE', 'SHELL', 'PID', 'WORKSPACE'],
        result.sessions.map((s) => [s.sessionId, s.state, s.shellState, String(s.pid), s.workspace])
      )
    )
  },

  async kill(args, ctx) {
    if (args.positionals.length > 1) throw ctx.usage(`unexpected argument "${args.positionals[1]}"`)
    const session = args.positionals[0]
    if (!session) throw ctx.usage('missing <session>')
    const result = await ctx.call('quirky.terminal/kill', { session })
    ctx.out.result(result, () => `killed ${session}`)
  },

  async 'kill-all'(args, ctx) {
    noArgs(args, ctx)
    const result = (await ctx.call('quirky.terminal/killAll', {})) as { killedCount: number }
    ctx.out.result(result, () => `killed ${result.killedCount} sessions`)
  },

  async 'restart-host'(args, ctx) {
    noArgs(args, ctx)
    const result = (await ctx.call('quirky.terminal/restartHost', {})) as { pid: number }
    ctx.out.result(result, () => `terminal host restarted (pid ${result.pid})`)
  },
  async 'mobile-state'(args, ctx) {
    const params = optionalSessionParams(args, ctx)
    const result = await ctx.call('quirky.terminal/mobileState', params) as { terminals: MobileTerminalState[] }
    ctx.out.result(result, () =>
      result.terminals.length === 0
        ? 'No phone-driven terminals.'
        : ctx.format.table(
            ['SESSION', 'STATE', 'DRIVER', 'PTY', 'DESKTOP'],
            result.terminals.map((terminal) => [
              terminal.session,
              terminal.driver ? 'driven' : 'phone-fit',
              terminal.driver?.name ?? '—',
              `${terminal.cols}x${terminal.rows}`,
              terminalSize(terminal.desktopCols, terminal.desktopRows)
            ])
          )
    )
  },

  async 'take-back'(args, ctx) {
    const params = optionalSessionParams(args, ctx)
    const result = await ctx.call('quirky.terminal/takeBack', params)
    ctx.out.result(result, () => params.session ? `took back ${params.session}` : 'took back all driven terminals')
  },

  async 'restore-fit'(args, ctx) {
    const params = optionalSessionParams(args, ctx)
    const result = await ctx.call('quirky.terminal/restoreFit', params)
    ctx.out.result(result, () => params.session ? `restored ${params.session}` : 'restored all phone-fit terminals')
  },

  async claim(args, ctx) {
    if (args.positionals.length !== 3) throw ctx.usage('expected <session> <cols> <rows>')
    const session = args.positionals[0]
    const colsText = args.positionals[1]
    const rowsText = args.positionals[2]
    if (!session || colsText === undefined || rowsText === undefined) throw ctx.usage('expected <session> <cols> <rows>')
    const cols = Number(colsText)
    const rows = Number(rowsText)
    if (!Number.isInteger(cols) || cols < 1 || cols > 1000) throw ctx.usage('<cols> must be an integer from 1 to 1000')
    if (!Number.isInteger(rows) || rows < 1 || rows > 500) throw ctx.usage('<rows> must be an integer from 1 to 500')
    const result = await ctx.call('quirky.terminal/claim', { session, cols, rows })
    ctx.out.result(result, () => `claimed ${session} at ${cols}x${rows}`)
  },
}

/** The CLI finds a command by its contribution name or by its full contribution ID; both resolve here. */
export const commands: CliModule['commands'] = {
  ...named,
  ...Object.fromEntries(Object.entries(named).map(([name, run]) => [`cli-command:quirky.terminal/${name}`, run]))
}
