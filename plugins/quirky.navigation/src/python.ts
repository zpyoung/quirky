import { join } from 'node:path'
import type { ProcessSpawner } from '@quirky/protocol'
import { LspStartError, startLspServer } from './lsp-client'
import { ServerPoolError, type ServerFactory } from './servers'

/** Finds the daemon's isolated standard-library Python runtime. */
export function findPython(): string | null {
  return Bun.which('python3', { PATH: process.env.PATH ?? '' })
}

/** Locates the resolver in the plugin's shipped assets. */
export function resolverPath(pluginDir: string): string {
  return join(pluginDir, 'assets', 'resolver.py')
}

/** Starts disk-backed Python navigation without executing worktree code. */
export function pythonFactory(options: { process: ProcessSpawner; pluginDir: string; findPython?: () => string | null }): ServerFactory {
  return async (worktree) => {
    const runtime = (options.findPython ?? findPython)()
    if (!runtime) throw new ServerPoolError('not-found', 'could not find python3 on PATH')
    const serverPath = resolverPath(options.pluginDir)
    try {
      return await startLspServer({ process: options.process, argv: [runtime, '-I', serverPath], root: worktree.path, runtime, serverPath })
    } catch (error) {
      if (error instanceof LspStartError && error.exitCode === 3) throw new ServerPoolError('not-found', error.stderrTail.trim())
      throw error
    }
  }
}
