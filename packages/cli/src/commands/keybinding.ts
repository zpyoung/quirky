import type { UiKeybinding } from '@quirky/protocol'
import { takePositionals } from '../args'
import { formatTable } from '../output'
import type { Command } from './types'

function cell(text: string | null | undefined): string {
  return text == null ? '-' : text.replace(/\r\n|\r|\n/g, '\\n')
}

function status(binding: UiKeybinding): string {
  return binding.status === 'shadowed' ? `shadowed by ${cell(binding.shadowedBy)}` : binding.status
}

function table(bindings: UiKeybinding[], id?: string): string {
  const rows = id === undefined ? bindings : bindings.filter((binding) => binding.id === id)
  return formatTable(
    ['ID', 'KEY', 'COMMAND', 'STATUS'],
    rows.map((binding) => [cell(binding.id), cell(binding.key), cell(binding.command), status(binding)])
  )
}

export const keybindingList: Command = {
  name: 'keybinding list',
  summary: 'list keybindings',
  positionals: [],
  flags: {},
  methods: ['keybinding.list'],
  plugin: null,
  async run(args, ctx) {
    takePositionals(args, [])
    const bindings = await ctx.rpc.call('keybinding.list', {})
    ctx.out.result(bindings, () => table(bindings))
  }
}

export const keybindingSet: Command = {
  name: 'keybinding set',
  summary: 'set a keybinding chord',
  positionals: [
    { name: 'id', description: 'keybinding ID', required: true },
    { name: 'key', description: 'canonical key chord', required: true }
  ],
  flags: {},
  methods: ['keybinding.set'],
  plugin: null,
  async run(args, ctx) {
    const [id, key] = takePositionals(args, ['id', 'key'])
    const bindings = await ctx.rpc.call('keybinding.set', { id, key })
    ctx.out.result(bindings, () => table(bindings, id))
  }
}

export const keybindingDisable: Command = {
  name: 'keybinding disable',
  summary: 'disable a keybinding',
  positionals: [{ name: 'id', description: 'keybinding ID', required: true }],
  flags: {},
  methods: ['keybinding.set'],
  plugin: null,
  async run(args, ctx) {
    const [id] = takePositionals(args, ['id'])
    const bindings = await ctx.rpc.call('keybinding.set', { id, key: null })
    ctx.out.result(bindings, () => table(bindings, id))
  }
}

export const keybindingReset: Command = {
  name: 'keybinding reset',
  summary: 'reset a keybinding to its default',
  positionals: [{ name: 'id', description: 'keybinding ID', required: true }],
  flags: {},
  methods: ['keybinding.reset'],
  plugin: null,
  async run(args, ctx) {
    const [id] = takePositionals(args, ['id'])
    const bindings = await ctx.rpc.call('keybinding.reset', { id })
    ctx.out.result(bindings, () => table(bindings, id))
  }
}
