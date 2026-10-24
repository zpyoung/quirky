import { ensureHome, quirkyHome } from '@quirky/protocol/node'
import { probeHost } from './client'
import { startPtyServer } from './server'

const home = ensureHome(quirkyHome())

if (await probeHost(home)) {
  console.log(`quirky-pty already running for ${home}`)
  process.exit(0)
}

const server = startPtyServer({ home, onShutdown: () => process.exit(0) })

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.on(signal, () => {
    void server.stop().then(() => process.exit(0))
  })
}
