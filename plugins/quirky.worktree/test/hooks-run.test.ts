import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProcessRunner } from '../../../packages/process/src/api'
import type { ProcessRunner, RunOptions, RunResult } from '@quirky/protocol'
import { hookEnvironment, runHookInDaemon, runHookScript, runnerCommand, shellQuote, writeRunner, type HookTarget } from '../src/daemon/hooks-run'

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'qw-hooks-')))
const processRunner = createProcessRunner({ owner: 'hook-run-test' })
afterAll(async () => {
  await processRunner.dispose()
  rmSync(dir, { recursive: true, force: true })
})

const target: HookTarget = { rootPath: join(dir, "root with 'quote"), worktreePath: dir }
const runner = (name: string) => join(dir, 'runners', name, 'run.sh')

describe('the hook environment and runner', () => {
  test('every variable is mirrored under the names other tools use', () => {
    expect(hookEnvironment({ rootPath: '/r', worktreePath: '/w/feature' })).toEqual({
      QUIRKY_ROOT_PATH: '/r',
      QUIRKY_WORKTREE_PATH: '/w/feature',
      QUIRKY_WORKSPACE_NAME: 'feature',
      ORCA_ROOT_PATH: '/r',
      ORCA_WORKTREE_PATH: '/w/feature',
      ORCA_WORKSPACE_NAME: 'feature',
      CONDUCTOR_ROOT_PATH: '/r',
      CONDUCTOR_WORKSPACE_PATH: '/w/feature',
      CONDUCTOR_WORKSPACE_NAME: 'feature',
      GHOSTX_ROOT_PATH: '/r'
    })
  })

  test('shellQuote and runnerCommand single-quote a path and escape embedded quotes', () => {
    expect(shellQuote("a b")).toBe("'a b'")
    expect(shellQuote("it's")).toBe(`'it'\\''s'`)
    expect(runnerCommand("/x/it's/run.sh")).toBe(`/bin/bash '/x/it'\\''s/run.sh'`)
  })

  test('the runner is executable, enters the worktree, exports the environment and keeps the script verbatim', async () => {
    const file = runner('verbatim')
    await writeRunner(file, target, 'pwd > where.txt\nexit 7')
    expect(statSync(file).mode & 0o777).toBe(0o755)
    const text = readFileSync(file, 'utf8')
    expect(text.startsWith('#!/bin/bash\n')).toBe(true)
    expect(text).toContain(`export QUIRKY_ROOT_PATH=${shellQuote(target.rootPath)}`)
    expect(text.endsWith('pwd > where.txt\nexit 7\n')).toBe(true)
    expect(text).not.toContain('set -e')
  })
})

describe('runHookInDaemon', () => {
  test('returns the script\'s exit code and its output, with the hook environment and the worktree as cwd', async () => {
    const result = await runHookScript(processRunner, runner('ok'), target, 'echo "$QUIRKY_WORKSPACE_NAME in $PWD"; echo oops >&2; exit 4')
    expect(result.exitCode).toBe(4)
    expect(result.timedOut).toBe(false)
    expect(result.output).toContain(`${dir.split('/').pop()} in ${dir}`)
    expect(result.output).toContain('oops')
  })

  test('a script reading stdin sees it closed', async () => {
    const result = await runHookScript(processRunner, runner('stdin'), target, 'read line; echo "status:$? got:$line"')
    expect(result.output).toBe('status:1 got:\n')
  })

  test('past the timeout the whole process group is stopped and the run is marked timed out', async () => {
    const marker = join(dir, 'child-alive')
    const started = Date.now()
    const result = await runHookScript(processRunner, runner('slow'), target, `(sleep 30; touch ${marker}) &\nsleep 30`, { timeoutMs: 200, killGraceMs: 100 })
    expect(result.timedOut).toBe(true)
    expect(result.exitCode).not.toBe(0)
    expect(Date.now() - started).toBeLessThan(5000)
    await Bun.sleep(100)
    expect(existsSync(marker)).toBe(false)
  })

  test('a script that ignores SIGTERM is killed after the grace period', async () => {
    const started = Date.now()
    const result = await runHookScript(processRunner, runner('stubborn'), target, `trap '' TERM\nwhile true; do sleep 1; done`, { timeoutMs: 150, killGraceMs: 150 })
    expect(result.timedOut).toBe(true)
    expect(Date.now() - started).toBeLessThan(5000)
  })

  test('a TERM-resistant child is killed after the grace period even when the script itself exits on TERM', async () => {
    const pidFile = join(dir, 'resistant.pid')
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    let pid = 0
    try {
      const result = await runHookScript(processRunner, runner('resistant'), target, `(trap '' TERM; exec sh -c ${shellQuote(`echo $$ > ${pidFile}; exec sleep 30`)}) >/dev/null 2>&1 &\nsleep 30`, { timeoutMs: 500, killGraceMs: 800 })
      expect(result.timedOut).toBe(true)
      pid = Number(readFileSync(pidFile, 'utf8').trim())
      expect(pid).toBeGreaterThan(0)
      for (let waited = 0; waited < 3000 && alive(pid); waited += 50) await Bun.sleep(50)
      expect(alive(pid)).toBe(false)
    } finally {
      if (pid === 0 && existsSync(pidFile)) pid = Number(readFileSync(pidFile, 'utf8').trim())
      if (pid > 0 && alive(pid)) process.kill(pid, 'SIGKILL')
    }
  })

  test('output past the cap is dropped without stopping the script', async () => {
    const marker = join(dir, 'noisy-completed')
    const result = await runHookScript(processRunner, runner('noisy'), target, `head -c 50000 /dev/zero | tr "\\0" x\ntouch ${shellQuote(marker)}\nexit 4`, { maxOutputBytes: 1000 })
    expect(result).toEqual({ exitCode: 4, output: 'x'.repeat(1000), timedOut: false })
    expect(existsSync(marker)).toBe(true)
  })

  test('a background process with redirected output does not hang the run', async () => {
    const started = Date.now()
    const result = await runHookScript(processRunner, runner('detached'), target, '(sleep 3 >/dev/null 2>&1 &)\necho done')
    expect(result).toEqual({ exitCode: 0, output: 'done\n', timedOut: false })
    expect(Date.now() - started).toBeLessThan(2500)
  })

  test('a runner written elsewhere is run as it is', async () => {
    const file = join(dir, 'plain.sh')
    writeFileSync(file, '#!/bin/bash\necho plain\n')
    expect((await runHookInDaemon(processRunner, file, target)).output).toBe('plain\n')
  })

  test('normal exit cleans up a background child inheriting the output pipes', async () => {
    const pidFile = join(dir, 'normal-exit.pid')
    let pid = 0
    try {
      const result = await runHookScript(processRunner, runner('normal-exit'), target, `sleep 30 & echo $! > ${shellQuote(pidFile)}\nexit 0`)
      pid = Number(readFileSync(pidFile, 'utf8').trim())
      expect(pid).toBeGreaterThan(0)
      expect(result).toEqual({ exitCode: 0, output: '', timedOut: false })
      const deadline = Date.now() + 2000
      while (Date.now() < deadline) {
        try { process.kill(pid, 0) } catch { return }
        // process-group reaping follows the OS clock, not Bun's fake timers
        await Bun.sleep(20)
      }
      throw new Error(`hook descendant ${pid} survived normal exit`)
    } finally {
      if (pid === 0 && existsSync(pidFile)) pid = Number(readFileSync(pidFile, 'utf8').trim())
      if (pid > 0) {
        try { process.kill(pid, 'SIGKILL') } catch {}
      }
    }
  })
})

describe('the supplied hook runner', () => {
  const successful = (overrides: Partial<RunResult> = {}): RunResult => ({
    stdout: new TextEncoder().encode('combined output'),
    stdoutText: 'combined output',
    stderr: '',
    exitCode: 4,
    signal: null,
    durationMs: 1,
    ...overrides
  })

  test('forwards the hook environment and bounded combined capture policy', async () => {
    const calls: Array<{ argv: readonly string[]; options?: RunOptions }> = []
    const recording: ProcessRunner = {
      async run(argv, options) {
        calls.push({ argv, options })
        return successful()
      }
    }
    const file = runner('recorded')
    expect(await runHookInDaemon(recording, file, target)).toEqual({
      exitCode: 4, output: 'combined output', timedOut: false
    })
    expect(calls).toEqual([{
      argv: ['/bin/bash', file],
      options: {
        cwd: target.worktreePath,
        env: { ...process.env, ...hookEnvironment(target) },
        timeoutMs: 120_000,
        killGraceMs: 5_000,
        maxOutputBytes: 10 * 1024 * 1024,
        outputMode: 'combined',
        overflow: 'truncate'
      }
    }])
    await runHookScript(recording, file, target, 'exit 4', { timeoutMs: 20, killGraceMs: 10, maxOutputBytes: 30 })
    expect(calls[1]!.options).toMatchObject({ timeoutMs: 20, killGraceMs: 10, maxOutputBytes: 30 })
    expect(readFileSync(file, 'utf8')).toContain('exit 4')
  })

  for (const stopped of ['timeout', 'aborted', 'overflow'] as const) {
    test(`does not mistake ${stopped} with exit zero for hook success`, async () => {
      const recording: ProcessRunner = { run: async () => successful({ exitCode: 0, stopped }) }
      expect(await runHookInDaemon(recording, runner(stopped), target)).toEqual({
        exitCode: null, output: 'combined output', timedOut: stopped === 'timeout'
      })
    })
  }

  test('maps a signalled result to a null exit', async () => {
    const recording: ProcessRunner = { run: async () => successful({ exitCode: 0, signal: 'SIGTERM' }) }
    expect(await runHookInDaemon(recording, runner('signal'), target)).toEqual({
      exitCode: null, output: 'combined output', timedOut: false
    })
  })

  test('throws spawn failures and propagates rejected runner calls', async () => {
    const failed: ProcessRunner = { run: async () => successful({ spawnError: { code: 'ENOENT', message: 'fixture spawn failure' } }) }
    await expect(runHookInDaemon(failed, runner('spawn-failure'), target)).rejects.toThrow('fixture spawn failure')
    const error = new Error('fixture rejection')
    const rejected: ProcessRunner = { run: async () => { throw error } }
    await expect(runHookInDaemon(rejected, runner('rejection'), target)).rejects.toBe(error)
  })
})
