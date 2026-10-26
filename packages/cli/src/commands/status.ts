import { takePositionals } from '../args'
import { formatRecord } from '../output'
import type { Command } from './types'

export const status: Command = {
  name: 'status',
  summary: 'show daemon status',
  positionals: [],
  flags: {},
  methods: ['status.get'],
  plugin: null,
  async run(args, ctx) {
    takePositionals(args, [])
    const result = await ctx.rpc.call('status.get', {})
    ctx.out.result(result, () => {
      const clients = result.clients.map((client) => (client.name ? `${client.role}:${client.name}` : client.role))
      return formatRecord([
        ['daemon', result.daemonVersion],
        ['pid', result.pid],
        ['started', new Date(result.startedAt).toISOString()],
        ['home', result.home],
        ['pty host', result.ptyHost.alive ? `alive (pid ${result.ptyHost.pid})` : 'not running'],
        ['clients', clients.length ? clients.join(', ') : 'none']
      ])
    })
  }
}
