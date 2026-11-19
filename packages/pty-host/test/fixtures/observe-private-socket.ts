import { lstatSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const recordPath = process.env.QUIRKY_TEST_PRIVATE_SOCKET_RECORD
if (!recordPath) throw new Error('missing private socket observation path')

const listen = Bun.listen
Bun.listen = ((options: Parameters<typeof Bun.listen>[0]) => {
  const listener = listen(options)
  if (typeof options.unix === 'string') {
    const directory = dirname(options.unix)
    const stat = lstatSync(directory, { bigint: true })
    const temporaryPath = `${recordPath}.${process.pid}.tmp`
    writeFileSync(temporaryPath, JSON.stringify({
      pid: process.pid,
      unixPath: options.unix,
      directory,
      dev: stat.dev.toString(),
      ino: stat.ino.toString()
    }), { mode: 0o600 })
    renameSync(temporaryPath, recordPath)
  }
  return listener
}) as typeof Bun.listen
