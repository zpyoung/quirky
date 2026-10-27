import type { CliArgs, CliContext, CliModule } from '@quirky/protocol'
import type { DockState } from './src/types'

const methodByCommand: Record<string, string> = {
  get: 'quirky.terminal-dock/get',
  list: 'quirky.terminal-dock/list',
  set: 'quirky.terminal-dock/set',
  report: 'quirky.terminal-dock/report',
  history: 'quirky.terminal-dock/history',
  pick: 'quirky.terminal-dock/pick',
  attach: 'quirky.terminal-dock/attach',
  'remove-attachment': 'quirky.terminal-dock/removeAttachment',
  send: 'quirky.terminal-dock/send',
  cancel: 'quirky.terminal-dock/cancel',
  interaction: 'quirky.terminal-dock/interaction',
  options: 'quirky.terminal-dock/options',
  driver: 'quirky.terminal-dock/driver'
}

function paramName(flag: string): string {
  return flag.replace(/-([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase())
}

async function callMethod(name: string, args: CliArgs, context: CliContext): Promise<void> {
  if (args.positionals.length > 0) throw context.usage(`unexpected argument "${args.positionals[0]}"`)
  const params = Object.fromEntries(Object.entries(args.flags).map(([flag, value]) => [paramName(flag), value]))
  const result = await context.call(methodByCommand[name]!, params)
  context.out.result(result, () => (typeof result === 'string' ? result : JSON.stringify(result, null, 2)))
}

const generated: CliModule['commands'] = Object.fromEntries(
  Object.entries(methodByCommand).map(([name]) => [name, (args: CliArgs, context: CliContext) => callMethod(name, args, context)])
)

export const commands: CliModule['commands'] = {
  ...generated,
  async toggle(args, context) {
    const pane = args.flags.pane
    if (typeof pane !== 'string' || pane.length === 0) throw context.usage('missing --pane')
    const current = (await context.call('quirky.terminal-dock/get', { pane })) as DockState
    const state = (await context.call('quirky.terminal-dock/set', { pane, docked: !current.docked })) as DockState
    context.out.result(state, () => `${state.docked ? 'opened' : 'closed'} dock for ${pane}`)
  }
}
