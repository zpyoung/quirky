import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { QUIRKYD_SERVER_ENTRY_FILENAME } from '../../shared/quirkyd-artifacts'
import { assertQuirkydServerRuntime, handoffToBundledQuirkyd } from './quirkyd-bundled-runtime'
import { QUIRKYD_EXIT_CONFIGURATION } from './quirkyd-configuration-exit'
import { enableManagedQuirkydCompileCache } from './quirkyd-compile-cache'

declare const QUIRKYD_SERVER_SHA256: string

let loadServer: (() => void) | undefined

try {
  if (!handoffToBundledQuirkyd()) {
    assertQuirkydServerRuntime()
    const entry = realpathSync(process.argv[1] ?? __filename)
    const server = join(dirname(entry), QUIRKYD_SERVER_ENTRY_FILENAME)
    if (createHash('sha256').update(readFileSync(server)).digest('hex') !== QUIRKYD_SERVER_SHA256) {
      throw new Error('The Quirky server does not match its launcher')
    }
    loadServer = () => {
      enableManagedQuirkydCompileCache(dirname(entry))
      createRequire(entry)(server)
    }
  }
} catch (error) {
  console.error('quirkyd: failed to launch:', error)
  process.exit(QUIRKYD_EXIT_CONFIGURATION)
}

loadServer?.()
