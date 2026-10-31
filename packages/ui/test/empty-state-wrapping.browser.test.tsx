import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { chromium } from 'playwright'
import { EmptyState } from '../src/design-system'

const executable = chromium.executablePath()

test.skipIf(!existsSync(executable))('EmptyState and Vault prose stay intact within narrow panels', async () => {
  const browser = await chromium.launch({ headless: true, args: process.platform === 'linux' ? ['--no-sandbox'] : [] })
  try {
    const page = await browser.newPage({ viewport: { width: 646, height: 480 } })
    const css = (await Promise.all(['tokens', 'components', 'vault', 'tasks-shell'].map((name) =>
      Bun.file(new URL(`../src/design-system/${name}.css`, import.meta.url)).text()
    ))).join('\n')
    const panels = [
      {
        sectionWidth: 90,
        className: 'quirky-tasks',
        message: 'No GitHub source is configured for this conversation.',
        words: ['configured', 'conversation'],
      },
      {
        sectionWidth: 84,
        message: 'Automations need a GitHub connection before this conversation can continue.',
        words: ['Automations', 'conversation'],
      },
      {
        sectionWidth: 68,
        message: 'GitHub authentication is required to access this conversation.',
        words: ['GitHub', 'required'],
      },
      {
        sectionWidth: 84,
        message: 'GitHub authentication is required to access this conversation.',
        words: ['conversation'],
      },
    ]

    for (const { sectionWidth, message, words, className = '' } of panels) {
      const markup = renderToStaticMarkup(<div className={className} style={{ width: sectionWidth }}><EmptyState message={message} /></div>)
      await page.setContent(`<!doctype html><style>${css}</style><main class="ui-gallery-theme" data-theme="dark" style="width:646px"><aside data-side-panel style="box-sizing:border-box;width:116px;padding:12px;font-family:system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif">${markup}</aside></main>`)
      const measurements = await page.locator('.ui-empty-state__message').evaluate((element, requestedWords) => {
        const text = element.firstChild
        if (!(text instanceof Text)) throw new Error('Expected the EmptyState message to be a text node')
        const panel = element.closest('[data-side-panel]')!.getBoundingClientRect()
        return requestedWords.map((word) => {
          const start = text.data.indexOf(word)
          if (start === -1) throw new Error(`Missing expected word: ${word}`)
          const range = document.createRange()
          range.setStart(text, start)
          range.setEnd(text, start + word.length)
          return {
            word,
            rects: Array.from(range.getClientRects(), ({ left, right }) => ({ left, right })),
            panel: { left: panel.left, right: panel.right },
          }
        })
      }, words)

      for (const { word, rects, panel } of measurements) {
        expect(rects, `${word} should remain intact`).toHaveLength(1)
        for (const rect of rects) {
          expect(rect.left).toBeGreaterThanOrEqual(panel.left - 0.5)
          expect(rect.right).toBeLessThanOrEqual(panel.right + 0.5)
        }
      }
    }

    const vaultMarkup = '<div class="qvh-root" style="width:116px;height:auto"><div class="qvh-controls"><div class="qvh-consent" data-vault-consent><p><strong>Search every agent session</strong> Find any past conversation by what was said in it, then pick up where the agent left off.</p></div></div></div>'
    await page.setContent(`<!doctype html><style>${css}</style><main class="ui-gallery-theme" data-theme="dark" style="width:646px"><aside data-vault-panel style="box-sizing:border-box;width:116px;font-family:system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif">${vaultMarkup}</aside></main>`)
    const vaultWord = await page.locator('.qvh-consent p').evaluate((paragraph, word) => {
      const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT)
      let text: Text | null = null
      while (walker.nextNode()) {
        const candidate = walker.currentNode as Text
        if (candidate.data.includes(word)) {
          text = candidate
          break
        }
      }
      if (!text) throw new Error(`Missing expected word: ${word}`)
      const start = text.data.indexOf(word)
      const range = document.createRange()
      range.setStart(text, start)
      range.setEnd(text, start + word.length)
      const card = paragraph.closest('.qvh-consent')!.getBoundingClientRect()
      const panel = paragraph.closest('[data-vault-panel]')!.getBoundingClientRect()
      return {
        rects: Array.from(range.getClientRects(), ({ left, right }) => ({ left, right })),
        card: { left: card.left, right: card.right },
        panel: { left: panel.left, right: panel.right },
      }
    }, 'conversation')
    expect(vaultWord.rects, 'conversation should remain intact').toHaveLength(1)
    for (const rect of vaultWord.rects) {
      expect(rect.left).toBeGreaterThanOrEqual(vaultWord.card.left - 0.5)
      expect(rect.right).toBeLessThanOrEqual(vaultWord.card.right + 0.5)
      expect(rect.left).toBeGreaterThanOrEqual(vaultWord.panel.left - 0.5)
      expect(rect.right).toBeLessThanOrEqual(vaultWord.panel.right + 0.5)
    }
  } finally {
    await browser.close()
  }
}, 60_000)

test.skipIf(!existsSync(executable))('Oversized tokens wrap inside empty-state and Vault panels', async () => {
  const browser = await chromium.launch({ headless: true, args: process.platform === 'linux' ? ['--no-sandbox'] : [] })
  try {
    const page = await browser.newPage({ viewport: { width: 646, height: 480 } })
    const css = (await Promise.all(['tokens', 'components', 'vault', 'tasks-shell'].map((name) =>
      Bun.file(new URL(`../src/design-system/${name}.css`, import.meta.url)).text()
    ))).join('\n')
    const token = 'a_really_long_repository_name_here'
    const message = `No GitHub remote is configured for ${token}.`
    const cases = [
      {
        markup: renderToStaticMarkup(<div className="quirky-tasks" style={{ width: 90 }}><EmptyState message={message} /></div>),
        selector: '.ui-empty-state__message',
        padding: 12,
      },
      {
        markup: `<div class="qvh-root" style="width:116px;height:auto"><div class="qvh-controls"><div class="qvh-consent"><p>${message}</p></div></div></div>`,
        selector: '.qvh-consent p',
        padding: 0,
      },
    ]
    for (const { markup, selector, padding } of cases) {
      await page.setContent(`<!doctype html><style>${css}</style><main class="ui-gallery-theme" data-theme="dark" style="width:646px"><aside data-side-panel style="box-sizing:border-box;width:116px;padding:${padding}px;font-family:system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif">${markup}</aside></main>`)
      const bounds = await page.locator(selector).evaluate((element, token) => {
        const text = element.firstChild
        if (!(text instanceof Text)) throw new Error('Expected a message text node')
        const start = text.data.indexOf(token)
        if (start === -1) throw new Error('Missing oversized token')
        const range = document.createRange()
        range.setStart(text, start)
        range.setEnd(text, start + token.length)
        const panel = element.closest('[data-side-panel]')!.getBoundingClientRect()
        const message = element.getBoundingClientRect()
        return {
          panel: { left: panel.left, right: panel.right },
          message: { left: message.left, right: message.right },
          token: Array.from(range.getClientRects(), ({ left, right }) => ({ left, right })),
        }
      }, token)
      expect(bounds.message.left, `${selector} stays inside the panel`).toBeGreaterThanOrEqual(bounds.panel.left - 0.5)
      expect(bounds.message.right, `${selector} stays inside the panel`).toBeLessThanOrEqual(bounds.panel.right + 0.5)
      expect(bounds.token.length, `${selector} wraps an oversized token`).toBeGreaterThan(1)
      for (const rect of bounds.token) {
        expect(rect.left).toBeGreaterThanOrEqual(bounds.message.left - 0.5)
        expect(rect.right).toBeLessThanOrEqual(bounds.message.right + 0.5)
      }
    }
  } finally {
    await browser.close()
  }
}, 60_000)

test.skipIf(!existsSync(executable))('Vault consent prose aligns with actions in wide panels', async () => {
  const browser = await chromium.launch({ headless: true, args: process.platform === 'linux' ? ['--no-sandbox'] : [] })
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 480 } })
    const css = (await Promise.all(['tokens', 'components', 'vault'].map((name) =>
      Bun.file(new URL(`../src/design-system/${name}.css`, import.meta.url)).text()
    ))).join('\n')
    const markup = '<div class="qvh-root" style="width:800px;height:auto"><div class="qvh-controls"><div class="qvh-consent"><p><strong>Search every agent session</strong> Find any past conversation by what was said in it, then pick up where the agent left off.</p><div class="qvh-consent-actions"><button>Enable Vault</button></div></div></div></div>'
    await page.setContent(`<!doctype html><style>${css}</style><main class="ui-gallery-theme" data-theme="dark" style="width:800px;font-family:system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif">${markup}</main>`)
    const alignment = await page.locator('.qvh-consent').evaluate((card) => ({
      paragraphLeft: card.querySelector('p')!.getBoundingClientRect().left,
      actionsLeft: card.querySelector('.qvh-consent-actions')!.getBoundingClientRect().left,
    }))
    expect(alignment.paragraphLeft).toBeCloseTo(alignment.actionsLeft, 1)
  } finally {
    await browser.close()
  }
}, 60_000)
