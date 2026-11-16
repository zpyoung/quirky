import { tryHomeLock } from '../../src/node/home-lock'

const [home, name, recordHolder] = process.argv.slice(2)
if (!home || (name !== 'daemon' && name !== 'pty')) throw new Error('expected home and lock name')

const lock = tryHomeLock(home, name)
if (!lock) throw new Error(`home lock is already held: ${name}`)
if (recordHolder === 'recordHolder') lock.recordHolder()
console.log(`locked pid=${process.pid} lastHolder=${lock.lastHolderPid ?? 'null'}`)

for (;;) await Bun.sleep(60_000)
