import { afterEach, expect, test } from 'bun:test'
import { bootWindow, closeWindows, installUiPlugin, provide } from './fixtures/window-env'

afterEach(closeWindows)

async function openSettings(win: { click(selector: string): Promise<void>; waitFor<T>(check: () => T | undefined | null | false): Promise<T> }): Promise<void> {
  await win.click('button[aria-label="More"]')
  const row = await win.waitFor(() => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent?.trim() === 'Settings'))
  row.click()
}

test('SettingsDialog mounts a generic settings-section beside preserved scalar controls', async () => {
  const pluginId = 'acme.history'
  const sectionId = `settings-section:${pluginId}/search`
  const env = await bootWindow((installed) => {
    installUiPlugin(
      installed,
      pluginId,
      {
        'settings-section': [{ id: 'search', title: 'Agent Session Search', description: 'Local index status', order: 20 }],
        setting: [{ id: 'enabled', type: 'boolean', title: 'Enable search', default: false }]
      },
      provide(sectionId, "element.textContent = 'Search status: current'")
    )
  })

  await openSettings(env.win)
  await env.win.waitFor(() => env.win.document.querySelector(`[data-plugin-slot="${sectionId}"]`))
  await env.win.waitFor(() => env.win.document.body.textContent?.includes('Search status: current'))

  expect(env.win.document.body.textContent).toContain('Agent Session Search')
  expect(env.win.document.body.textContent).toContain('Enable search')
  expect(env.win.document.querySelector(`[data-plugin-slot="${sectionId}"]`)).not.toBeNull()
  expect(env.win.document.querySelector('input[type="checkbox"]')).not.toBeNull()
})
