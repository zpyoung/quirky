import { expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startChild } from '../../packages/process/src/child.ts'
import { DEFAULT_BEAT_MS } from './worker.ts'

const worker = resolve(import.meta.dir, 'worker.ts')

test('retains the ten-second default beat', () => {
  expect(DEFAULT_BEAT_MS).toBe(10_000)
})

test('skips missed beats instead of replaying hooks after slow git', async () => {
  const home = mkdtempSync(join(tmpdir(), 'soak-worker-'))
  const hookLog = join(home, 'hooks.log')
  const git = join(home, 'git')
  const hook = join(home, 'quirky-hook')
  writeFileSync(git, '#!/bin/sh\nif [ "$1" = status ] && [ ! -f first-status ]; then\n  touch first-status\n  sleep 1.5\nfi\n')
  writeFileSync(hook, `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';\nawait Bun.stdin.text();\nappendFileSync(${JSON.stringify(hookLog)}, Date.now() + '\\n');\n`)
  chmodSync(git, 0o755)
  chmodSync(hook, 0o755)
  const child = startChild([process.execPath, worker, '0'], {
    cwd: home,
    env: { ...process.env, QUIRKY_HOME: home, QUIRKY_SOAK_BEAT_MS: '300', PATH: `${home}:/usr/bin:/bin` },
    stdout: 'ignore',
    stderr: 'pipe'
  })
  const stderr = new Response(child.stderr).text()
  try {
    // the subprocess owns its clock; fake timers cannot check hook spacing across a stalled git process
    await Bun.sleep(4000)
    const times = readFileSync(hookLog, 'utf8').trim().split('\n').map(Number)
    expect(times.length).toBeGreaterThanOrEqual(4)
    for (let i = 1; i < times.length; i++) {
      const gap = times[i]! - times[i - 1]!
      if (gap < 250) console.error('hook times:', times)
      expect(gap).toBeGreaterThanOrEqual(250)
    }
    const skips = readFileSync(join(home, 'soak-skips.log'), 'utf8').trim().split('\n')
    let skipped = 0
    for (const line of skips) {
      expect(line).toMatch(/^skipped \d+ \d{4}-\d{2}-\d{2}T.+Z$/)
      skipped += Number(line.split(' ')[1])
    }
    expect(skipped).toBeGreaterThanOrEqual(3)
    for (const line of readFileSync(join(home, 'soak-heartbeat.log'), 'utf8').trim().split('\n')) {
      expect(line).toMatch(/^cycle \d+ .+$/)
    }
  } finally {
    child.killGroup('SIGKILL')
    await child.exited
    const errors = await stderr
    rmSync(home, { recursive: true, force: true })
    expect(errors).toBe('')
  }
}, 10_000)
