import { afterEach, expect, test } from 'bun:test'
import type { DiagnosticsMemoryReport } from '@quirky/protocol'
import { SCENARIO_MS, cleanupAll, descendantsOf, startE2e, waitFor } from './support'

afterEach(async () => {
  await cleanupAll()
})

test(
  "diagnostics memory reports the real daemon, PTY host and a session's process tree through the CLI",
  async () => {
    const h = await startE2e()
    const session = await h.newSession()
    const id = session.id
    await h.run(id, 'sleep 300 &')
    const shellPid = await h.shellPid(id)
    const sleepPid = await waitFor(
      'background sleep process',
      () => descendantsOf(shellPid).find((row) => row.command === 'sleep 300')?.pid
    )
    h.track(sleepPid)

    const report = await h.json<DiagnosticsMemoryReport>(['diagnostics', 'memory'])
    const status = await h.json<{ pid: number }>(['status'])
    expect(report.schemaVersion).toBe(1)
    expect(report.daemon.pid).toBe(status.pid)
    expect(report.daemon.rssBytes).toBeGreaterThan(0)
    expect(report.daemon.heapUsedBytes).toBeGreaterThan(0)
    expect(report.daemon.descendants).not.toBeNull()
    expect(report.ptyHost.pid).toBe(h.hostPid())
    expect(report.ptyHost.alive).toBe(true)
    expect(report.ptyHost.rssBytes).toBeGreaterThan(0)
    expect(report.sessions).toHaveLength(1)
    expect(report.sessions[0]).toMatchObject({ sessionId: id, pid: await h.shellPid(id) })
    const tree = report.sessions[0]!.tree
    expect(tree).not.toBeNull()
    if (!tree) throw new Error('memory report omitted the running session tree')
    expect(tree.processCount).toBeGreaterThanOrEqual(2)
    expect(tree.processes.some(({ name }) => name === 'sleep')).toBe(true)
    if (tree.omitted === 0) {
      expect(tree.rssBytes).toBe(tree.processes.reduce((sum, process) => sum + process.rssBytes, 0))
    }
    expect(report.totals).not.toBeNull()
    if (report.daemon.rssBytes === null || report.ptyHost.rssBytes === null || report.totals === null) {
      throw new Error('memory report omitted a process-table figure')
    }
    expect(report.totals.processCount).toBeGreaterThanOrEqual(2 + tree.processCount)
    expect(report.totals.rssBytes).toBeGreaterThanOrEqual(
      report.daemon.rssBytes + report.ptyHost.rssBytes + tree.rssBytes
    )
    expect(report.unavailable).toEqual([])
    expect(JSON.stringify(report)).not.toContain('sleep 300')

    const text = await h.cli(['diagnostics', 'memory'])
    expect(text.code).toBe(0)
    const lines = text.stdout.split(/\r?\n/)
    expect(lines.some((line) => line.startsWith('daemon'))).toBe(true)
    expect(lines.some((line) => line.startsWith('pty host'))).toBe(true)
    expect(lines.some((line) => line.startsWith(`session ${id}`))).toBe(true)
    expect(lines.some((line) => line.startsWith('total'))).toBe(true)

    await h.ok(['session', 'close', id])
    const afterClose = await h.json<DiagnosticsMemoryReport>(['diagnostics', 'memory'])
    expect(afterClose.sessions.some((row) => row.sessionId === id)).toBe(false)
  },
  SCENARIO_MS
)
