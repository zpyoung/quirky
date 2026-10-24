import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { findRepoRoot, resolveRuntimeEnv } from '../src/bun/paths'

const fakeFs = (files: string[]) => (path: string) => files.includes(path)

describe('resolveRuntimeEnv', () => {
  test('bundled mode points at the resources folder next to the main process', () => {
    const moduleDir = '/Apps/Quirky.app/Contents/Resources/app/bun'
    const resources = '/Apps/Quirky.app/Contents/Resources/app/resources'
    const result = resolveRuntimeEnv({ packaged: true, moduleDir, env: {}, exists: () => true })
    expect(result).toEqual({
      QUIRKY_DAEMON_ENTRY: join(resources, 'daemon.js'),
      QUIRKY_PTY_HOST_ENTRY: join(resources, 'pty-host.js'),
      QUIRKY_CLI_ENTRY: join(resources, 'cli.js'),
      QUIRKY_UI_DIR: join(resources, 'ui')
    })
  })

  test('source mode points at the repo files using QUIRKY_REPO_ROOT', () => {
    const result = resolveRuntimeEnv({
      packaged: false,
      moduleDir: '/anywhere',
      env: { QUIRKY_REPO_ROOT: '/repo' },
      exists: () => true
    })
    expect(result).toEqual({
      QUIRKY_DAEMON_ENTRY: '/repo/packages/daemon/src/main.ts',
      QUIRKY_PTY_HOST_ENTRY: '/repo/packages/pty-host/src/main.ts',
      QUIRKY_CLI_ENTRY: '/repo/packages/cli/src/main.ts',
      QUIRKY_UI_DIR: '/repo/packages/ui/dist'
    })
  })

  test('source mode finds the repo root by walking up from the module', () => {
    const exists = fakeFs(['/repo/packages/daemon/src/main.ts'])
    const result = resolveRuntimeEnv({
      packaged: false,
      moduleDir: '/repo/apps/desktop/build/dev/Quirky.app/Contents/Resources/app/bun',
      env: {},
      exists
    })
    expect(result.QUIRKY_DAEMON_ENTRY).toBe('/repo/packages/daemon/src/main.ts')
  })

  test('variables that are already set are left alone', () => {
    const result = resolveRuntimeEnv({
      packaged: true,
      moduleDir: '/a/app/bun',
      env: { QUIRKY_DAEMON_ENTRY: '/custom/daemon.ts', QUIRKY_UI_DIR: '/custom/ui' },
      exists: () => true
    })
    expect(Object.keys(result).sort()).toEqual(['QUIRKY_CLI_ENTRY', 'QUIRKY_PTY_HOST_ENTRY'])
  })

  test('source mode without a findable repo root falls back to the bundled resources', () => {
    const result = resolveRuntimeEnv({
      packaged: false,
      moduleDir: '/nowhere/app/bun',
      env: {},
      exists: () => false
    })
    expect(result.QUIRKY_DAEMON_ENTRY).toBe('/nowhere/app/resources/daemon.js')
  })
})

describe('findRepoRoot', () => {
  test('returns null when no ancestor contains the daemon entry', () => {
    expect(findRepoRoot('/a/b/c', () => false)).toBeNull()
  })
})
