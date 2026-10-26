/**
 * A stand-in for quirkyd's entry: serves `/health`, writes `runtime.json` and records the process
 * id and argv in `<home>/started.json`. `ensureDaemon` spawns it through `QUIRKY_DAEMON_ENTRY`.
 */
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROTOCOL_VERSION } from '@quirky/protocol'
import { runtimeFilePath, writePrivateJson, type RuntimeInfo } from '@quirky/protocol/node'

const home = process.env.QUIRKY_HOME as string
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: () => Response.json({ ok: true, pid: process.pid, daemonVersion: '0.0.0-fake' })
})
const info: RuntimeInfo = {
  pid: process.pid,
  port: server.port as number,
  token: 'fake-token',
  hookToken: 'fake-hook-token',
  daemonVersion: '0.0.0-fake',
  protocolVersion: PROTOCOL_VERSION,
  startedAt: Date.now()
}
writePrivateJson(runtimeFilePath(home), info)
writeFileSync(join(home, 'started.json'), JSON.stringify({ pid: process.pid, args: process.argv.slice(2) }))

// the test removes its home when it ends; exit with it
setInterval(() => {
  if (!existsSync(home)) process.exit(0)
}, 500)
