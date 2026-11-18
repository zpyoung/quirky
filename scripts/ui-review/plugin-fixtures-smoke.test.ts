import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { captureApplication } from './capture'
import { captureBrowserExecutable } from './browser'

const FIXED_TARGETS = [
  'view:quirky.git/diff',
  'view:quirky.session/worktree',
  'view:quirky.reviews/create',
  'view:quirky.reviews/settings',
  'view:quirky.session-info/transcript',
  'view:quirky.loops/loop',
  'view:quirky.orchestration/remote-worker-output',
  'view:quirky.worktree/remote',
  'overlay:quirky.accounts/switch-dialog',
  'overlay:quirky.editor/close',
  'overlay:quirky.editor/quick-open',
  'overlay:quirky.handoff/dialog',
  'view:quirky.accounts/session-accessory',
  'status-bar:quirky.git/ahead-behind',
  'status-bar:quirky.reviews/checks'
]

test('plugin fixture surfaces capture in both themes without failures', async () => {
  const browserExecutable = captureBrowserExecutable()
  const scratch = mkdtempSync(join(tmpdir(), 'quirky-plugin-capture-'))
  const previousHome = process.env.QUIRKY_HOME
  process.env.QUIRKY_HOME = join(scratch, 'home')
  console.log(`plugin fixture smoke output: ${scratch}`)
  try {
    const manifest = await captureApplication({
      repoRoot: fileURLToPath(new URL('../..', import.meta.url)),
      outputDir: scratch,
      only: FIXED_TARGETS,
      skipBuild: false,
      browserExecutable,
      themes: ['dark', 'light'],
      timeoutMs: 180_000,
      signal: AbortSignal.timeout(890_000)
    })
    expect(manifest.failures).toEqual([])
    expect(manifest.captures).toHaveLength(2 * FIXED_TARGETS.length)
    for (const targetId of FIXED_TARGETS) {
      for (const theme of ['dark', 'light']) {
        expect(manifest.captures.find((cell) => cell.targetId === targetId && cell.theme === theme)?.status).toBe('captured')
      }
    }
    rmSync(scratch, { recursive: true, force: true })
  } finally {
    if (previousHome === undefined) delete process.env.QUIRKY_HOME
    else process.env.QUIRKY_HOME = previousHome
  }
}, 900_000)
