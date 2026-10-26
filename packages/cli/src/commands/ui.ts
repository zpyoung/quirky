import type { UiCommandEntry, UiKeybinding, UiModel, UiSlotEntry } from '@quirky/protocol'
import { formatTable } from '../output'
import { takePositionals } from './support'
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
  usage: 'ui contributions',
  summary: 'list the UI contributions in effect: slots, commands, keybindings, settings and themes',
  flags: {},
  async run(args, ctx) {
    takePositionals(args, [])
    const model = await ctx.rpc.call('ui.contributions', {})
    ctx.out.result(model, () => renderModel(model))
  }
}
