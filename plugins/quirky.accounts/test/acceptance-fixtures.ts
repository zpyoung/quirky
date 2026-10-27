import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { QuirkyClient } from '@quirky/protocol'
import { startHarness, type Harness } from '../../../packages/daemon/test/helpers'
import { PLUGIN_DIR, type AccountsHarness } from './support/index'

type ProviderResponse = Response | null
type ProviderHandler = (url: URL, init?: RequestInit) => ProviderResponse | Promise<ProviderResponse>

type FetchFixture = { restore(): Promise<void> }
const activeFetchFixtures = new Set<() => Promise<void>>()

function requestUrl(input: RequestInfo | URL): URL {
  const text = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  return new URL(text)
}

/** Intercepts selected external provider responses while preserving the harness's loopback-only fetch. */
export function interceptProviderFetch(handler: ProviderHandler): FetchFixture {
  const upstream = globalThis.fetch
  const pending = new Set<Promise<ProviderResponse>>()
  const installed = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = requestUrl(input)
      if (url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)) {
        return upstream(input, init)
      }
      const responsePromise = Promise.resolve(handler(url, init))
      pending.add(responsePromise)
      let response: ProviderResponse
      try {
        response = await responsePromise
      } finally {
        pending.delete(responsePromise)
      }
      return response ?? upstream(input, init)
    },
    { preconnect: upstream.preconnect }
  )
  globalThis.fetch = installed

  let restored = false
  const restore = async (): Promise<void> => {
    if (restored) return
    while (pending.size > 0) await Promise.allSettled([...pending])
    if (globalThis.fetch === installed) globalThis.fetch = upstream
    restored = true
    activeFetchFixtures.delete(restore)
  }
  activeFetchFixtures.add(restore)
  return { restore }
}

export async function restoreProviderFetchFixtures(): Promise<void> {
  for (const restore of [...activeFetchFixtures].reverse()) await restore()
}

export function writePrivateJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 })
  chmodSync(path, 0o600)
}

export function writeCursorCliCredential(home: string, token: string): void {
  let cliDirectory: string
  if (process.platform === 'darwin') {
    cliDirectory = join(home, '.cursor')
  } else if (process.platform === 'win32') {
    const root = process.env.APPDATA?.trim() || join(home, 'AppData', 'Roaming')
    cliDirectory = join(root, 'Cursor')
  } else {
    const root = process.env.XDG_CONFIG_HOME?.trim() || join(home, '.config')
    cliDirectory = join(root, 'cursor')
  }
  writePrivateJson(join(cliDirectory, 'auth.json'), { accessToken: token })
}

export function writeAntigravityCli(fakeBin: string): void {
  const path = join(fakeBin, 'agy')
  const response = {
    status: 'SUCCESS',
    command: {
      name: 'usage',
      data: {
        groups: [{
          name: 'Gemini Models',
          buckets: [
            { id: 'gemini-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 0.4, reset_time: '2026-10-27T13:00:00.000Z' },
            { id: 'gemini-5h', name: '5 Hour Limit', window: '5h', remaining_fraction: 0.75, reset_time: '2026-10-27T13:00:00.000Z' }
          ]
        }]
      }
    }
  }
  writeFileSync(path, `#!/bin/sh\nif [ "$1" = "--version" ]; then printf 'agy 1.1.11\\n'; exit 0; fi\nprintf '%s\\n' '${JSON.stringify(response)}'\n`, { mode: 0o700 })
  chmodSync(path, 0o700)
}

export type RestartedAccounts = { harness: Harness; client: QuirkyClient; close(): Promise<void> }

/** Restarts the same private daemon home without removing its durable store. */
export async function restartAccounts(h: AccountsHarness): Promise<RestartedAccounts> {
  for (const client of h.harness.clients) client.close()
  await h.harness.daemon.stop()
  const stopPty = h.harness.pty.stop.bind(h.harness.pty)
  let ptyStopped = false
  h.harness.pty.stop = () => {
    if (ptyStopped) return
    ptyStopped = true
    stopPty()
  }
  h.harness.pty.stop()

  const temp = mkdtempSync(join(tmpdir(), 'quirky-accounts-restart-'))
  const builtinsDir = join(temp, 'builtin')
  mkdirSync(builtinsDir, { recursive: true, mode: 0o700 })
  symlinkSync(PLUGIN_DIR, join(builtinsDir, 'quirky.accounts'))
  symlinkSync(resolve(PLUGIN_DIR, '../quirky.ask'), join(builtinsDir, 'quirky.ask'))

  let harness: Harness
  try {
    harness = await startHarness({ home: h.home, builtinPluginsDir: builtinsDir })
  } catch (error) {
    rmSync(temp, { recursive: true, force: true })
    throw error
  }
  const client = await harness.connect('cli', 'accounts-acceptance-restart')
  await client.call('events.subscribe', {})
  return {
    harness,
    client,
    async close() {
      for (const connected of harness.clients) connected.close()
      await harness.daemon.stop()
      harness.pty.stop()
      rmSync(temp, { recursive: true, force: true })
    }
  }
}
