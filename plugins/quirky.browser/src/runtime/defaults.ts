import type { ProcessSpawner } from '@quirky/protocol'
import type { BrowserDependencies, BrowserProcess, BrowserSpawn } from './dependencies'

export function createBrowserSpawn(process: Pick<ProcessSpawner, 'spawn'>): BrowserSpawn {
  return (command, options) =>
    process.spawn(command, {
      cwd: options.cwd,
      env: options.env,
      timeoutMs: null,
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore'
    })
}

export function browserDependencies(
  runtimeRoot: string,
  process: BrowserProcess,
  log?: (message: string) => void
): BrowserDependencies {
  return {
    runtimeRoot,
    process,
    spawn: createBrowserSpawn(process),
    ...(log ? { log } : {})
  }
}
