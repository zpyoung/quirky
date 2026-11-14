import { inspect } from 'node:util'
import { stopAllProcesses } from '@quirky/process'
import { daemonEntryHash, ensureHome, installProcessErrorGuards, isDaemonAlive, quirkyHome, readRuntime, runtimeFilePath } from '@quirky/protocol/node'
import { startDaemon, type DaemonHandle } from './daemon'
import { createShutdown } from './shutdown'
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

  const { promise: listening, resolve: publish } = Promise.withResolvers<DaemonHandle>()
  const shutdown = createShutdown({
    stop: async () => { await (await listening).stop() },
    release: () => ownedLock.release(),
    exit: (code) => process.exit(code),
    onDeadline: () => { void stopAllProcesses() },
    log: (message) => console.error(`[quirkyd] ${message}`)
  })
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
  await startDaemon({
    home,
    entryHash: daemonEntryHash(process.argv[1]!),
    safeMode,
    interactivePath: true,
    onStopRequested: shutdown,
    onListening: (handle) => {
      publish(handle)
      console.log(`quirkyd listening on http://127.0.0.1:${handle.port}; connection details are in ${runtimeFilePath(home)}`)
    }
  })
} catch (error) {
  lock?.release()
  console.error(`[quirkyd] startup failed: ${inspect(error)}`)
  process.exit(1)
}
