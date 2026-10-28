import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { startBrowserHarness, type BrowserTestHarness } from './harness'

const call = (h: BrowserTestHarness, method: string, params: Record<string, unknown> = {}) =>
  h.client.callAny(`quirky.browser/${method}`, params)

async function newPage(h: BrowserTestHarness, url = `${h.fixtureUrl}first`) {
  return await call(h, 'tabCreate', { url }) as { browserPageId: string }
}

test('preferences and profile listings do not detect source browsers until explicitly requested', async () => {
  const sourceRoot = mkdtempSync(join(tmpdir(), 'quirky-browser-synthetic-source-'))
  const h = await startBrowserHarness({ sourceRoots: {
    chrome: sourceRoot, edge: sourceRoot, arc: sourceRoot, chromium: sourceRoot,
    comet: sourceRoot, helium: sourceRoot, firefox: sourceRoot,
    safari: join(sourceRoot, 'Cookies.binarycookies')
  } })
  try {
    await call(h, 'preferencesState')
    await call(h, 'profileList')
    expect(h.spawnCount()).toBe(0)

    const detected = await call(h, 'detectBrowsers') as { browsers: unknown[] }
    expect(detected.browsers).toEqual([])
    expect(h.spawnCount()).toBe(0)
  } finally {
    await h.cleanup()
    rmSync(sourceRoot, { recursive: true, force: true })
  }
})
test('daemon imports an explicit JSON cookie source into a managed profile', async () => {
  const h = await startBrowserHarness()
  try {
    const summary = await call(h, 'importCookies', {
      profile: 'default',
      source: {
        kind: 'json',
        cookies: [{ name: 'session', value: 'json-fixture', domain: 'example.test', path: '/', secure: false, httpOnly: false, hostOnly: true }]
      },
      yes: true
    }) as { totalCookies: number; importedCookies: number; domains: string[] }
    expect(summary).toMatchObject({ totalCookies: 1, importedCookies: 1, domains: ['example.test'] })

    const profiles = await call(h, 'profileList') as { profiles: Array<{ id: string; scope: string; source?: { browserFamily: string } }> }
    expect(profiles.profiles.find(({ id }) => id === 'default')).toMatchObject({
      scope: 'imported',
      source: { browserFamily: 'json' }
    })
  } finally { await h.cleanup() }
}, 90_000)


test('page profile methods select, report, restore Default, and clone through the public API', async () => {
  const h = await startBrowserHarness()
  try {
    const page = await newPage(h)
    const destination = await call(h, 'profileCreate', { name: 'Review Target' }) as { profile: { id: string } }

    expect(await call(h, 'tabProfileShow', { page: page.browserPageId })).toMatchObject({
      browserPageId: page.browserPageId,
      profileId: 'default',
      profileLabel: 'Default'
    })
    expect(await call(h, 'tabProfileSet', { page: page.browserPageId, profile: destination.profile.id })).toMatchObject({
      browserPageId: page.browserPageId,
      profileId: destination.profile.id,
      profileLabel: 'Review Target'
    })
    expect(await call(h, 'tabProfileUseDefault', { page: page.browserPageId })).toMatchObject({
      browserPageId: page.browserPageId,
      profileId: 'default',
      profileLabel: 'Default'
    })

    const cloneDestination = await call(h, 'profileCreate', { name: 'Clone Target' }) as { profile: { id: string } }
    const clone = await call(h, 'profileClone', { source: page.browserPageId, profile: cloneDestination.profile.id }) as {
      browserPageId: string
      sourceBrowserPageId: string
      profileId: string
      profileLabel: string
    }
    expect(clone).toMatchObject({ sourceBrowserPageId: page.browserPageId, profileId: cloneDestination.profile.id, profileLabel: 'Clone Target' })
    expect(clone.browserPageId).not.toBe(page.browserPageId)
  } finally { await h.cleanup() }
}, 90_000)

test('identity API writes the shared Chrome setting and reports restart semantics', async () => {
  const h = await startBrowserHarness()
  try {
    expect(await call(h, 'identitySet', { mode: 'native' })).toMatchObject({ mode: 'native', active: 'clean', restartRequired: true })
    expect(await call(h, 'identityGet')).toMatchObject({ mode: 'native', active: 'clean', restartRequired: true })
    const preferences = await call(h, 'preferencesState') as { identity: { selected: string; active: string; restartRequired: boolean; nativeSupported: false } }
    expect(preferences.identity).toEqual({ selected: 'native', active: 'clean', restartRequired: true, nativeSupported: false })
  } finally { await h.cleanup() }
})
