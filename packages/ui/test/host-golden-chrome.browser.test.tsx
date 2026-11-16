import { beforeAll, afterAll, expect, test } from 'bun:test'
import { accessSync, constants } from 'node:fs'
import { chromium, type Browser } from 'playwright'
import { renderToStaticMarkup } from 'react-dom/server'
import { ControlIcon, ListRow, Tabs, TextField } from '../src/design-system'
import * as capture from '../../../scripts/ui-review/capture'

const candidates = [
  chromium.executablePath(),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
]
const executable = candidates.find((path) => {
  try { accessSync(path, constants.X_OK); return true } catch { return false }
})
if (!executable && process.env.CI === 'true') {
  throw new Error(`host-golden-chrome needs Chromium or Chrome; none found at ${candidates.join(', ')}`)
}
let browser: Browser
beforeAll(async () => {
  if (executable) browser = await chromium.launch({ headless: true, executablePath: executable })
})
afterAll(async () => { await browser?.close() })

test.skipIf(!executable)('Settings opens from the Window bar when a plugin also has a More button', async () => {
  const page = await browser.newPage()
  try {
    await page.setContent(`
      <header class="window-bar" aria-label="Window bar">
        <button aria-label="More" onclick="document.querySelector('[role=menu]').hidden=false">Host</button>
      </header>
      <section data-plugin-slot="sidebar:worktrees">
        <button aria-label="More" onclick="document.body.dataset.pluginClicked='true'">Plugin</button>
      </section>
      <div role="menu" hidden><button role="menuitem" onclick="document.querySelector('[role=dialog]').hidden=false">Settings</button></div>
      <div role="dialog" aria-label="Settings" hidden>Settings content</div>
    `)
    await capture.openSettings({ page, options: { timeoutMs: 1_000 } } as Parameters<typeof capture.openSettings>[0])
    expect(await page.getByRole('dialog', { name: 'Settings', exact: true }).isVisible()).toBe(true)
    expect(await page.locator('body').getAttribute('data-plugin-clicked')).toBeNull()
  } finally {
    await page.close()
  }
})
test.skipIf(!executable)('rejects unavailable host Settings controls without clicking plugin More', async () => {
  const cases = [
    {
      hostControls: '',
      hostMenu: '',
      expectedError: 'host Overflow control is unavailable'
    },
    {
      hostControls: `
        <button aria-label="More">Host one</button>
        <button aria-label="More">Host two</button>
      `,
      hostMenu: '',
      expectedError: 'host Overflow control is unavailable'
    },
    {
      hostControls: `<button aria-label="More" onclick="document.querySelector('[role=menu]').hidden=false">Host</button>`,
      hostMenu: `<div role="menu" hidden><button role="menuitem">Help</button></div>`,
      expectedError: 'host Settings control is unavailable'
    }
  ]
  for (const scenario of cases) {
    const page = await browser.newPage()
    try {
      await page.setContent(`
        <header class="window-bar" aria-label="Window bar">
          ${scenario.hostControls}
        </header>
        <section data-plugin-slot="sidebar:worktrees">
          <button aria-label="More" onclick="document.body.dataset.pluginClicked='true'">Plugin</button>
        </section>
        ${scenario.hostMenu}
      `)
      const error = await capture.openSettings({ page, options: { timeoutMs: 1_000 } } as Parameters<typeof capture.openSettings>[0])
        .then(() => null, (reason: unknown) => reason)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toBe(scenario.expectedError)
      expect(await page.locator('body').getAttribute('data-plugin-clicked')).toBeNull()
    } finally {
      await page.close()
    }
  }
})

test.skipIf(!executable)('the palette probe requires its named search field inside the Command palette dialog', async () => {
  const page = await browser.newPage()
  try {
    const field = '<input aria-label="Search commands, tools, views, worktrees, and files">'
    await page.setContent(`<div role="dialog" aria-label="Command palette">${field}</div>`)
    expect(await capture.paletteFieldMounted(page)).toBe(true)
    await page.setContent(`${field}<div role="dialog" aria-label="Command palette"><input aria-label="Unrelated"></div>`)
    expect(await capture.paletteFieldMounted(page)).toBe(false)
    await page.setContent(field)
    expect(await capture.paletteFieldMounted(page)).toBe(false)
  } finally {
    await page.close()
  }
})

const themes = [
  { name: 'dark', surface: 'rgb(22, 23, 27)', selected: 'rgb(34, 36, 43)', text: 'rgb(230, 231, 235)', muted: 'rgb(141, 145, 155)', accent: 'rgb(124, 140, 255)', rail: 'rgb(12, 13, 15)' },
  { name: 'light', surface: 'rgb(255, 255, 255)', selected: 'rgb(231, 233, 239)', text: 'rgb(32, 35, 42)', muted: 'rgb(107, 114, 128)', accent: 'rgb(91, 108, 255)', rail: 'rgb(238, 240, 243)' }
] as const

async function styledPage(theme: string, markup: string) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 880 } })
  const styles = await Promise.all([
    '../src/design-system/tokens.css',
    '../src/design-system/components.css',
    '../src/shell/chrome.css'
  ].map((path) => Bun.file(new URL(path, import.meta.url)).text()))
  await page.setContent(`<html data-theme="${theme}"><head><style>${styles.join('\n')}</style></head><body>${markup}</body></html>`)
  return page
}

for (const theme of themes) {
  test.skipIf(!executable)(`underline tabs match the center strip without changing boxed tabs (${theme.name})`, async () => {
    const items = [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }]
    const page = await styledPage(theme.name, renderToStaticMarkup(<>
      <Tabs label="Underline" variant="underline" items={items} value="one" onChange={() => {}} />
      <Tabs label="Default" items={items} value="one" onChange={() => {}} />
    </>))
    try {
      const strip = page.getByRole('tablist', { name: 'Underline' })
      expect(await strip.getAttribute('class')).toBe('ui-tabs ui-tabs--underline')
      const rule = await strip.evaluate((node) => {
        const style = getComputedStyle(node)
        return { width: style.borderBottomWidth, style: style.borderBottomStyle, color: style.borderBottomColor, border: style.getPropertyValue('--ui-border').trim() }
      })
      expect(rule.width).toBe('1px')
      expect(rule.style).toBe('solid')
      const selected = await strip.getByRole('tab', { selected: true }).evaluate((node) => {
        const style = getComputedStyle(node)
        return { background: style.backgroundColor, color: style.color, border: style.borderTopWidth, radius: style.borderRadius, shadow: style.boxShadow }
      })
      expect(selected.background).toBe(theme.surface)
      expect(selected.border).toBe('0px')
      expect(selected.radius).toBe('0px')
      expect(selected.shadow).toContain('inset')
      expect(selected.shadow).toContain('-2px')
      expect(selected.shadow).toContain(theme.accent)
      const unselected = await strip.getByRole('tab', { selected: false }).evaluate((node) => {
        const style = getComputedStyle(node)
        return { background: style.backgroundColor, border: style.borderTopWidth, shadow: style.boxShadow, color: style.color }
      })
      expect(unselected.background).toBe('rgba(0, 0, 0, 0)')
      expect(unselected.border).toBe('0px')
      expect(unselected.shadow).toBe('none')
      const tokenColors = await strip.evaluate((node) => {
        const probe = document.createElement('span')
        node.append(probe)
        probe.style.color = 'var(--ui-text)'
        const text = getComputedStyle(probe).color
        probe.style.color = 'var(--ui-muted)'
        const muted = getComputedStyle(probe).color
        probe.style.color = 'var(--ui-border)'
        const border = getComputedStyle(probe).color
        probe.remove()
        return { text, muted, border }
      })
      expect(selected.color).toBe(tokenColors.text)
      expect(unselected.color).toBe(tokenColors.muted)
      expect(rule.color).toBe(tokenColors.border)
      const boxed = page.getByRole('tablist', { name: 'Default' })
      expect(await boxed.getAttribute('class')).toBe('ui-tabs')
      expect(await boxed.getByRole('tab', { selected: true }).evaluate((node) => {
        const style = getComputedStyle(node)
        return [style.backgroundColor, style.borderTopWidth]
      })).toEqual([theme.selected, '1px'])
    } finally {
      await page.close()
    }
  })

  test.skipIf(!executable)(`top dialogs are search popups while centered dialogs retain their scrim (${theme.name})`, async () => {
    const dialog = '<section class="ui-dialog"><header class="ui-dialog__header"><h2 class="ui-dialog__title">Command palette</h2><button class="ui-dialog__close" aria-label="Close dialog">×</button></header><div class="ui-dialog__body">Search</div></section>'
    const page = await styledPage(theme.name, `<div class="ui-dialog-backdrop ui-dialog-backdrop--top">${dialog}</div><div class="ui-dialog-backdrop" id="center">${dialog}</div>`)
    try {
      expect(await page.locator('.ui-dialog-backdrop--top').evaluate((node) => getComputedStyle(node, '::before').opacity)).toBe('0')
      expect(await page.locator('#center').evaluate((node) => getComputedStyle(node, '::before').opacity)).toBe('0.78')
      const popup = page.locator('.ui-dialog-backdrop--top')
      expect(await popup.locator('.ui-dialog').evaluate((node) => getComputedStyle(node).boxShadow)).not.toBe('none')
      const title = await popup.locator('.ui-dialog__title').evaluate((node) => {
        const style = getComputedStyle(node)
        return { width: style.width, clip: style.clip }
      })
      expect(title.width).toBe('1px')
      expect(title.clip).not.toBe('auto')
      expect(await popup.locator('.ui-dialog__header').evaluate((node) => getComputedStyle(node).position)).toBe('absolute')
      expect(await popup.locator('.ui-dialog__close').evaluate((node) => {
        const style = getComputedStyle(node)
        return [style.borderTopColor, style.backgroundColor]
      })).toEqual(['rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)'])
    } finally {
      await page.close()
    }
  })

  test.skipIf(!executable)(`palette search and results use the golden popup surfaces (${theme.name})`, async () => {
    const page = await styledPage(theme.name, renderToStaticMarkup(
      <div className="shell-palette">
        <div className="shell-palette__search"><ControlIcon name="magnifying-glass" /><TextField label="Search" value="" readOnly /></div>
        <div className="ui-option-list"><ListRow title="Open view" description="A view" selected /></div>
      </div>
    ))
    try {
      expect(await page.locator('.shell-palette__search').evaluate((node) => getComputedStyle(node).backgroundColor)).toBe(theme.selected)
      expect(await page.getByRole('textbox').evaluate((node) => {
        const style = getComputedStyle(node)
        return [style.borderTopColor, style.backgroundColor]
      })).toEqual(['rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)'])
      expect(await page.locator('.ui-text-field__label').evaluate((node) => {
        const style = getComputedStyle(node)
        return [style.width, style.clip !== 'auto']
      })).toEqual(['1px', true])
      expect(await page.locator('.ui-option-list').evaluate((node) => {
        const style = getComputedStyle(node)
        return [style.backgroundColor, style.borderTopWidth, style.maxHeight]
      })).toEqual(['rgba(0, 0, 0, 0)', '0px', '528px'])
      expect(await page.locator('.ui-list-row--selected').evaluate((node) => {
        const style = getComputedStyle(node)
        const description = node.querySelector('.ui-list-row__description')!
        return [style.backgroundColor, style.color, getComputedStyle(description).color, style.borderTopWidth]
      })).toEqual([theme.accent, theme.rail, theme.rail, '0px'])
    } finally {
      await page.close()
    }
  })
}
