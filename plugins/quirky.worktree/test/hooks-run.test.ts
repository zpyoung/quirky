import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hookEnvironment, runHookInDaemon, runHookScript, runnerCommand, shellQuote, writeRunner, type HookTarget } from '../src/daemon/hooks-run'

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'qw-hooks-')))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

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
    const result = await runHookScript(runner('ok'), target, 'echo "$QUIRKY_WORKSPACE_NAME in $PWD"; echo oops >&2; exit 4')
    expect(result.exitCode).toBe(4)
    expect(result.timedOut).toBe(false)
    expect(result.output).toContain(`${dir.split('/').pop()} in ${dir}`)
    expect(result.output).toContain('oops')
  })

  test('a script reading stdin sees it closed', async () => {
    const result = await runHookScript(runner('stdin'), target, 'read line; echo "status:$? got:$line"')
    expect(result.output).toBe('status:1 got:\n')
  })

  test('past the timeout the whole process group is stopped and the run is marked timed out', async () => {
    const marker = join(dir, 'child-alive')
    const started = Date.now()
    const result = await runHookScript(runner('slow'), target, `(sleep 30; touch ${marker}) &\nsleep 30`, { timeoutMs: 200, killGraceMs: 100 })
    expect(result.timedOut).toBe(true)
    expect(result.exitCode).not.toBe(0)
    expect(Date.now() - started).toBeLessThan(5000)
    await Bun.sleep(100)
    expect(existsSync(marker)).toBe(false)
  })

  test('a script that ignores SIGTERM is killed after the grace period', async () => {
    const started = Date.now()
    const result = await runHookScript(runner('stubborn'), target, `trap '' TERM\nwhile true; do sleep 1; done`, { timeoutMs: 150, killGraceMs: 150 })
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
      const result = await runHookScript(runner('resistant'), target, `(trap '' TERM; exec sh -c ${shellQuote(`echo $$ > ${pidFile}; exec sleep 30`)}) >/dev/null 2>&1 &\nsleep 30`, { timeoutMs: 500, killGraceMs: 800 })
      expect(result.timedOut).toBe(true)
      pid = Number(readFileSync(pidFile, 'utf8').trim())
      expect(pid).toBeGreaterThan(0)
      expect(alive(pid)).toBe(true)
      for (let waited = 0; waited < 3000 && alive(pid); waited += 50) await Bun.sleep(50)
      expect(alive(pid)).toBe(false)
    } finally {
      if (pid > 0 && alive(pid)) process.kill(pid, 'SIGKILL')
    }
  })

  test('output past the cap is dropped', async () => {
    const result = await runHookScript(runner('noisy'), target, 'head -c 50000 /dev/zero | tr "\\0" x', { maxOutputBytes: 1000 })
    expect(result.output.length).toBe(1000)
    expect(result.exitCode).toBe(0)
  })

  test('a background process holding the pipe open does not hang the run', async () => {
    const started = Date.now()
    const result = await runHookScript(runner('detached'), target, '(sleep 3 >/dev/null 2>&1 &)\necho done')
    expect(result.output).toContain('done')
    expect(Date.now() - started).toBeLessThan(2500)
  })

  test('a runner written elsewhere is run as it is', async () => {
    const file = join(dir, 'plain.sh')
    writeFileSync(file, '#!/bin/bash\necho plain\n')
    expect((await runHookInDaemon(file, target)).output).toBe('plain\n')
  })
})
