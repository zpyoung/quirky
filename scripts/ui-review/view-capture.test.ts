import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { captureApplication } from './capture'
import { captureBrowserExecutable } from './browser'

const VIEW_TARGETS = ['view:quirky.view/render', 'view:quirky.view/pane']
const THEMES = ['dark', 'light'] as const

test('quirky.view captures representative render and pane content in both themes', async () => {
  const browserExecutable = captureBrowserExecutable()
  const scratch = mkdtempSync(join(tmpdir(), 'quirky-view-capture-'))
  const previousHome = process.env.QUIRKY_HOME
  process.env.QUIRKY_HOME = join(scratch, 'home')

  try {
    const manifest = await captureApplication({
      repoRoot: fileURLToPath(new URL('../..', import.meta.url)),
      outputDir: scratch,
      only: VIEW_TARGETS,
      skipBuild: false,
      browserExecutable,
      themes: THEMES,
      timeoutMs: 180_000,
      signal: AbortSignal.timeout(890_000)
    })

    expect(manifest.failures).toEqual([])
    expect(manifest.captures).toHaveLength(4)
    expect(manifest.captures.map(({ targetId, theme }) => `${targetId}/${theme}`).sort()).toEqual(
      VIEW_TARGETS.flatMap((targetId) => THEMES.map((theme) => `${targetId}/${theme}`)).sort()
    )
    for (const targetId of VIEW_TARGETS) {
      for (const theme of THEMES) {
        const capture = manifest.captures.find((cell) => cell.targetId === targetId && cell.theme === theme)
        expect(capture?.status).toBe('captured')
        expect(capture?.image).not.toBeNull()
      }
    }
    console.log('quirky.view: 4 captured cells (render/pane, dark/light); no review or score')
  } finally {
    if (previousHome === undefined) delete process.env.QUIRKY_HOME
    else process.env.QUIRKY_HOME = previousHome
    rmSync(scratch, { recursive: true, force: true })
  }
}, 900_000)
