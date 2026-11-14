import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { auditPlugin } from '../../../scripts/ui-scoreboard/audit'
import { discoverCandidates, discoverUiFiles } from '../../../scripts/ui-scoreboard/audit-discovery'
import type { CoverageFile, Evidence, Inventory, PluginInventory } from '../../../scripts/ui-scoreboard/contracts'
import { collectInventory } from '../../../scripts/ui-scoreboard/inventory'

const repoRoot = join(import.meta.dir, '../../..')
const D = 'plugins/quirky.tasks'
const FRAGMENT = `${D}/ui-scoreboard/detail.json`
const COVERED = ['src/list/PrDetail.tsx', 'src/list/usePrDescription.ts', 'src/issue/IssueSurface.tsx', 'src/issue/Markdown.tsx', 'src/issue/issue-control.ts'].map((file) => `${D}/${file}`)
const PASS: Record<string, true> = { 'state-covered': true, 'state-not-applicable': true, 'not-state': true, 'action-routed': true, 'action-transient': true, 'action-not-user': true }
const inventory = collectInventory(repoRoot)
const plugin = inventory.plugins.find((entry) => entry.id === 'quirky.tasks')!

function failures(source: Inventory, target: PluginInventory): Evidence[] {
  return auditPlugin(source, target).flatMap((check) => check.evidence).filter((item) => !PASS[item.code])
}
const ours = (item: Evidence) => COVERED.includes(item.source?.file ?? '') || item.coverageFile === FRAGMENT

test('detail.json covers every candidate in the issue and pull-request detail files', () => {
  expect(plugin.coverageFragments?.map((file) => file.file)).toContain(FRAGMENT)
  const coverage = JSON.parse(plugin.coverageFragments!.find((file) => file.file === FRAGMENT)!.content) as CoverageFile
  expect(coverage.surfaces).toEqual({})
  const graph = discoverUiFiles(plugin)
  expect(graph.failures).toEqual([])
  expect(graph.files).toEqual(expect.arrayContaining(COVERED))
  const kinds = discoverCandidates(plugin, graph.files).filter((candidate) => COVERED.includes(candidate.file)).map((candidate) => candidate.kind)
  expect(kinds.filter((kind) => kind.startsWith('unresolved-'))).toEqual([])
  expect(failures(inventory, plugin).filter(ours)).toEqual([])
  const states = new Set(coverage.states.map((entry) => `${entry.surface} ${entry.state} ${entry.site.file.split('/').at(-1)}`))
  for (const expected of ['loading PrDetail.tsx', 'error PrDetail.tsx', 'empty PrDetail.tsx', 'loading IssueSurface.tsx', 'empty IssueSurface.tsx', 'error IssueSurface.tsx', 'empty Markdown.tsx', 'error Markdown.tsx']) {
    expect(states.has(`view:quirky.tasks/tasks ${expected}`)).toBe(true)
  }
})

test('the audit catches a stale quote and a new raw alert in the detail files', () => {
  const coverage = plugin.coverageFragments!.find((file) => file.file === FRAGMENT)!
  const parsed = JSON.parse(coverage.content) as CoverageFile
  const first = parsed.states[0]!
  const stale = { ...parsed, states: [{ ...first, site: { ...first.site, quote: `${first.site.quote}~` } }, ...parsed.states.slice(1)] }
  const drifted = { ...plugin, coverageFragments: plugin.coverageFragments!.map((file) => file.file === FRAGMENT ? { ...file, content: JSON.stringify(stale) } : file) }
  expect(failures(inventory, drifted).some((item) => item.code === 'evidence-missing' && item.coverageFile === FRAGMENT)).toBe(true)

  const file = `${D}/src/issue/IssueSurface.tsx`
  const sources = plugin.sources.map((source) => source.file === file ? { ...source, content: source.content.replace('  </main>\n}', '    <p role="alert">x</p>\n  </main>\n}') } : source)
  expect(sources.find((source) => source.file === file)!.content).toContain('<p role="alert">x</p>')
  const raw = { ...plugin, sources }
  expect(failures(inventory, raw).some((item) => item.code === 'coverage-missing' && item.source?.file === file)).toBe(true)
})

test('the manifest declares issue-control as a hidden command with a single-type schema', async () => {
  const manifest = await Bun.file(join(repoRoot, D, 'quirky-plugin.json')).json() as { contributes: { command: Array<Record<string, unknown>> } }
  const command = manifest.contributes.command.find((entry) => entry.id === 'issue-control')
  expect(command).toMatchObject({
    palette: false,
    args: {
      type: 'object', additionalProperties: false, required: ['worktree', 'number', 'action'],
      properties: { worktree: { type: 'string' }, number: { type: 'integer', minimum: 1 }, action: { type: 'string', enum: ['edit-description', 'cancel-description', 'cancel-duplicate'] } }
    }
  })
  expect(plugin.contributions?.commands).toContain('command:quirky.tasks/issue-control')
})
