import path from 'node:path'
import { spawnProcess } from '@quirky/process-host'
import { BROWSER_SIDECAR_OWNER_ENV } from '../../../src/shared/browser-sidecar-lifetime'
import { resolveElectronExecutable } from './daemon-generation-runtime-fixture'
import { getQuirkyElectronLaunchArgs } from './electron-launch-args'
import { isolatedServeProfile } from './quirky-serve-cli-host'

// An IPC owner must be disconnectable independently of Playwright's app connection.
export function launchOwnedBrowserForE2E(profile: string): ReturnType<typeof spawnProcess> {
  const isolation = isolatedServeProfile(profile, {
    NODE_ENV: 'development',
    QUIRKY_BACKGROUND_LAUNCH: '1',
    QUIRKY_E2E_HEADLESS: '1'
  })
  return spawnProcess({
    program: resolveElectronExecutable(process.cwd()),
    args: [
      ...getQuirkyElectronLaunchArgs(path.join(process.cwd(), 'out', 'main', 'index.js'), false),
      '--serve',
      '--serve-port',
      '0',
      '--serve-json',
      '--serve-no-pairing',
      `--user-data-dir=${profile}`
    ],
    env: { ...isolation.env, [BROWSER_SIDECAR_OWNER_ENV]: '1' },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    serialization: 'json'
  })
}
