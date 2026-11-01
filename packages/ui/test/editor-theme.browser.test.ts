import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, type Browser } from 'playwright'

const executable = chromium.executablePath()

function browserEntry(): string {
  return `
    import { MergeView } from '@codemirror/merge'
    import { editorTheme } from ${JSON.stringify(join(import.meta.dir, '../src/editor-theme.ts'))}

    let view
    window.mountMergeView = (original, modified) => {
      view?.destroy()
      view = new MergeView({
        a: { doc: original, extensions: [editorTheme] },
        b: { doc: modified, extensions: [editorTheme] },
        parent: document.getElementById('merge-root'),
        gutter: true,
        highlightChanges: true
      })
    }
  `
}

test.skipIf(!existsSync(executable))('MergeView change gutters use failing and working token colors by side', async () => {
  const tempDir = mkdtempSync(join(import.meta.dir, '.editor-theme-browser-'))
  let browser: Browser | null = null
  try {
    const entrypoint = join(tempDir, 'browser-entry.ts')
    writeFileSync(entrypoint, browserEntry())
    const result = await Bun.build({ entrypoints: [entrypoint], target: 'browser', format: 'iife' })
    if (!result.success) throw new Error(result.logs.map((log) => log.message).join('\n'))
    const output = result.outputs[0]
    if (!output) throw new Error('The editor-theme browser bundle was empty.')
    const bundle = await output.text()

    browser = await chromium.launch({
      headless: true,
      executablePath: executable,
      args: process.platform === 'linux' ? ['--no-sandbox'] : []
    })
    const page = await browser.newPage({ viewport: { width: 900, height: 420 } })
    const tokens = await Bun.file(new URL('../src/design-system/tokens.css', import.meta.url)).text()
    await page.setContent(`<!doctype html>
      <html data-theme="dark">
        <head>
          <meta charset="utf-8">
          <style>
            html, body { margin: 0; }
            #merge-root { width: 900px; height: 360px; }
            .color-probe { position: absolute; width: 1px; height: 1px; visibility: hidden; }
          </style>
          <style>${tokens}</style>
        </head>
        <body>
          <div id="merge-root"></div>
          <div class="color-probe" data-token="failing" style="background-color:var(--ui-failing)"></div>
          <div class="color-probe" data-token="working" style="background-color:var(--ui-working)"></div>
        </body>
      </html>`)
    await page.addScriptTag({ content: bundle })

    const cases = [
      { name: 'replacement', original: 'before\nold\nafter', modified: 'before\nnew\nafter', originalCount: 1, modifiedCount: 1 },
      { name: 'line deletion', original: 'before\nremoved\nafter', modified: 'before\nafter', originalCount: 1, modifiedCount: 0 },
      { name: 'full-file deletion', original: 'removed', modified: '', originalCount: 1, modifiedCount: 0 },
      { name: 'addition', original: 'before\nafter', modified: 'before\nadded\nafter', originalCount: 0, modifiedCount: 1 }
    ]

    for (const scenario of cases) {
      await page.evaluate(({ original, modified }) => {
        ;(window as typeof window & { mountMergeView(a: string, b: string): void }).mountMergeView(original, modified)
      }, scenario)
      await page.evaluate(() => {
        const { promise, resolve } = Promise.withResolvers<void>()
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        return promise
      })

      const rendered = await page.evaluate(() => {
        const tokenColor = (name: string) => {
          const probe = document.querySelector<HTMLElement>(`[data-token="${name}"]`)
          if (!probe) throw new Error(`Missing ${name} color probe`)
          return getComputedStyle(probe).backgroundColor
        }
        const markers = (side: 'a' | 'b') =>
          [...document.querySelectorAll<HTMLElement>(`#merge-root .cm-merge-${side} .cm-gutterElement.cm-changedLineGutter`)].map((marker) => {
            const rect = marker.getBoundingClientRect()
            return { color: getComputedStyle(marker).backgroundColor, width: rect.width, height: rect.height }
          })
        return { failing: tokenColor('failing'), working: tokenColor('working'), a: markers('a'), b: markers('b') }
      })

      expect(rendered.a, `${scenario.name}: original marker count`).toHaveLength(scenario.originalCount)
      expect(rendered.b, `${scenario.name}: modified marker count`).toHaveLength(scenario.modifiedCount)
      for (const [side, markers, color] of [
        ['original', rendered.a, rendered.failing],
        ['modified', rendered.b, rendered.working]
      ] as const) {
        for (const [index, marker] of markers.entries()) {
          expect(marker.color, `${scenario.name}: ${side} marker ${index} color`).toBe(color)
          expect(marker.width, `${scenario.name}: ${side} marker ${index} width`).toBeGreaterThan(0)
          expect(marker.height, `${scenario.name}: ${side} marker ${index} height`).toBeGreaterThan(0)
        }
      }
    }
  } finally {
    try {
      await browser?.close()
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  }
}, 60_000)
