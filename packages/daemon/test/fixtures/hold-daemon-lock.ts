import { acquireDaemonLock } from '../../src/lock'

const home = process.env.QUIRKY_HOME
if (!home) throw new Error('QUIRKY_HOME is required')

const lock = await acquireDaemonLock(home)
if (!lock) throw new Error('daemon lock is already held')

process.stdout.write(`holding daemon lock for ${process.pid}\n`)
process.once('SIGTERM', () => {
  lock.release()
  process.exit(0)
})

await Bun.sleep(30_000)
lock.release()
