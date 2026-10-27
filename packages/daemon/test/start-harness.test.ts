import { expect, test } from 'bun:test'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { makeTempHome, startHarness } from './helpers'
import { createProcessScope } from '../../../scripts/test-support/process-scope'

test('stops the fake PTY host when daemon startup fails', async () => {
  const home = makeTempHome('qd-start-failure-')
  const scope = createProcessScope(home)
  try {
    const proc = scope.spawn(
      [
        process.execPath,
        '-e',
        `
          import { existsSync, mkdirSync } from 'node:fs';
          import { join } from 'node:path';
          import { socketPath } from '@quirky/protocol/node';
          import { startHarness } from './test/helpers.ts';
          const home = process.env.QUIRKY_HOME;
          mkdirSync(join(home, 'quirky.db'), { recursive: true });
          let failed = false;
          try { await startHarness({ home }); } catch { failed = true; }
          process.stdout.write(JSON.stringify({ failed, socketExists: existsSync(socketPath(home, 'pty.sock')) }));
          process.exit(0);
        `
      ],
      { cwd: join(import.meta.dir, '..'), env: { ...process.env, QUIRKY_HOME: home }, stdout: 'pipe', stderr: 'pipe' }
    )
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited
    ])
    expect(exitCode, stderr).toBe(0)
    expect(JSON.parse(stdout)).toEqual({ failed: true, socketExists: false })
  } finally {
    await scope.cleanup()
    rmSync(home, { recursive: true, force: true })
  }
})

test('attempts PTY and home cleanup when daemon stop throws', async () => {
  const harness = await startHarness()
  const home = harness.home
  const stopDaemon = harness.daemon.stop.bind(harness.daemon)
  const stopPty = harness.pty.stop.bind(harness.pty)
  let ptyStopAttempted = false
  harness.daemon.stop = async () => {
    await stopDaemon()
    throw new Error('daemon stop failed')
  }
  harness.pty.stop = () => {
    ptyStopAttempted = true
    stopPty()
  }

  try {
    await expect(harness.cleanup()).rejects.toThrow('daemon stop failed')
    expect(ptyStopAttempted).toBe(true)
    expect(existsSync(home)).toBe(false)
  } finally {
    await stopDaemon()
    stopPty()
    rmSync(home, { recursive: true, force: true })
  }
})
