import { beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { auditPlugin } from '../../../../scripts/ui-scoreboard/audit'
import { discoverCandidates, discoverUiFiles } from '../../../../scripts/ui-scoreboard/audit-discovery'
import { parseCoverage } from '../../../../scripts/ui-scoreboard/audit-evidence'
import type { CheckResult, CoverageFile, Inventory, PluginInventory, StaticCheckId } from '../../../../scripts/ui-scoreboard/contracts'
import { collectInventory } from '../../../../scripts/ui-scoreboard/inventory'
import { checkRatchet, parseRatchetConfig } from '../../../../scripts/ui-scoreboard/ratchet'
import { checkPlugin } from '../../../../scripts/ui-scoreboard/tokens'

setDefaultTimeout(30_000)

const ROOT = resolve(import.meta.dir, '../../../..')
const PLUGIN_ID = 'quirky.git'
const PREFIX = 'plugins/quirky.git/'
const FRAGMENT = `${PREFIX}ui-scoreboard/views.json`
const DIFF = 'view:quirky.git/diff'
const REVIEW_DIFF = `${PREFIX}src/view/ReviewDiff.tsx`
const CONFLICT_REVIEW = `${PREFIX}src/view/ConflictReview.tsx`
const VIEW_CONTROL = `${PREFIX}src/view/view-control.ts`
const REVIEW_LAYOUT = `${PREFIX}src/view/review-layout.ts`
const OWNED = [
  'ConflictFile.tsx', 'ConflictReview.tsx', 'DiffPane.tsx', 'DiffWindow.tsx', 'Fallbacks.tsx',
  'MarkdownPreview.tsx', 'ReviewCard.tsx', 'ReviewDiff.tsx', 'commands.ts', 'hosted-tabs.ts',
  'merge.ts', 'review-layout.ts', 'settings.ts', 'view-control.ts',
].map((file) => `${PREFIX}src/view/${file}`)
const PASS: Record<string, true> = {
  'state-covered': true, 'state-not-applicable': true, 'not-state': true,
  'action-routed': true, 'action-transient': true, 'action-not-user': true,
}
const CHECKS: StaticCheckId[] = ['commands', 'compatibility-tokens', 'empty', 'error', 'loading']
let inventory: Inventory
let plugin: PluginInventory

beforeAll(() => {
  inventory = collectInventory(ROOT)
  plugin = inventory.plugins.find((entry) => entry.id === PLUGIN_ID)!
  expect(plugin).toBeDefined()
})

function fragment(source: PluginInventory = plugin): CoverageFile {
  const coverage = source.coverageFragments?.find((entry) => entry.file === FRAGMENT)
  expect(coverage).toBeDefined()
  return parseCoverage(coverage!.content)
}

function withPlugin(source: PluginInventory): Inventory {
  return { ...inventory, plugins: inventory.plugins.map((entry) => entry.id === PLUGIN_ID ? source : entry) }
}

function withCoverage(coverage: CoverageFile): PluginInventory {
  return {
    ...plugin,
    coverageFragments: plugin.coverageFragments!.map((entry) => entry.file === FRAGMENT ? { ...entry, content: JSON.stringify(coverage) } : entry),
  }
}

function clonePlugin(): PluginInventory {
  return JSON.parse(JSON.stringify(plugin)) as PluginInventory
}

function resultFor(results: CheckResult[], id: CheckResult['id']): CheckResult {
  const result = results.find((entry) => entry.id === id)
  expect(result).toBeDefined()
  return result!
}

function sourceReplacement(base: PluginInventory, file: string, before: string, after: string): PluginInventory {
  const copy = JSON.parse(JSON.stringify(base)) as PluginInventory
  const original = copy.sources.find((entry) => entry.file === file)
  expect(original).toBeDefined()
  expect(original!.content.includes(before)).toBe(true)
  copy.sources = copy.sources.map((entry) => entry === original
    ? { ...entry, content: entry.content.replace(before, after) }
    : entry)
  return copy
}


test('the full Git graph has exact owned coverage and all five static checks pass', () => {
  const coverage = fragment()
  expect(coverage.surfaces).toEqual({})

  const graph = discoverUiFiles(plugin)
  expect(graph.failures).toEqual([])
  const candidates = discoverCandidates(plugin, graph.files)
  const ownedCandidates = candidates.filter((candidate) => OWNED.includes(candidate.file))
  expect(ownedCandidates.length).toBeGreaterThan(0)
  expect(ownedCandidates.some((candidate) => candidate.file === VIEW_CONTROL && candidate.kind === 'toast-call')).toBe(true)

  const checks = auditPlugin(inventory, plugin)
  expect(Object.fromEntries(checks.map(({ id, status }) => [id, status]))).toEqual({
    loading: 'pass', empty: 'pass', error: 'pass', commands: 'pass',
  })
  const failures = checks.flatMap((check) => check.evidence).filter((entry) => !PASS[entry.code])
  expect(failures.filter((entry) => OWNED.includes(entry.source?.file ?? '') || entry.source?.file === FRAGMENT || entry.coverageFile === FRAGMENT)).toEqual([])
  expect(inventory.failures.filter((entry) => entry.source?.file.startsWith(PREFIX) || entry.message.includes(PLUGIN_ID))).toEqual([])

  for (const state of ['loading', 'empty', 'error'] as const) {
    expect(coverage.states.some((entry) => entry.surface === DIFF && entry.state === state)).toBe(true)
  }
  expect(checkPlugin(inventory, PLUGIN_ID).map(({ id }) => id).sort()).toEqual(CHECKS.toSorted())
  expect(checkPlugin(inventory, PLUGIN_ID).every(({ status }) => status === 'pass')).toBe(true)
})

test('owned action evidence resolves mounted and public routes', () => {
  const evidence = resultFor(auditPlugin(inventory, plugin), 'commands').evidence
    .filter((entry) => entry.code === 'action-routed' && entry.coverageFile === FRAGMENT)
  const routes = new Set(evidence.map((entry) => `${entry.api} → ${entry.cli}`))

  for (const route of [
    'ui.command.run → quirky ui run command:quirky.git/ui-control',
    'quirky.git/save → quirky git save',
    'setting.set → quirky setting set',
    'quirky.git/status → quirky git status',
    'quirky.git/conflictFile → quirky git conflictFile',
    'quirky.git/diff → quirky git diff',
    'ui.panel.open → quirky ui open-panel panel:quirky.git/source-control',
  ]) {
    expect(routes.has(route), route).toBe(true)
  }
})

test('toast classifications match their source error kinds', () => {
  const coverage = fragment()
  const errorToasts = coverage.states.filter((entry) => 'call' in entry.render && entry.render.component === 'toast')
  expect(errorToasts.some((entry) => 'call' in entry.render && entry.render.call.file === VIEW_CONTROL)).toBe(true)
  for (const entry of errorToasts) {
    if (!('call' in entry.render)) continue
    const call = entry.render.call
    const source = plugin.sources.find((candidate) => candidate.file === call.file)
    expect(source?.content.includes(call.quote)).toBe(true)
    expect(call.quote).toMatch(/\bkind\s*:\s*['"]error['"]/)
  }

  const advisoryToasts = coverage.notState.filter((entry) => entry.site.quote.includes('context.toast('))
  expect(advisoryToasts).toHaveLength(2)
  for (const entry of advisoryToasts) {
    const source = plugin.sources.find((candidate) => candidate.file === entry.site.file)
    expect(source?.content.includes(entry.site.quote)).toBe(true)
    expect(entry.site.quote).toContain('Keep file unavailable')
    expect(entry.site.quote).not.toMatch(/\bkind\s*:\s*['"]error['"]/)
  }
})

test('removing Collapse all coverage exposes its exact action candidate', () => {
  const coverage = fragment()
  const index = coverage.actions.findIndex((entry) => 'route' in entry && entry.site.file === REVIEW_DIFF && JSON.stringify(entry).includes('collapse-all'))
  expect(index).toBeGreaterThanOrEqual(0)
  const [removed] = coverage.actions.splice(index, 1)
  const changed = withCoverage(coverage)
  const commands = resultFor(auditPlugin(withPlugin(changed), changed), 'commands')

  expect(removed).toBeDefined()
  expect(commands.status).toBe('fail')
  expect(commands.evidence).toEqual(expect.arrayContaining([
    expect.objectContaining({
      code: 'coverage-missing',
      source: expect.objectContaining({ file: REVIEW_DIFF }),
    }),
  ]))
})

test('raw markup cannot replace the ReviewDiff loading witness', () => {
  const witness = fragment().states.find((entry) => entry.state === 'loading' && entry.render.component === 'NoticeLine' && entry.render.element.file === REVIEW_DIFF && entry.render.element.quote.includes('Loading diff...'))
  expect(witness).toBeDefined()
  const entry = witness!
  if (entry.render.component === 'toast') throw new Error('Expected a shared loading witness')
  const changed = sourceReplacement(plugin, REVIEW_DIFF, entry.render.element.quote, '<p>Loading diff...</p>')
  const loading = resultFor(auditPlugin(withPlugin(changed), changed), 'loading')
  expect(loading.status).toBe('fail')
  expect(loading.evidence.some((entry) => entry.code === 'evidence-missing' && entry.coverageFile === FRAGMENT)).toBe(true)
})

test('raw markup cannot replace the ConflictReview InlineError witness', () => {
  const witness = fragment().states.find((entry) => entry.state === 'error' && entry.render.component === 'InlineError' && entry.render.element.file === CONFLICT_REVIEW)
  expect(witness).toBeDefined()
  const entry = witness!
  if (entry.render.component === 'toast') throw new Error('Expected a shared error witness')
  const changed = sourceReplacement(plugin, CONFLICT_REVIEW, entry.render.element.quote, '<span>Conflict review failed</span>')
  const error = resultFor(auditPlugin(withPlugin(changed), changed), 'error')
  expect(error.status).toBe('fail')
  expect(error.evidence.some((entry) => entry.code === 'evidence-missing' && entry.coverageFile === FRAGMENT)).toBe(true)
})

test('restoring the dynamic review assignment exposes unresolved-assignment coverage', () => {
  const copy = clonePlugin()
  const original = copy.sources.find((entry) => entry.file === REVIEW_LAYOUT)
  expect(original).toBeDefined()
  copy.sources = copy.sources.map((entry) => entry === original
    ? { ...entry, content: `${entry.content}\nfunction restoreAssignment(next: Record<string, unknown> | null, ui: Record<string, unknown>, item: { key: string; mark: string }) { (next ??= { ...ui })[item.key] = freshCard(item.mark) }\n` }
    : entry)
  const commands = resultFor(auditPlugin(withPlugin(copy), copy), 'commands')

  expect(commands.status).toBe('fail')
  expect(commands.evidence).toEqual(expect.arrayContaining([
    expect.objectContaining({
      code: 'coverage-missing',
      message: expect.stringContaining('unresolved-assignment'),
      source: expect.objectContaining({ file: REVIEW_LAYOUT }),
    }),
  ]))
})

test('the ratchet enrolls Git in all five checks and accepts the collected inventory', () => {
  const ratchet = parseRatchetConfig(readFileSync(resolve(ROOT, 'scripts/ui-scoreboard-ratchet.json'), 'utf8'))
  expect(ratchet[PLUGIN_ID]).toEqual(CHECKS)

  const result = checkRatchet(inventory, { [PLUGIN_ID]: CHECKS })
  expect(result.exitCode).toBe(0)
  expect(result.failures).toEqual([])
}, 30_000)
