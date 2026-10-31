import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = mkdtempSync(join(tmpdir(), 'qa-web-'))
let fixture: ReturnType<typeof Bun.spawn> | undefined

afterEach(async () => {
  fixture?.kill('SIGKILL')
  rmSync(out, { recursive: true, force: true })
})

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(path)) {
    if (fixture?.exitCode !== null && fixture?.exitCode !== undefined) throw new Error(`the fixture exited with ${fixture.exitCode}`)
    if (Date.now() > deadline) throw new Error(`no ${path} after ${timeoutMs} ms`)
    await Bun.sleep(100)
  }
}

// builds the renderer and registers Git fixtures, so this takes far longer than bun's default timeout
test('serves the renderer from an isolated home and removes the home on SIGTERM', async () => {
  fixture = Bun.spawn([process.execPath, join(import.meta.dir, 'web-fixture.ts'), out], { stdout: 'ignore', stderr: 'inherit' })
  const path = join(out, 'fixture.json')
  await waitForFile(path, 150_000)
  const { url, home, repo } = JSON.parse(readFileSync(path, 'utf8')) as { url: string; home: string; repo: string }
  expect(home).not.toBe(process.env.QUIRKY_HOME)
  // macOS reaches the temp dir through both /var and /private/var
  expect(realpathSync(repo).startsWith(realpathSync(home))).toBe(true)
  const page = await fetch(url)
  expect(page.status).toBe(200)
  expect(await page.text()).toContain('<html')
  fixture.kill('SIGTERM')
  await fixture.exited
  expect(existsSync(home)).toBe(false)
}, 180_000)
