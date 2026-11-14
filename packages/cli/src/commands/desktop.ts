import { resolve } from 'node:path'
import { CommandFailed, flagBoolean, flagString, takePositionals } from '../args'
import type { Command } from './types'

export const desktopPickFolder: Command = {
  name: 'desktop pick-folder',
  summary: 'choose a folder using the focused desktop window',
  positionals: [],
  flags: {
    title: { type: 'string', description: 'title shown by the folder picker' },
    'starting-folder': { type: 'string', description: 'folder where the picker opens' },
    multiple: { type: 'boolean', description: 'allow selecting multiple folders' }
  },
  methods: ['desktop.folder.pick'],
  plugin: null,
  async run(args, ctx) {
    takePositionals(args, [])

    const title = flagString(args, 'title')
    const startingFolder = flagString(args, 'starting-folder')
    const multiple = args.flags.multiple
    const result = await ctx.rpc.call('desktop.folder.pick', {
      ...(title !== undefined ? { title } : {}),
      ...(startingFolder !== undefined ? { startingFolder: resolve(ctx.cwd, startingFolder) } : {}),
      ...(multiple !== undefined ? { multiple: flagBoolean(args, 'multiple') } : {})
    })

    ctx.out.result(result, () => result.cancelled ? 'cancelled' : result.paths.join('\n'))
    if (result.cancelled) throw new CommandFailed('folder selection cancelled')
  }
}
