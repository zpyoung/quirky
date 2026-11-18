import { takePositionals } from '../args'
import type { DiagnosticsMemoryReport, MemoryTree } from '@quirky/protocol'
import type { Command } from './types'

function formatMiB(bytes: number | null): string {
  return bytes === null ? 'unavailable' : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

function formatTree(tree: MemoryTree | null): string {
  if (tree === null) return 'unavailable'
  const omitted = tree.omitted > 0 ? `, ${tree.omitted} omitted` : ''
  return `${tree.processCount} processes, RSS ${formatMiB(tree.rssBytes)}${omitted}`
}

function formatMemoryReport(report: DiagnosticsMemoryReport): string {
  const lines = [
    `daemon ${report.daemon.pid}: RSS ${formatMiB(report.daemon.rssBytes)}; heap used ${formatMiB(report.daemon.heapUsedBytes)}; heap total ${formatMiB(report.daemon.heapTotalBytes)}; external ${formatMiB(report.daemon.externalBytes)}`,
    `  descendants: ${formatTree(report.daemon.descendants)}`,
    `pty host ${report.ptyHost.pid ?? 'unknown'}: ${report.ptyHost.alive ? 'alive' : 'not connected'}; RSS ${formatMiB(report.ptyHost.rssBytes)}`,
    ...report.sessions.map(
      (session) => `session ${session.sessionId} (${session.pid}): ${formatTree(session.tree)}`
    ),
    `total: ${report.totals === null ? 'unavailable' : `${report.totals.processCount} processes, RSS ${formatMiB(report.totals.rssBytes)}`}`
  ]
  for (const unavailable of report.unavailable) {
    lines.push(`unavailable ${unavailable.part}: ${unavailable.reason}`)
  }
  return lines.join('\n')
}

export const diagnosticsMemory: Command = {
  name: 'diagnostics memory',
  summary: 'report daemon and session memory usage',
  positionals: [],
  flags: {},
  methods: ['diagnostics.memory'],
  plugin: null,
  async run(args, ctx) {
    takePositionals(args, [])
    const report = await ctx.rpc.call('diagnostics.memory', {})
    ctx.out.result(report, () => formatMemoryReport(report))
  }
}
