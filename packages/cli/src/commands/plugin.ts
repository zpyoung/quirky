import type { ContributionInfo } from '@quirky/protocol'
import { flagBoolean, flagString } from '../args'
import { formatRecord, formatTable } from '../output'
import { takePositionals } from './support'
import type { Command } from './types'

function contributionStatus(item: ContributionInfo): string {
  switch (item.status) {
    case 'effective':
      return 'effective'
    case 'overridden':
      return `overridden by ${item.overriddenBy ?? '-'}`
    case 'rejected':
      return `rejected (conflicts with ${item.conflictWith ?? '-'})`
    case 'disabled':
      if (item.disabledBy === 'owner') return 'disabled (owner disabled)'
      if (item.disabledBy === 'plugin') return `disabled by ${item.disablingPlugin ?? '-'}`
      return 'disabled by user'
  }
}

/** Keeps a cell on one line so an embedded line break can't split a table row. */
function singleLine(text: string): string {
  return text.replace(/\r\n|\r|\n/g, '\\n')
}

export const pluginList: Command = {
  name: 'plugin list',
  summary: 'list plugins with their state and diagnostics',
  positionals: [],
  flags: {},
  methods: ['plugin.list'],
  plugin: null,
  async run(args, ctx) {
    takePositionals(args, [])
    const plugins = await ctx.rpc.call('plugin.list', {})
    ctx.out.result(plugins, () => {
      if (!plugins.length) return 'no plugins'
      const [header, ...rows] = formatTable(
        ['ID', 'STATE', 'SOURCE', 'VERSION'],
        plugins.map((p) => [p.id, p.state, p.source, p.version].map(singleLine))
      ).split('\n')
      return [
        header,
        ...plugins.flatMap((plugin, index) => [
          rows[index],
          ...plugin.diagnostics.map((d) => `  ${singleLine(d.level)}: ${singleLine(d.message)}`)
        ])
      ].join('\n')
    })
  }
}

export const pluginContributions: Command = {
  name: 'plugin contributions',
  summary: 'list contributions; --all includes overridden, disabled and rejected ones',
  positionals: [],
  flags: {
    kind: { type: 'string', description: 'only this contribution kind' },
    plugin: { type: 'string', description: 'only this plugin' },
    all: { type: 'boolean', description: 'include overridden, disabled and rejected contributions' }
  },
  methods: ['plugin.contributions'],
  plugin: null,
  async run(args, ctx) {
    takePositionals(args, [])
    const kind = flagString(args, 'kind')
    const pluginId = flagString(args, 'plugin')
    const all = flagBoolean(args, 'all')
    const items = await ctx.rpc.call('plugin.contributions', {
      ...(kind ? { kind } : {}),
      ...(pluginId ? { pluginId } : {}),
      ...(all ? { all } : {})
    })
    ctx.out.result(items, () =>
      items.length
        ? formatTable(
            all ? ['ID', 'PLUGIN', 'STATUS'] : ['ID', 'PLUGIN'],
            items.map((item) => (all ? [item.id, item.plugin, contributionStatus(item)] : [item.id, item.plugin]))
          )
        : 'no contributions'
    )
  }
}

export const pluginEnable: Command = {
  name: 'plugin enable',
  summary: 'clear the disable on a plugin or contribution',
  positionals: [{ name: 'id', description: 'plugin or contribution ID', required: true }],
  flags: {},
  methods: ['plugin.enable'],
  plugin: null,
  async run(args, ctx) {
    const [id] = takePositionals(args, ['id'])
    const result = await ctx.rpc.call('plugin.enable', { id })
    ctx.out.result(result, () => `enabled ${id}`)
  }
}

export const pluginDisable: Command = {
  name: 'plugin disable',
  summary: 'disable a plugin (and its dependents) or one contribution',
  positionals: [{ name: 'id', description: 'plugin or contribution ID', required: true }],
  flags: {},
  methods: ['plugin.disable'],
  plugin: null,
  async run(args, ctx) {
    const [id] = takePositionals(args, ['id'])
    const result = await ctx.rpc.call('plugin.disable', { id })
    ctx.out.result(result, () => `disabled ${id}`)
  }
}

export const pluginActivate: Command = {
  name: 'plugin activate',
  summary: 'activate a plugin now instead of on first use',
  positionals: [{ name: 'pluginId', description: 'the plugin to activate', required: true }],
  flags: {},
  methods: ['plugin.activate'],
  plugin: null,
  async run(args, ctx) {
    const [pluginId] = takePositionals(args, ['pluginId'])
    const plugin = await ctx.rpc.call('plugin.activate', { pluginId })
    ctx.out.result(plugin, () => formatRecord([['id', plugin.id], ['state', plugin.state]]))
  }
}
