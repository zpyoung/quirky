import { expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startChild } from '../../packages/process/src/child.ts'
import { agentCycleChunks, DEFAULT_BEAT_MS, pongFor } from './worker.ts'

const worker = resolve(import.meta.dir, 'worker.ts')

test('retains the ten-second default beat', () => {
  expect(DEFAULT_BEAT_MS).toBe(10_000)
})

test('builds deterministic bounded agent-like terminal output', () => {
  const chunks = agentCycleChunks(2, 7)
  expect(agentCycleChunks(2, 7)).toEqual(chunks)
  expect(chunks[0]).toBe('\x1b]0;soak agent 2 cycle 7\x07')
  expect(chunks.slice(1, 4)).toEqual(['\x1b[?1049h', '\x1b[?25l', '\x1b[2J\x1b[H'])

  const frameRows = chunks.slice(4, 28)
  expect(frameRows).toHaveLength(24)
  for (let row = 1; row <= 24; row++) {
    expect(frameRows[row - 1]).toMatch(new RegExp(`^\\x1b\\[${row};1H.*\\x1b\\[K$`))
  }

  const spinner = chunks.slice(28, 68)
  expect(spinner).toHaveLength(40)
  expect(spinner.every((chunk) => chunk.startsWith('\x1b[24;1H\x1b[2K'))).toBe(true)

  const coloredLines = chunks[68]!
  expect(coloredLines.split('\n').filter(Boolean)).toHaveLength(200)
  expect(coloredLines).toContain('\x1b[30m')
  expect(coloredLines).toContain('\x1b[0m')
  expect(chunks.slice(69, 71)).toEqual(['\x1b[?25h', '\x1b[?1049l'])
  expect(chunks[71]!.split('\n').filter(Boolean)).toEqual(
    Array.from({ length: 40 }, (_, line) => `soak worker 2 cycle 7 line ${line + 1}`)
  )
  expect(new TextEncoder().encode(chunks.join('')).byteLength).toBeLessThanOrEqual(32_768)
})

test('validates soak ping tokens strictly', () => {
  expect(pongFor('soak-ping ab12cd34-7')).toBe('\nsoak-pong ab12cd34-7\n')
  expect(pongFor('soak-ping 00000000-123456789')).toBe('\nsoak-pong 00000000-123456789\n')

  for (const line of [
    'soak-ping ab12cd34-0',
    'soak-ping ab12cd34-1234567890',
    'soak-ping AB12cd34-7',
    'soak-ping ab12cd34-7 trailing text'
  ]) {
    expect(pongFor(line)).toBeNull()
  }
})

test('answers pings from stdin while running as main', async () => {
  const home = mkdtempSync(join(tmpdir(), 'soak-worker-home-'))
  const cwd = mkdtempSync(join(tmpdir(), 'soak-worker-repo-'))
  const expected = '\nsoak-pong 0123abcd-1\n'

  try {
    const initialized = Bun.spawnSync(['git', 'init', '-q'], {
      cwd,
      env: { ...process.env, QUIRKY_HOME: home, PATH: `${home}:/usr/bin:/bin` },
      stdout: 'ignore',
      stderr: 'ignore'
    })
    expect(initialized.exitCode).toBe(0)

    const child = Bun.spawn([process.execPath, worker, '0'], {
      cwd,
      env: {
        ...process.env,
        QUIRKY_HOME: home,
        QUIRKY_SOAK_BEAT_MS: '600000',
        PATH: `${home}:/usr/bin:/bin`
      },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'ignore'
    })
    const timeout = Promise.withResolvers<null>()
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    const output = (async () => {
      let text = ''
      const decoder = new TextDecoder()
      const reader = child.stdout.getReader()
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) return text + decoder.decode()
          text += decoder.decode(value, { stream: true })
          if (text.includes(expected)) return text
        }
      } finally {
        reader.releaseLock()
      }
    })()

    try {
      child.stdin.write('soak-ping 0123abcd-1\n')
      await child.stdin.flush()
      // A real child must answer against the wall clock; fake timers cannot advance its event loop.
      timeoutHandle = setTimeout(() => timeout.resolve(null), 2_000)
      const result = await Promise.race([output, timeout.promise])
      if (result === null) throw new Error('worker did not answer the ping within 2 seconds')
      expect(result).toContain(expected)
    } finally {
      clearTimeout(timeoutHandle)
      try { child.kill('SIGCONT') } catch {}
      try { child.kill('SIGKILL') } catch {}
      await child.exited
      await output
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
}, 5_000)

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
