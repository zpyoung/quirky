import type { Inventory, ScoreboardReport, VisualResult, CheckResult, VisualCell } from './contracts'
import { CHECK_IDS } from './contracts'
import { checkPlugin, checkHostTokens, sharedTokenEvidence } from './tokens'

const sourceAuditChecks: Record<string, true> = { loading: true, empty: true, error: true, commands: true }
const passingSourceAuditCodes: Record<string, true> = {
  'state-covered': true, 'state-not-applicable': true, 'not-state': true,
  'action-routed': true, 'action-transient': true, 'action-not-user': true,
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function screenshotCheck(applicable: boolean, cells: VisualCell[]): CheckResult {
  if (!applicable) return { id: 'screenshots', status: 'pass', applicable: false, reason: 'no-ui-surface', evidence: [{ code: 'no-ui-surface', message: 'No declared capture surfaces.' }] }
  const passed = cells.length > 0 && cells.every((cell) => cell.status === 'pass')
  return {
    id: 'screenshots', status: passed ? 'pass' : 'fail', applicable: true,
    reason: passed ? 'all-images-passed' : cells.length ? 'image-checks-failed' : 'no-declared-capture-target',
    evidence: cells.length ? cells.map((cell) => ({ code: cell.code, message: `${cell.targetId} ${cell.theme}: ${cell.score === null ? 'unmeasured' : cell.score}; ${cell.reasons.join('; ')}`, basis: 'rendered-review', targetId: cell.targetId, theme: cell.theme })) : [{ code: 'no-declared-capture-target', message: 'UI code has no declared capturable surface.' }],
  }
}

/** Retain every check and image in a deterministic, non-averaged goal verdict. */
export function buildReport(inventory: Inventory, visuals: VisualResult, mode: ScoreboardReport['mode'], pluginId?: string): ScoreboardReport {
  const pluginMode = mode === 'plugin'
  const reportPlugins = pluginMode ? inventory.plugins.filter((plugin) => plugin.id === pluginId) : inventory.plugins
  const cells = [...visuals.cells]
    .filter((cell) => !pluginMode || cell.plugin === pluginId)
    .sort((a, b) => compareText(a.targetId, b.targetId) || compareText(a.theme, b.theme))
  const plugins = reportPlugins.map((plugin) => {
    const pluginCells = cells.filter((cell) => cell.plugin === plugin.id)
    return {
      id: plugin.id,
      checks: [...checkPlugin(inventory, plugin.id), screenshotCheck(plugin.targets.length > 0 || pluginCells.length > 0, pluginCells)].sort((a, b) => CHECK_IDS.indexOf(a.id) - CHECK_IDS.indexOf(b.id)),
      targets: visuals.targets.filter((target) => target.plugin === plugin.id).map((target) => target.id).sort(),
    }
  }).sort((a, b) => compareText(a.id, b.id))
  const host = pluginMode
    ? { checks: [], targets: [] }
    : { checks: [checkHostTokens(inventory), screenshotCheck(true, cells.filter((cell) => cell.plugin === null))], targets: visuals.targets.filter((target) => target.plugin === null).map((target) => target.id).sort() }
  const failures = [...inventory.failures, ...visuals.failures].sort((a, b) => compareText(a.source?.file ?? '', b.source?.file ?? '') || (a.source?.line ?? 0) - (b.source?.line ?? 0) || (a.source?.column ?? 0) - (b.source?.column ?? 0) || compareText(a.code, b.code))
  const checks = pluginMode ? plugins.flatMap((plugin) => plugin.checks) : [...plugins.flatMap((plugin) => plugin.checks), ...host.checks]
  const checksPassed = (!pluginMode || plugins.length === 1) && failures.length === 0 && !visuals.operationalError && checks.every((check) => check.status === 'pass')
  const goalPassed = mode === 'full' && checksPassed
  const status = inventory.failures.length || visuals.operationalError ? 'error' : pluginMode ? checksPassed ? 'passed' : 'failed' : goalPassed ? 'passed' : 'failed'
  return {
    schemaVersion: 1, mode, ...(pluginMode && pluginId ? { plugin: pluginId } : {}),
    commit: inventory.commit, sourceDigest: inventory.sourceDigest, threshold: 85, status, goalPassed,
    plugins, host, cells, sharedTokenEvidence: sharedTokenEvidence(inventory), exclusions: inventory.exclusions, failures,
  }
}

/** Expose missing and failed evidence without hiding cells behind percentages. */
export function formatMarkdown(report: ScoreboardReport): string {
  const escape = (value: string) => value.replaceAll('|', '\\|').replaceAll(/[\r\n]+/g, ' ')
  const rows = report.plugins.map((plugin) => ({ id: plugin.id, checks: plugin.checks }))
  if (report.mode !== 'plugin') rows.push({ id: 'host', checks: report.host.checks })
  const modeLabel = report.mode === 'plugin' && report.plugin ? `plugin (${escape(report.plugin)})` : report.mode
  const lines = ['# UI scoreboard', '', `Mode: ${modeLabel}. Status: ${report.status}. Goal passed: ${report.goalPassed}.`, `Commit: ${report.commit}. Source digest: ${report.sourceDigest}. Threshold: 85 per image.`, '', '| Plugin | ' + CHECK_IDS.join(' | ') + ' |', '| --- | ' + CHECK_IDS.map(() => '---').join(' | ') + ' |']
  for (const row of rows) lines.push(`| ${escape(row.id)} | ${CHECK_IDS.map((id) => { const check = row.checks.find((candidate) => candidate.id === id); return check ? check.applicable ? check.status : 'N/A' : 'not rated' }).join(' | ')} |`)
  lines.push('', '## Failed-check evidence', '')
  for (const row of rows) for (const check of row.checks.filter((check) => check.status === 'fail')) {
    lines.push(`### ${row.id}: ${check.id}`, '', check.reason)
    const audit = Object.prototype.hasOwnProperty.call(sourceAuditChecks, check.id)
    const evidence = audit ? check.evidence.filter((item) => !Object.prototype.hasOwnProperty.call(passingSourceAuditCodes, item.code)) : check.evidence
    const shown = audit ? evidence.slice(0, 25) : evidence
    for (const item of shown) lines.push(`- ${item.code}: ${escape(item.message)}${item.source ? ` (${item.source.file}:${item.source.line}:${item.source.column})` : ''}`)
    if (audit && evidence.length > shown.length) lines.push(`… and ${evidence.length - shown.length} more in scoreboard.json`)
    lines.push('')
  }
  for (const evidence of report.sharedTokenEvidence) lines.push(`- Shared ${evidence.code}: ${escape(evidence.message)}${evidence.source ? ` (${evidence.source.file}:${evidence.source.line}:${evidence.source.column})` : ''}`)
  for (const failure of report.failures) lines.push(`- ${failure.code}: ${escape(failure.message)}`)
  lines.push('', '## Visual cells', '', '| Target | Theme | Status | Score | Evidence |', '| --- | --- | --- | --- | --- |')
  for (const cell of report.cells) lines.push(`| ${escape(cell.targetId)} | ${cell.theme} | ${cell.status} | ${cell.score ?? 'unmeasured'} | ${escape(`${cell.code}: ${cell.reasons.join('; ')}`)} |`)
  lines.push('', '## Exclusions', '')
  for (const exclusion of report.exclusions) lines.push(`- ${exclusion.plugin}: ${exclusion.reason}; ${exclusion.branch}, PR ${exclusion.pr}, steer ${exclusion.steerDate}.`)
  lines.push('', 'Loading, empty, error and command checks are a syntactic source audit. See the UI scoreboard section of apps/desktop/README.md for its limits.', '')
  return lines.join('\n')
}

