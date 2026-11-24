import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { recordSubprocessSpawn } from '../diagnostics/main-thread-churn-probe'
import { bundledRipgrepCommand } from './bundled-ripgrep-path'

export type BundledRipgrepSpawnOptions = SpawnOptions & {
  cwd: string
  wslDistro?: string
  wslDistroForOutput?: string
}

/**
 * The single way Orca spawns ripgrep: its own binary, never a bare `rg` resolved from PATH or the
 * spawn cwd.
 */
export function spawnBundledRipgrep(
  args: string[],
  options: BundledRipgrepSpawnOptions
): ChildProcess {
  const {
    wslDistro: _wslDistro,
    wslDistroForOutput: _wslDistroForOutput,
    ...spawnOptions
  } = options
  const command = bundledRipgrepCommand()
  const spawnStartedAt = performance.now()
  const child = spawn(command, args, { ...spawnOptions, windowsHide: true })
  recordSubprocessSpawn(command, args, performance.now() - spawnStartedAt)
  return child
}
