import { isDaemonAlive, ensureDaemon, quirkyHome, readRuntime } from '@quirky/protocol/node'
import { StderrFailure, flagBoolean, takePositionals } from '../args'
import type { Command } from './types'

const STOP_TIMEOUT_MS = 10_000
const POLL_MS = 100

export const daemonRestart: Command = {
  name: 'daemon restart',
  summary: 'stop quirkyd and start a new one; --disable-plugins starts it in safe mode for this run',
  positionals: [],
  flags: {
    'disable-plugins': {
      type: 'boolean',
      description: 'safe mode: installed plugins, stored disables and the distro layer are off for this run'
    }
  },
  methods: ['daemon.stop'],
  plugin: null,
  async run(args, ctx) {
    takePositionals(args, [])
    const safeMode = flagBoolean(args, 'disable-plugins')
    const home = ctx.env.QUIRKY_HOME ?? quirkyHome()
    const running = readRuntime(home)
    if (await isDaemonAlive(running)) {
      await ctx.rpc.call('daemon.stop', {})
      const deadline = ctx.now() + STOP_TIMEOUT_MS
      while (await isDaemonAlive(running, 500)) {
        if (ctx.now() > deadline) throw new StderrFailure(`quirkyd did not stop within ${STOP_TIMEOUT_MS / 1000}s`)
        await ctx.sleep(POLL_MS)
      }
    }
    const info = await ensureDaemon({ home, args: safeMode ? ['--disable-plugins'] : [] })
    ctx.out.result({ pid: info.pid, port: info.port, safeMode }, () =>
      `restarted quirkyd${safeMode ? ' in safe mode' : ''} (pid ${info.pid})`
    )
  }
}
