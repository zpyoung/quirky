#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createProcessScope } from './test-support/process-scope'

const bashPaths = Bun.argv.slice(2).map(path => resolve(path))
if (bashPaths.length !== 2) {
  console.error('usage: bun run test:bash -- <bash-5.2-path> <bash-5.3-path>')
  process.exit(2)
}

for (const [index, expected] of ['5.2', '5.3'].entries()) {
  const binary = bashPaths[index]!
  let output = ''
  let exitCode = 1
  try {
    const result = Bun.spawnSync([binary, '--version'], { stdout: 'pipe', stderr: 'pipe' })
    output = `${result.stdout.toString()}${result.stderr.toString()}`
    exitCode = result.exitCode
  } catch (error) {
    console.error(`Cannot run Bash ${expected} binary ${binary}: ${String(error)}`)
    process.exit(1)
  }
  const match = output.match(/^GNU bash, version (\d+)\.(\d+)(?:\.\d+)?/m)
  const actual = match ? `${match[1]}.${match[2]}` : 'unverified'
  if (exitCode !== 0 || actual !== expected) {
    console.error(`Expected Bash ${expected} at ${binary}, got ${actual} (exit ${exitCode}): ${output.trim()}`)
    process.exit(1)
  }
  console.log(`Verified ${binary}: Bash ${actual}`)
}

const temporaryRoot = mkdtempSync(join(tmpdir(), 'quirky-bash-versions-'))
try {
  let failed = false
  for (const [index, binary] of bashPaths.entries()) {
    const home = join(temporaryRoot, `home-${index}`)
    mkdirSync(home)
    const scope = createProcessScope(join(temporaryRoot, `quirky-${index}`))
    try {
      console.log(`\nRunning Bash shell tests with ${binary}`)
      const child = scope.spawn([process.execPath, 'test', 'packages/daemon/test/shell-path.test.ts', '--test-name-pattern', '^bash shell'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: home,
          HISTFILE: join(home, '.bash_history'),
          QUIRKY_TEST_BASH: binary
        },
        stdin: 'ignore',
        stdout: 'inherit',
        stderr: 'inherit'
      })
      if (await child.exited !== 0) failed = true
    } finally {
      await scope.cleanup()
    }
  }
  if (failed) process.exitCode = 1
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true })
}
