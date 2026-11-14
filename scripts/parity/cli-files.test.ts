import { expect, test } from 'bun:test'
import { existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { createProcessScope } from '../test-support/process-scope'
import { createIsolatedRuntimeEnvironment } from '../ui-review/fixtures'

const root = resolve(import.meta.dir, '../..')

test('the real two-window CLI rehearsal observes file placement and cleans its owned processes', async () => {
  const scope = createProcessScope()
  const env = createIsolatedRuntimeEnvironment(scope.home, { repoRoot: root })
  mkdirSync(env.TMPDIR!, { recursive: true })
  const sentinel = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], { env, stdout: 'ignore', stderr: 'ignore' })
  const child = scope.spawn([process.execPath, 'scripts/parity/cli-files.ts', '--json'], { cwd: root, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  // real subprocess watchdogs must fire even when the daemon or browser stops responding.
  const watchdog = setTimeout(() => scope.killNow(), 370_000)
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(code, stderr + '\n' + stdout).toBe(0)
    const report = JSON.parse(stdout)
    console.info(JSON.stringify({
      elapsedMs: report.elapsedMs,
      buildElapsedMs: report.buildElapsedMs,
      observationElapsedMs: Object.fromEntries(report.observations.map((entry: { id: string; evidence: { elapsedMs: number } }) => [entry.id, entry.evidence.elapsedMs]))
    }))
    expect(report).toMatchObject({ schemaVersion: 1, scope: 'goal-11-cli-files', ok: true, parityComplete: false, cleanup: { ok: true } })
    expect(report.error).toBeUndefined()
    expect(report.rows.map((row: { id: string }) => row.id)).toEqual(['file-diff', 'file-open', 'file-open-changed', 'file-open-render'])
    expect(report.rows.map((row: { disposition: string }) => row.disposition)).toEqual(['gap', 'covered', 'gap', 'gap'])
    for (const row of report.rows) {
      expect(row).toMatchObject({ status: 'observed', executed: true })
      expect(row.observations.length).toBeGreaterThan(0)
    }
    expect(report.observations.map((entry: { id: string }) => entry.id).sort()).toEqual([
      'files-editor-local', 'files-editor-other-worktree', 'files-editor-literal-path',
      'files-review-diff', 'files-review-reuse', 'files-review-changed', 'files-window-routing'
    ].sort())
    for (const observation of report.observations) {
      expect(observation.status, JSON.stringify(observation.error)).toBe('observed')
      expect(Number.isFinite(observation.evidence.elapsedMs)).toBe(true)
      expect(observation.evidence.elapsedMs).toBeGreaterThanOrEqual(0)
      expect(observation.receiptIds.length).toBeGreaterThan(0)
      expect(observation.before).toHaveLength(2)
      expect(observation.after).toHaveLength(2)
      for (const sample of [...observation.before, ...observation.after]) {
        expect(sample.connId).toBeGreaterThan(0)
        expect(sample.workspaceId).toBe(sample.windowWorktree)
        expect(sample.windowViewId).toBe('view:quirky.session/worktree')
      }
    }
    for (const [id, lines] of [
      ['files-editor-local', ['first A', 'second A', '']],
      ['files-editor-other-worktree', ['first', 'second λ', '']],
      ['files-editor-literal-path', ['literal path', '']]
    ] as const) {
      const observation = report.observations.find((entry: { id: string }) => entry.id === id)
      const request = observation.evidence.request
      const destination = observation.after.findIndex((sample: { windowWorktree: string }) => sample.windowWorktree === request.worktreeId)
      expect(destination).toBeGreaterThanOrEqual(0)
      const snapshot = observation.after[destination]
      const dom = observation.evidence.dom.after[destination]
      expect(dom.lines).toEqual([...lines])
      expect(snapshot.path).toBe(request.absolutePath)
      expect(snapshot.renderedTabId).toBe(snapshot.selectedTabId)
      expect(snapshot.activeElement.inDocument).toBe(true)
      expect(snapshot.caret).toEqual(id === 'files-editor-literal-path' ? { line: 1, column: 1 } : { line: 2, column: 3 })
      if (id !== 'files-editor-literal-path') {
        expect(observation.evidence.background.dom.map((sample: { selectedTabId: string }) => sample.selectedTabId))
          .toEqual(observation.before.map((sample: { selectedTabId: string }) => sample.selectedTabId))
        expect(observation.after.map((sample: { windowWorktree: string }) => sample.windowWorktree))
          .toEqual(observation.before.map((sample: { windowWorktree: string }) => sample.windowWorktree))
      }
    }
    for (const id of ['files-review-diff', 'files-review-reuse', 'files-review-changed']) {
      const observation = report.observations.find((entry: { id: string }) => entry.id === id)
      expect(observation.after[0].windowWorktree).toBe(observation.after[1].windowWorktree)
      expect(observation.after[0].selectedTabId).toBe(observation.after[1].selectedTabId)
      expect(observation.after[0].renderedTabId).toBe(observation.after[0].selectedTabId)
      const cards = observation.evidence.dom.after[0].reviewCards as Array<{ path: string; expanded: boolean; loaded: boolean; text: string }>
      const revealedPath = id === 'files-review-reuse' ? 'docs/review-notes.md' : 'src/app.ts'
      expect(cards.find(card => card.path === revealedPath)).toMatchObject({ expanded: true, loaded: true })
      if (id !== 'files-review-reuse') expect(cards.find(card => card.path === 'src/app.ts')?.text).toContain('second λ')
      if (id === 'files-review-changed') expect(cards.map(card => card.path)).toEqual(expect.arrayContaining(['src/app.ts', 'docs/review-notes.md']))
    }
    const routing = report.observations.find((entry: { id: string }) => entry.id === 'files-window-routing')
    expect(routing.after.map((sample: { windowWorktree: string; selectedTabId: string | null }) => [sample.windowWorktree, sample.selectedTabId]))
      .toEqual(routing.before.map((sample: { windowWorktree: string; selectedTabId: string | null }) => [sample.windowWorktree, sample.selectedTabId]))
    const receipts = report.receipts as Array<{ id: string; argv: string[]; exitCode: number; evidence: unknown }>
    expect(new Set(receipts.map(receipt => receipt.id)).size).toBe(receipts.length)
    for (const receipt of receipts) {
      expect(receipt.argv.slice(-3)).toEqual(['--runtime', 'local', '--json'])
      expect(receipt.evidence).toBeTruthy()
    }
    const refusal = receipts.find(receipt => receipt.argv[0] === 'ui' && receipt.argv[1] === 'run')!
    expect(refusal.exitCode).toBe(1)
    expect(JSON.stringify(refusal.evidence)).toContain('multiple Quirky windows are open; specify connId')
    expect(receipts.some(receipt => receipt.argv.includes('ui.window.command.run') && receipt.exitCode === 0)).toBe(true)
    const literal = receipts.find(receipt => receipt.argv[0] === 'editor' && receipt.argv[1] === 'open' && receipt.argv[2]?.includes('$(touch cli-injected)'))!
    expect(literal.argv[2]).toBe("cli-parity/open '$(touch cli-injected); λ.txt")
    expect(report.elapsedMs).toBeGreaterThan(0)
    expect(report.buildElapsedMs).toBeGreaterThan(0)
    expect(report.cleanup.evidence.processIdentitiesGone).toBe(true)
    expect(report.cleanup.evidence.sentinelAlive).toBe(true)
    expect(report.cleanup.evidence.trackedIdentities.some((identity: { command: string }) => identity.command.includes('daemon/src/main.ts'))).toBe(true)
    expect(report.cleanup.evidence.trackedIdentities.some((identity: { command: string }) => /chrome|chromium/i.test(identity.command))).toBe(true)
    expect(report.guards).toMatchObject({ denied: [], egress: ['https://cli-parity-guard.invalid/self-test'], injected: false })
    expect(stdout).not.toMatch(/#token=|hookToken|runtimeToken/)
    expect(existsSync(resolve(root, 'cli-injected'))).toBe(false)
    expect(sentinel.exitCode).toBeNull()
  } finally {
    clearTimeout(watchdog)
    sentinel.kill('SIGKILL')
    await sentinel.exited
    await scope.cleanup()
  }
}, 380_000)

