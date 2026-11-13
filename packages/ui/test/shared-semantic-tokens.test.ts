import { beforeAll, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { chromium } from 'playwright'
import { DARK_THEME, LIGHT_THEME } from '@quirky/protocol'
import { collectInventory } from '../../../scripts/ui-scoreboard/inventory'
import { checkHostTokens, sharedTokenEvidence } from '../../../scripts/ui-scoreboard/tokens'

const repoRoot = new URL('../../../', import.meta.url).pathname
const browserAvailable = existsSync(chromium.executablePath())
let styles: string

beforeAll(async () => {
  const sheets = await Promise.all([
    '../src/design-system/compatibility-tokens.css',
    '../src/design-system/tokens.css',
    '../src/styles.css',
    '../src/shell/tool-shell.css'
  ].map((path) => Bun.file(new URL(path, import.meta.url)).text()))
  styles = sheets.map((sheet) => sheet.replace(/^@import ['"][^'"]+['"];\s*/gm, '')).join('\n')
})


test('the shared UI consumes only resolved semantic tokens', () => {
  const inventory = collectInventory(repoRoot)
  expect(sharedTokenEvidence(inventory)).toEqual([])
  expect(checkHostTokens(inventory).status).toBe('pass')
}, 30_000)

test.skipIf(!browserAvailable)('tool-shell chrome remains pixel-valued for numeric readers in both themes', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(`<style>${styles}</style><div class="shell-workspace"><div id="length"></div></div>`)
    for (const theme of ['dark', 'light']) {
      const chrome = await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme
        const shell = document.querySelector<HTMLElement>('.shell-workspace')!
        const computed = getComputedStyle(shell)
        const length = document.querySelector<HTMLElement>('#length')!
        length.style.width = 'calc(42 * var(--ui-length-unit))'
        return {
          rail: Number.parseFloat(computed.getPropertyValue('--tool-shell-rail-width')),
          centerMinWidth: Number.parseFloat(computed.getPropertyValue('--tool-shell-center-min-width')),
          centerMinHeight: Number.parseFloat(computed.getPropertyValue('--tool-shell-center-min-height')),
          length: getComputedStyle(length).width
        }
      }, theme)
      expect(chrome).toEqual({ rail: 42, centerMinWidth: 320, centerMinHeight: 72, length: '42px' })
    }
  } finally {
    await browser.close()
  }
})

test.skipIf(!browserAvailable)('stylesheet defaults follow the graphite palette before appearance initialization', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(`<style>${styles}</style><div id="probe"></div>`)
    for (const palette of [DARK_THEME, LIGHT_THEME]) {
      const colors = await page.evaluate(({ appearance }) => {
        document.documentElement.dataset.theme = appearance
        const root = getComputedStyle(document.documentElement)
        const probe = document.querySelector<HTMLElement>('#probe')!
        const canvas = document.createElement('canvas')
        canvas.width = canvas.height = 1
        const context = canvas.getContext('2d')!
        const result: Record<string, number[]> = {}
        for (const token of ['bg', 'bg-raised', 'bg-hover', 'bg-active', 'border', 'text', 'muted', 'accent', 'amber', 'green', 'grey', 'dim', 'danger']) {
          probe.style.color = `var(--${token})`
          context.fillStyle = getComputedStyle(probe).color
          context.fillRect(0, 0, 1, 1)
          result[token] = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3)
        }
        return {
          palette: result,
          unread: ['modified', 'added', 'deleted', 'renamed', 'untracked'].map((status) => root.getPropertyValue(`--git-${status}`))
        }
      }, palette)
      for (const [token, rgb] of Object.entries(colors.palette)) {
        if (token === 'dim') {
          const expected = palette.appearance === 'dark' ? [74, 77, 84] : [178, 182, 188]
          rgb.forEach((channel, index) => expect(Math.abs(channel - expected[index]!)).toBeLessThanOrEqual(1))
        } else {
          const hex = palette.colors[token as keyof typeof palette.colors]
          expect(rgb).toEqual([1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)))
        }
      }
      expect(colors.unread).toEqual(['', '', '', '', ''])
    }
  } finally {
    await browser.close()
  }
})
