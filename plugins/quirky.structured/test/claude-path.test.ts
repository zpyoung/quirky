import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveClaudeThroughLoginShell } from '../claude-path'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fakeShell(body: string): string {
  const dir = mkdtempSync('/tmp/qs-shell-')
  dirs.push(dir)
  const path = join(dir, 'sh')
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

describe('resolveClaudeThroughLoginShell', () => {
  test('runs `command -v claude` in a login shell and returns the last line', async () => {
    const shell = fakeShell('[ "$1" = "-l" ] && [ "$2" = "-c" ] && [ "$3" = "command -v claude" ] && printf "noise\\n/opt/bin/claude\\n"')
    expect(await resolveClaudeThroughLoginShell(shell)).toBe('/opt/bin/claude')
  })

  test('throws when the shell finds no claude', async () => {
    await expect(resolveClaudeThroughLoginShell(fakeShell('exit 1'))).rejects.toThrow(
      'could not find the claude executable on the login shell PATH'
    )
  })
})
