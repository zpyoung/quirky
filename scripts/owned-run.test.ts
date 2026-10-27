import { expect, test } from 'bun:test'
import type { Subprocess } from 'bun'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const entry = join(import.meta.dir, 'owned-run.ts')

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

test('owned command preserves exit status and removes its detached host and temporary home', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'owned-run-test-'))
  const record = join(scratch, 'record.json')
  let proc: Subprocess<'ignore', 'ignore', 'pipe'> | undefined
  let pid: number | undefined
  let home: string | undefined
  try {
    const script = `
      import { writeFileSync } from 'node:fs'
      const host = Bun.spawn(['sleep', '60'], { detached: true, stdout: 'ignore', stderr: 'ignore' })
      writeFileSync(process.env.QUIRKY_HOME + '/pty.pid', String(host.pid))
      writeFileSync(${JSON.stringify(record)}, JSON.stringify({ pid: host.pid, home: process.env.QUIRKY_HOME }))
      process.exit(7)
    `
    proc = Bun.spawn([process.execPath, entry, '--', process.execPath, '-e', script], { stdout: 'ignore', stderr: 'pipe' })
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
    expect(code, stderr).toBe(7)
    const data = JSON.parse(readFileSync(record, 'utf8'))
    pid = data.pid
    home = data.home
    expect(alive(pid!)).toBe(false)
    expect(existsSync(home!)).toBe(false)
  } finally {
    proc?.kill('SIGKILL')
    if (pid === undefined && existsSync(record)) {
      const data = JSON.parse(readFileSync(record, 'utf8'))
      pid = data.pid
      home = data.home
    }
    if (pid) {
      try { process.kill(-pid, 'SIGKILL') } catch {}
      try { process.kill(pid, 'SIGKILL') } catch {}
    }
    if (home) rmSync(home, { recursive: true, force: true })
    rmSync(scratch, { recursive: true, force: true })
  }
}, 15_000)
