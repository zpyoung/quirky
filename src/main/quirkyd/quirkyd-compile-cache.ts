/**
 * V8 code cache for a managed slot's bundles. MEASURED on a low-spec WSL host: compiling
 * quirkyd-server.js took ~600 ms per start, twice (server and its profile preflight); cached ~290 ms.
 */
import module from 'node:module'
import { join } from 'node:path'
import { QUIRKYD_MANAGED_ACTIVATION_ROOT_ENV } from '../../shared/quirkyd-managed-launch-env'

export const QUIRKYD_COMPILE_CACHE_DIRNAME = '.quirkyd-compile-cache'

type CompileCacheModule = {
  enableCompileCache?: (directory: string) => unknown
  getCompileCacheDir?: () => string | undefined
}

/**
 * Only a client-managed slot (SSH or WSL), which slot GC deletes with its cache; never a packaged
 * app directory, where a new file would break the bundle's signature. Never throws: an unwritable
 * slot or a runtime without the API just compiles as before.
 */
export function enableManagedQuirkydCompileCache(
  slotDirectory: string,
  env: NodeJS.ProcessEnv = process.env,
  api: CompileCacheModule = module
): void {
  if (!env[QUIRKYD_MANAGED_ACTIVATION_ROOT_ENV] || typeof api.enableCompileCache !== 'function') {
    return
  }
  try {
    api.enableCompileCache(join(slotDirectory, QUIRKYD_COMPILE_CACHE_DIRNAME))
  } catch {
    // Best effort by design.
  }
}

/**
 * Env that gives a disposable quirkyd child the same cache. Not for children that spawn user
 * processes: an inherited NODE_COMPILE_CACHE would reach every Node program in a terminal.
 */
export function quirkydCompileCacheEnv(
  slotDirectory: string,
  api: CompileCacheModule = module,
  env: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  // An unmanaged quirkyd may have an operator's NODE_COMPILE_CACHE; never redirect it into the slot.
  const enabled =
    Boolean(env[QUIRKYD_MANAGED_ACTIVATION_ROOT_ENV]) &&
    typeof api.getCompileCacheDir === 'function' &&
    Boolean(api.getCompileCacheDir())
  return enabled ? { NODE_COMPILE_CACHE: join(slotDirectory, QUIRKYD_COMPILE_CACHE_DIRNAME) } : {}
}
