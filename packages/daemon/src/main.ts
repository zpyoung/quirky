import { inspect } from 'node:util'
import { daemonEntryHash, ensureHome, installProcessErrorGuards, isDaemonAlive, quirkyHome, readRuntime, runtimeFilePath } from '@quirky/protocol/node'
import { startDaemon } from './daemon'
import { acquireDaemonLock, type DaemonLock } from './lock'

installProcessErrorGuards({ label: 'quirkyd' })

let lock: DaemonLock | null = null
try {
  const home = ensureHome(quirkyHome())
  if (await isDaemonAlive(readRuntime(home))) {
    console.error('[quirkyd] a daemon already owns this home; exiting')
    process.exit(0)
  }

  lock = await acquireDaemonLock(home)
  if (!lock) {
    console.error('[quirkyd] a daemon already owns this home; exiting')
    process.exit(0)
  }
  const ownedLock = lock
  const safeMode = process.argv.includes('--disable-plugins') || process.env.QUIRKY_DISABLE_PLUGINS === '1'
  if (safeMode) console.error('[quirkyd] safe mode: installed plugins and disables are off for this run')

  const daemon = await startDaemon({
    home,
    entryHash: daemonEntryHash(process.argv[1]!),
    safeMode,
    interactivePath: true,
    onStopRequested: () => shutdown()
  })
  console.log(`quirkyd listening on http://127.0.0.1:${daemon.port}; connection details are in ${runtimeFilePath(home)}`)

  const shutdown = () => {
    void daemon.stop().finally(() => {
      ownedLock.release()
      process.exit(0)
    })
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
} catch (error) {
  lock?.release()
  console.error(`[quirkyd] startup failed: ${inspect(error)}`)
  process.exit(1)
}
