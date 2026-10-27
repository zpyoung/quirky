import type { UiCommandEntry, UiKeybinding, UiLayout, UiModel, UiSlotEntry } from '@quirky/protocol'
import { UsageError, takePositionals } from '../args'
import { formatGeneric } from '../format'
import { formatTable } from '../output'
import type { Command } from './types'

/** Keeps a cell on one line so an embedded line break can't split a table row. */
function cell(text: string | null | undefined): string {
  return text == null ? '-' : text.replace(/\r\n|\r|\n/g, '\\n')
}

function keybindingStatus(item: UiKeybinding): string {
  return item.status === 'shadowed' ? `shadowed by ${cell(item.shadowedBy)}` : item.status
}

function slotTable(items: UiSlotEntry[]): string {
  return formatTable(
    ['ID', 'PLUGIN', 'TITLE', 'ORDER', 'MODULE'],
    items.map((item) => [item.id, item.plugin, item.title, String(item.order), item.module].map(cell))
  )
}

function commandTable(items: UiCommandEntry[]): string {
  return formatTable(
    ['ID', 'PLUGIN', 'TITLE', 'MODULE'],
    items.map((item) => [item.id, item.plugin, item.title, item.module].map(cell))
  )
}

/** One header line and table per non-empty part of the UI model, separated by blank lines. */
function renderModel(model: UiModel): string {
  const sections: [string, unknown[], () => string][] = [
    ['SIDEBAR', model.sidebarSections, () => slotTable(model.sidebarSections)],
    ['PANELS', model.panels, () => slotTable(model.panels)],
    ['VIEWS', model.views, () => slotTable(model.views)],
    ['OVERLAYS', model.overlays, () => slotTable(model.overlays)],
    ['COMMANDS', model.commands, () => commandTable(model.commands)],
    [
      'KEYBINDINGS',
      model.keybindings,
      () =>
        formatTable(
          ['ID', 'KEY', 'COMMAND', 'STATUS'],
          model.keybindings.map((item) => [item.id, item.key, item.command, keybindingStatus(item)].map(cell))
        )
    ],
    [
      'SETTINGS',
      model.settings,
      () =>
        formatTable(
          ['ID', 'TYPE', 'DEFAULT'],
          model.settings.map((item) => [item.id, item.type, JSON.stringify(item.default)].map(cell))
        )
    ],
    [
      'THEMES',
      model.themes,
      () =>
        formatTable(
          ['ID', 'TITLE', 'APPEARANCE'],
          model.themes.map((item) => [item.id, item.title, item.appearance].map(cell))
        )
    ]
  ]
  const shown = sections.filter(([, items]) => items.length)
  if (!shown.length) return 'no UI contributions'
  return shown.map(([header, , table]) => `${header}\n${table()}`).join('\n\n')
}

export const uiContributions: Command = {
  name: 'ui contributions',
  summary: 'list the UI contributions in effect: slots, commands, keybindings, settings and themes',
  positionals: [],
  flags: {},
  methods: ['ui.contributions'],
  plugin: null,
  async run(args, ctx) {
    takePositionals(args, [])
    const model = await ctx.rpc.call('ui.contributions', {})
    ctx.out.result(model, () => renderModel(model))
  }
}

const FOCUS_TARGETS = ['sidebar', 'view', 'panel'] as const

function layoutLines(layout: UiLayout): string[] {
  const view = layout.view
    ? [layout.view.id, layout.view.input === undefined ? '' : JSON.stringify(layout.view.input)].filter(Boolean).join(' ')
    : '-'
  return [
    `view: ${view}`,
    `panel: ${layout.panel ?? '-'}`,
    `sidebar: ${layout.sidebar ? 'shown' : 'hidden'}`,
    `focus: ${layout.focus ?? '-'}`,
    `palette: ${layout.palette === true ? 'open' : 'closed'}`
  ]
}

export const uiState: Command = {
  name: 'ui state',
  summary: 'show the window layout and what each shown slot reports',
  positionals: [],
  flags: {},
  methods: ['ui.state'],
  plugin: null,
  async run(args, ctx) {
    takePositionals(args, [])
    const state = await ctx.rpc.call('ui.state', {})
    ctx.out.result(state, () =>
      [
        `windows: ${state.windows.length}`,
        ...layoutLines(state.layout),
        ...state.slots
          .filter((slot) => slot.shown)
          .map((slot) => `slot ${slot.id}: ${cell(slot.title)}${slot.report === undefined ? '' : ` ${JSON.stringify(slot.report)}`}`)
      ].join('\n')
    )
  }
}

export const uiOpenView: Command = {
  name: 'ui open-view',
  summary: 'open a view in the window, with optional input',
  positionals: [{ name: 'id', description: 'the view contribution ID', required: true }],
  flags: { input: { type: 'json', description: 'the input passed to the view, as JSON' } },
  methods: ['ui.view.open'],
  plugin: null,
  async run(args, ctx) {
    const [id] = takePositionals(args, ['id'])
    const input = args.flags.input
    const layout = await ctx.rpc.call('ui.view.open', { id, ...(input === undefined ? {} : { input }) })
    ctx.out.result(layout, () => layoutLines(layout).join('\n'))
  }
}

export const uiCloseView: Command = {
  name: 'ui close-view',
  summary: 'close the open view',
  positionals: [],
  flags: {},
  methods: ['ui.view.close'],
  plugin: null,
  async run(args, ctx) {
    takePositionals(args, [])
    const layout = await ctx.rpc.call('ui.view.close', {})
    ctx.out.result(layout, () => layoutLines(layout).join('\n'))
  }
}

export const uiOpenPanel: Command = {
  name: 'ui open-panel',
  summary: 'open a panel in the window',
  positionals: [{ name: 'id', description: 'the panel contribution ID', required: true }],
  flags: {},
  methods: ['ui.panel.open'],
  plugin: null,
  async run(args, ctx) {
    const [id] = takePositionals(args, ['id'])
    const layout = await ctx.rpc.call('ui.panel.open', { id })
    ctx.out.result(layout, () => layoutLines(layout).join('\n'))
  }
}

export const uiClosePanel: Command = {
  name: 'ui close-panel',
  summary: 'close the open panel',
  positionals: [],
  flags: {},
  methods: ['ui.panel.close'],
  plugin: null,
  async run(args, ctx) {
    takePositionals(args, [])
    const layout = await ctx.rpc.call('ui.panel.close', {})
    ctx.out.result(layout, () => layoutLines(layout).join('\n'))
  }
}

export const uiSidebar: Command = {
  name: 'ui sidebar',
  summary: 'show or hide the sidebar',
  positionals: [{ name: 'state', description: 'show or hide', required: true }],
  flags: {},
  methods: ['ui.sidebar.set'],
  plugin: null,
  async run(args, ctx) {
    const [state] = takePositionals(args, ['state'])
    if (state !== 'show' && state !== 'hide') throw new UsageError('<state> must be show or hide')
    const layout = await ctx.rpc.call('ui.sidebar.set', { visible: state === 'show' })
    ctx.out.result(layout, () => layoutLines(layout).join('\n'))
  }
}

export const uiFocus: Command = {
  name: 'ui focus',
  summary: 'move focus to the sidebar, the view or the panel',
  positionals: [{ name: 'target', description: FOCUS_TARGETS.join(', '), required: true }],
  flags: {},
  methods: ['ui.focus'],
  plugin: null,
  async run(args, ctx) {
    const [target] = takePositionals(args, ['target'])
    if (!(FOCUS_TARGETS as readonly string[]).includes(target)) {
      throw new UsageError(`<target> must be one of ${FOCUS_TARGETS.join(', ')}`)
    }
    const layout = await ctx.rpc.call('ui.focus', { target: target as (typeof FOCUS_TARGETS)[number] })
    ctx.out.result(layout, () => layoutLines(layout).join('\n'))
  }
}

export const uiRun: Command = {
  name: 'ui run',
  summary: 'run a plugin UI command in the open window and print its result',
  positionals: [{ name: 'command', description: 'the command contribution ID', required: true }],
  flags: { args: { type: 'json', description: 'the command arguments, as JSON' } },
  methods: ['ui.command.run'],
  plugin: null,
  async run(args, ctx) {
    const [id] = takePositionals(args, ['command'])
    const commandArgs = args.flags.args
    const reply = await ctx.rpc.call('ui.command.run', { id, ...(commandArgs === undefined ? {} : { args: commandArgs }) })
    ctx.out.result(reply, () => formatGeneric(reply.result))
  }
}
