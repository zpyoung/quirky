import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startFakePtyHost } from './fake-pty-host'

if (import.meta.main) {
  const home = process.env.QUIRKY_HOME
  if (!home) throw new Error('QUIRKY_HOME is required')

  const startMarker = join(home, 'pty-host.start')
  while (!existsSync(startMarker)) await Bun.sleep(10)

  writeFileSync(join(home, 'pty.pid'), String(process.pid))
  startFakePtyHost(home, { onShutdown: () => process.exit(0) })
}
