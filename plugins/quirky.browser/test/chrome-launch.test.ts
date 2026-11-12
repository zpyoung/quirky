import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { startChrome } from '../src/runtime/chrome'

test('owned Chrome uses the mock keychain on macOS, where its private HOME hides the login keychain', async () => {
  const profileRoot = mkdtempSync(join(tmpdir(), 'quirky-chrome-launch-'))
  const launched: string[][] = []
  try {
    const chrome = await startChrome(profileRoot, {
      runtimeRoot: profileRoot,
      // any absolute executable passes findChrome; the recording spawn never runs it
      chromePath: process.execPath,
      spawn(command, options) {
        launched.push([...command])
        const userDataDir = command.find((arg) => arg.startsWith('--user-data-dir='))!.slice('--user-data-dir='.length)
        writeFileSync(join(userDataDir, 'DevToolsActivePort'), '9222\n/devtools/browser/launch-test\n')
        return Bun.spawn(['sleep', '30'], options)
      }
    })
    await chrome.asyncClose()

    expect(launched).toHaveLength(1)
    expect(launched[0]!.includes('--use-mock-keychain')).toBe(process.platform === 'darwin')
  } finally {
    rmSync(profileRoot, { recursive: true, force: true })
  }
})
