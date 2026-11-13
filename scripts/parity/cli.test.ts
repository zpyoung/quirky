import { expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createProcessScope } from '../test-support/process-scope'
import { createIsolatedRuntimeEnvironment } from '../ui-review/fixtures'
import type { CliParityReport, CliParityRow, CliReceipt } from './cli-run'

const checkout = join(import.meta.dir, '../..')

test('CLI parity rehearses owned command groups and preserves unproved mappings', async () => {
  const scope = createProcessScope()
  const env = createIsolatedRuntimeEnvironment(scope.home, { repoRoot: checkout })
  mkdirSync(env.TMPDIR!, { recursive: true })
  // This external process must remain alive until teardown; fake timers cannot keep a child alive.
  const sentinel = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], { env, stdout: 'ignore', stderr: 'ignore' })
  try {
    const child = scope.spawn([process.execPath, join(import.meta.dir, 'cli.ts'), '--json'], {
      cwd: checkout, env, stdout: 'pipe', stderr: 'pipe', timeout: 370_000
    })
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(exit, stderr + '\n' + stdout).toBe(0)
    const report: CliParityReport = JSON.parse(stdout)
    expect(report).toMatchObject({ schemaVersion: 1, scope: 'goal-11-cli-commands', ok: true, parityComplete: false, providerMode: 'local-stand-ins', cleanup: { ok: true } })
    expect(report.elapsedMs).toBeLessThan(360_000)
    console.info(`CLI parity elapsedMs: ${report.elapsedMs}`)
    const rows = new Map<string, CliParityRow>(report.rows.map(row => [row.id, row]))
    for (const id of [
      'worktree-create', 'worktree-rm', 'agent-launch', 'terminal-send', 'terminal-wait', 'loop-edit', 'loop-resume',
      'ask', 'ask-cancel', 'ask-wait', 'automations-run', 'orchestration-task-update', 'orchestration-gate-resolve',
      'orchestration-inbox', 'file-open', 'account-list', 'skills-update', 'status', 'agent-context',
      'account-add', 'account-rm', 'agent-hooks-on', 'agent-hooks-off', 'agent-hooks-status',
      'project-setup-clone', 'project-setup-create', 'project-setup-delete', 'project-setup-update',
      'repo-search-refs', 'terminal-list', 'terminal-rename', 'terminal-set-pane-title', 'terminal-show',
      'terminal-split', 'terminal-switch', 'worktree-current'
    ]) {
      expect(rows.get(id), id).toMatchObject({ status: 'passed', executed: true })
    }
    for (const id of ['orchestration-worker-start', 'worktree-ps']) {
      const row = rows.get(id)!
      expect(row, id).toMatchObject({ status: 'mapped-only', executed: false })
      expect(row.catalogRefs.length).toBeGreaterThan(0)
      expect(row.followUp).toBeTruthy()
    }
    for (const id of ['serve', 'serve-restore-resume', 'serve-service-install', 'serve-service-status', 'serve-service-uninstall', 'file-diff', 'file-open-changed', 'file-open-render']) {
      expect(rows.get(id), id).toMatchObject({ status: 'gap', executed: false })
      expect(rows.get(id)!.reason).toBeTruthy()
    }
    expect(report.rows.filter(row => row.status === 'passed')).toHaveLength(74)
    expect(report.rows.filter(row => row.status === 'mapped-only')).toHaveLength(16)
    expect(report.rows.filter(row => row.status === 'gap')).toHaveLength(8)
    expect(report.rows.some(row => row.status === 'delegated')).toBe(true)
    expect(report.rows.filter(row => row.status === 'failed' || row.status === 'not-run')).toEqual([])
    for (const row of report.rows.filter(row => row.status === 'passed')) {
      for (const id of row.checks) expect(report.receipts.some(receipt => receipt.id === id && receipt.exitCode === 0), id).toBe(true)
    }
    const receipt = (id: string) => {
      const value = report.receipts.find(item => item.id === id) as CliReceipt
      expect(value, id).toBeTruthy()
      expect(value.exitCode).toBe(0)
      expect(value.stdoutBytes).toBeGreaterThan(0)
      expect(value.elapsedMs).toBeGreaterThanOrEqual(0)
      expect(value.argv).toContain('--json')
      expect(value.argv).toContain('local')
      return value.evidence
    }
    expect(receipt('catalog')).toMatchObject({ schemaVersion: 2 })
    expect(receipt('repo-add')).toMatchObject({ kind: 'git' })
    expect(receipt('folder-add')).toMatchObject({ kind: 'folder' })
    expect(receipt('worktree-create')).toMatchObject({ parentId: null })
    expect(receipt('loop-show')).toMatchObject({ iterationsCompleted: 1, state: 'paused', pauseReason: 'cap-iterations', nextIterationAt: null })
    expect(receipt('loop-resume')).toMatchObject({ iterationsCompleted: 2, state: 'paused', pauseReason: 'cap-iterations', nextIterationAt: null })
    expect(receipt('loop-stop')).toMatchObject({ state: 'stopped' })
    expect(receipt('file-read')).toMatchObject({ content: 'first\nsecond λ\n' })
    expect(receipt('terminal-exit')).toMatchObject({ status: 'matched', state: 'exited' })
    expect(receipt('ask-wait')).toMatchObject({ status: 'declined' })
    expect(receipt('automation-runs')).toMatchObject({ status: 'completed', trigger: 'manual', sessionKind: 'structured', content: 'Codex: cli-parity-auto', promptCount: 1 })
    expect(receipt('skill-update')).toMatchObject({ state: 'up-to-date', bytesEqual: true })
    expect(receipt('status')).toMatchObject({ owned: true })
    expect(receipt('local-search-refs')).toMatchObject({ names: ['cli-parity-both', 'cli-parity-topic', 'cli-parity-both', 'cli-parity-v1'], truncated: false, allTargetHead: true })
    expect(receipt('local-hooks-remove')).toMatchObject({ userHookPreserved: true, status: 'not-installed', pathsUnderHome: true })
    expect(receipt('local-account-login-codex')).toMatchObject({ status: 'complete', label: 'CLI parity Codex', email: 'codex-parity@example.invalid', needsSignIn: false })
    expect(receipt('local-worktree-current')).toMatchObject({ nestedId: expect.any(String), mainIsMain: true, outside: 'not-found' })
    const status = receipt('status')
    for (const pid of [status.pid, status.ptyHostPid]) {
      expect(typeof pid).toBe('number')
      expect(() => process.kill(Number(pid), 0)).toThrow()
    }
    expect(sentinel.exitCode).toBeNull()
  } finally {
    sentinel.kill('SIGKILL')
    await sentinel.exited
    await scope.cleanup()
  }
}, 370_000)

