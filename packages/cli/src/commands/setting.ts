import type { SettingInfo } from '@quirky/protocol'
import { flagString } from '../args'
import { formatTable } from '../output'
import { takePositionals } from './support'
import type { Command } from './types'

/** The value cell: the current value as JSON, with the stored value called out when it no longer fits. */
function valueCell(setting: SettingInfo): string {
  const shown = JSON.stringify(setting.value)
  if (setting.stored && !setting.stored.valid) {
    return `${shown} (stored ${JSON.stringify(setting.stored.value)} is invalid)`
  }
  return shown
}

/** Reads `<value>` as JSON when it parses (`16`, `true`, `"16"`), else as the literal string (`grid`). */
function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

export const settingList: Command = {
  name: 'setting list',
  usage: 'setting list [--plugin <id>]',
  summary: 'list settings with their value and default',
  flags: { plugin: 'string' },
  async run(args, ctx) {
    takePositionals(args, [])
    const pluginId = flagString(args, 'plugin')
    const settings = await ctx.rpc.call('setting.list', pluginId ? { pluginId } : {})
    ctx.out.result(settings, () =>
      settings.length
        ? formatTable(
            ['ID', 'TYPE', 'VALUE', 'DEFAULT'],
            settings.map((s) => [s.id, s.type, valueCell(s), JSON.stringify(s.default)])
          )
        : 'no settings'
    )
  }
}

export const settingGet: Command = {
  name: 'setting get',
  usage: 'setting get <id>',
  summary: 'print a setting value as JSON',
  flags: {},
  async run(args, ctx) {
    const [id] = takePositionals(args, ['id'])
    const setting = await ctx.rpc.call('setting.get', { id })
    ctx.out.result(setting, () => JSON.stringify(setting.value))
  }
}

export const settingSet: Command = {
  name: 'setting set',
  usage: 'setting set <id> <value>',
  summary: 'set a setting; <value> is read as JSON when it parses, else as a string',
  flags: {},
  async run(args, ctx) {
    const [id, raw] = takePositionals(args, ['id', 'value'])
    const setting = await ctx.rpc.call('setting.set', { id, value: parseValue(raw) })
    ctx.out.result(setting, () => JSON.stringify(setting.value))
  }
}

export const settingReset: Command = {
  name: 'setting reset',
  usage: 'setting reset <id>',
  summary: 'drop the stored value and print the default as JSON',
  flags: {},
  async run(args, ctx) {
    const [id] = takePositionals(args, ['id'])
    const setting = await ctx.rpc.call('setting.reset', { id })
    ctx.out.result(setting, () => JSON.stringify(setting.value))
  }
}
