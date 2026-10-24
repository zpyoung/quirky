import { ensureHome, isDaemonAlive, quirkyHome, readRuntime, runtimeFilePath } from '@quirky/protocol/node'
import { startDaemon } from './daemon'
import { acquireDaemonLock } from './lock'

const home = ensureHome(quirkyHome())

if (await isDaemonAlive(readRuntime(home))) {
  console.error('[quirkyd] a daemon already owns this home; exiting')
  process.exit(0)
}

const lock = await acquireDaemonLock(home)
if (!lock) {
  console.error('[quirkyd] a daemon already owns this home; exiting')
  process.exit(0)
}

const daemon = await startDaemon({ home }).catch((error) => {
  lock.release()
  throw error
})
console.log(`quirkyd listening on http://127.0.0.1:${daemon.port}; connection details are in ${runtimeFilePath(home)}`)

const shutdown = () => {
  void daemon.stop().finally(() => {
    lock.release()
    process.exit(0)
  })
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
