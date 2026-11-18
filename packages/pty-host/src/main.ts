import { inspect } from 'node:util'
import { ensureHome, installProcessErrorGuards, quirkyHome } from '@quirky/protocol/node'
import { probeHost } from './client'
import { startPtyServer } from './server'

installProcessErrorGuards({ label: 'quirky-pty' })

function finishShutdown(error?: unknown): never {
  if (error === undefined) process.exit(0)
  process.stderr.write(`[quirky-pty] shutdown failed: ${inspect(error)}\n`)
  process.exit(1)
}

try {
  const home = ensureHome(quirkyHome())

  if (await probeHost(home)) {
    console.log(`quirky-pty already running for ${home}`)
    process.exit(0)
  }

  const server = startPtyServer({ home, onShutdown: finishShutdown })

  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.on(signal, () => {
      void server.stop().then(
        () => finishShutdown(),
        (error: unknown) => finishShutdown(error ?? new Error('unknown shutdown error'))
      )
    })
  }
} catch (error) {
  process.stderr.write(`[quirky-pty] startup failed: ${inspect(error)}\n`)
  process.exit(1)
}
