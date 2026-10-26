import { takePositionals } from '../args'
import { formatTable } from '../output'
import type { Command } from './types'

/** Keeps a cell on one line so an embedded line break can't split a table row. */
function singleLine(text: string): string {
  return text.replace(/\r\n|\r|\n/g, '\\n')
}

export const themeList: Command = {
  name: 'theme list',
  summary: 'list themes; * marks the active one, (chosen) a chosen theme that is not active',
  positionals: [],
  flags: {},
  methods: ['theme.list'],
  plugin: null,
  async run(args, ctx) {
    takePositionals(args, [])
    const list = await ctx.rpc.call('theme.list', {})
    ctx.out.result(list, () => {
      const mark = (id: string) => (id === list.active ? '*' : id === list.chosen ? '(chosen)' : '')
      const table = formatTable(
        ['ID', 'TITLE', 'APPEARANCE', ''],
        list.themes.map((theme) => [theme.id, theme.title, theme.appearance, mark(theme.id)].map(singleLine))
      )
      const chosenListed = list.themes.some((theme) => theme.id === list.chosen)
      return chosenListed ? table : `${table}\nchosen: ${singleLine(list.chosen)} (not in effect)`
    })
  }
}

export const themeSet: Command = {
  name: 'theme set',
  summary: 'choose a theme by ID, or default for the built-in one',
  positionals: [{ name: 'id', description: 'theme ID, or default', required: true }],
  flags: {},
  methods: ['theme.set'],
  plugin: null,
  async run(args, ctx) {
    const [id] = takePositionals(args, ['id'])
    const list = await ctx.rpc.call('theme.set', { id })
    ctx.out.result(list, () => list.active)
  }
}
