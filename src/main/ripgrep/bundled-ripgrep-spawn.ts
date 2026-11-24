import { spawnProcess } from '@quirky/process-host'
import type { ChildProcessHandle, ProcessSpec } from '@quirky/process-host/process-spec'
import { bundledRipgrepCommand } from './bundled-ripgrep-path'

export type BundledRipgrepSpawnOptions = Pick<ProcessSpec, 'cwd' | 'stdio' | 'env'> & {
  cwd: string
  wslDistro?: string
  wslDistroForOutput?: string
}

/**
 * The single way Quirky spawns ripgrep: its own binary, never a bare `rg` resolved from PATH or the
 * spawn cwd.
 */
export function spawnBundledRipgrep(
  args: string[],
  options: BundledRipgrepSpawnOptions
): ChildProcessHandle {
  return spawnProcess({
    program: bundledRipgrepCommand(),
    args,
    cwd: options.cwd,
    env: options.env,
    stdio: options.stdio
  })
}
