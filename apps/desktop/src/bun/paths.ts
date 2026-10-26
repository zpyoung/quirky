import { dirname, join } from 'node:path'

export type RuntimeEnv = {
  QUIRKY_DAEMON_ENTRY: string
  QUIRKY_PTY_HOST_ENTRY: string
  QUIRKY_CLI_ENTRY: string
  QUIRKY_UI_DIR: string
  QUIRKY_BUILTIN_PLUGINS_DIR: string
}

const DAEMON_SOURCE = join('packages', 'daemon', 'src', 'main.ts')

/** Nearest ancestor of `start` (inclusive) that contains the daemon source, or null. */
export function findRepoRoot(start: string, exists: (path: string) => boolean): string | null {
  let dir = start
  for (;;) {
    if (exists(join(dir, DAEMON_SOURCE))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * The QUIRKY_* variables the shell must set so the daemon and its helpers are found, minus any
 * the environment already defines. A packaged app uses the resources copied next to the main
 * process; development uses the repo sources (root from `QUIRKY_REPO_ROOT`, else found by walking
 * up from `moduleDir`).
 */
export function resolveRuntimeEnv(options: {
  packaged: boolean
  moduleDir: string
  env: Record<string, string | undefined>
  exists: (path: string) => boolean
}): Partial<RuntimeEnv> {
  const { packaged, moduleDir, env, exists } = options
  const root = packaged ? null : (env.QUIRKY_REPO_ROOT || findRepoRoot(moduleDir, exists))

  const wanted: RuntimeEnv = root
    ? {
        QUIRKY_DAEMON_ENTRY: join(root, 'packages', 'daemon', 'src', 'main.ts'),
        QUIRKY_PTY_HOST_ENTRY: join(root, 'packages', 'pty-host', 'src', 'main.ts'),
        QUIRKY_CLI_ENTRY: join(root, 'packages', 'cli', 'src', 'main.ts'),
        QUIRKY_UI_DIR: join(root, 'packages', 'ui', 'dist'),
        QUIRKY_BUILTIN_PLUGINS_DIR: join(root, 'plugins')
      }
    : bundledEnv(join(dirname(moduleDir), 'resources'))

  const result: Partial<RuntimeEnv> = {}
  for (const key of Object.keys(wanted) as (keyof RuntimeEnv)[]) {
    if (!env[key]) result[key] = wanted[key]
  }
  return result
}

function bundledEnv(resources: string): RuntimeEnv {
  return {
    QUIRKY_DAEMON_ENTRY: join(resources, 'daemon.js'),
    QUIRKY_PTY_HOST_ENTRY: join(resources, 'pty-host.js'),
    QUIRKY_CLI_ENTRY: join(resources, 'cli.js'),
    QUIRKY_UI_DIR: join(resources, 'ui'),
    QUIRKY_BUILTIN_PLUGINS_DIR: join(resources, 'plugins')
  }
}
