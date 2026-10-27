import type { CliArgs, CliContext, CliModule } from '@quirky/protocol'
import type { BrowserMethod } from './src/runtime/catalog'

const COMMAND_METHODS: Readonly<Record<string, BrowserMethod>> = {
  profileList: 'profileList', profileCreate: 'profileCreate', tabList: 'tabList', tabShow: 'tabShow', tabCurrent: 'tabCurrent',
  tabCreate: 'tabCreate', tabSwitch: 'tabSwitch', tabClose: 'tabClose', goto: 'goto', eval: 'eval', snapshot: 'snapshot',
  fill: 'fill', click: 'click', screenshot: 'screenshot', exec: 'exec'
}

const PAGE_TARGET_COMMANDS: Readonly<Record<string, true>> = {
  tabList: true, tabShow: true, tabCurrent: true, tabCreate: true, tabSwitch: true, tabClose: true,
  goto: true, eval: true, snapshot: true, fill: true, click: true, screenshot: true, exec: true
}

function camelCase(value: string): string {
  return value.replace(/-([a-z0-9])/g, (_match, char: string) => char.toUpperCase())
}

function format(value: unknown): string {
  if (typeof value === 'string') return value
  return JSON.stringify(value, null, 2)
}

async function runGeneric(id: string, args: CliArgs, context: CliContext): Promise<void> {
  const method = COMMAND_METHODS[id]
  if (!method) throw context.usage(`unknown browser command ${id}`)
  const params: Record<string, unknown> = {}
  for (const [flag, value] of Object.entries(args.flags)) {
    const key = flag === 'label' ? 'name' : camelCase(flag)
    params[key] = value
  }
  if (Object.hasOwn(PAGE_TARGET_COMMANDS, id)) params.cwd = context.cwd
  const result = await context.call(`quirky.browser/${method}`, params)
  context.out.result(result, () => format(result))
}

const commands: CliModule['commands'] = Object.create(null) as CliModule['commands']
for (const id of Object.keys(COMMAND_METHODS)) {
  commands[id] = async (args, context) => await runGeneric(id, args, context)
}

export { commands }
