import { ensureHome, isDaemonAlive, quirkyHome, readRuntime } from '@quirky/protocol/node'
import { startDaemon } from './daemon'

const home = ensureHome(quirkyHome())

if (await isDaemonAlive(readRuntime(home))) {
  console.error('[quirkyd] a daemon already owns this home; exiting')
  process.exit(0)
}

const daemon = await startDaemon({ home })
console.log(`quirkyd listening on http://127.0.0.1:${daemon.port}/#token=${daemon.runtime.token}`)

const shutdown = () => {
  void daemon.stop().finally(() => process.exit(0))
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
