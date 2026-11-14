import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { collectInventory } from '../../../scripts/ui-scoreboard/inventory'
import { discoverCandidates, discoverUiFiles } from '../../../scripts/ui-scoreboard/audit-discovery'
import { auditPlugin } from '../../../scripts/ui-scoreboard/audit'
import { checkPlugin } from '../../../scripts/ui-scoreboard/tokens'

const root = resolve(import.meta.dir, '../../..')
const inventory = collectInventory(root)
const plugin = inventory.plugins.find(({ id }) => id === 'quirky.automations')!
const graph = discoverUiFiles(plugin)
const candidates = discoverCandidates(plugin, graph.files)
const coveredFiles = [
  `${plugin.directory}/ui-scoreboard/editor.json`,
  `${plugin.directory}/src/ui.tsx`,
  `${plugin.directory}/src/editor/AutomationEditor.tsx`,
  `${plugin.directory}/src/list/SafeMarkdown.tsx`,
]
const passCodes: Record<string, true> = { 'state-covered': true, 'state-not-applicable': true, 'not-state': true, 'action-routed': true, 'action-transient': true, 'action-not-user': true }

describe('Automations shell and editor scoreboard', () => {
  test('UI discovery excludes daemon service and storage dependencies', () => {
    expect(graph.failures).toEqual([])
    expect(graph.files).toHaveLength(11)
    expect(graph.files).not.toContain(`${plugin.directory}/service.ts`)
    expect(graph.files).not.toContain(`${plugin.directory}/store.ts`)
  })

  test('option changes have no unresolved assignment action', () => {
    expect(candidates.filter(({ file, kind }) => file.endsWith('/editor/AutomationEditor.tsx') && kind === 'unresolved-assignment')).toEqual([])
  })

  test('production sources consume only supported UI tokens', () => {
    expect(checkPlugin(inventory, plugin.id).find(({ id }) => id === 'compatibility-tokens')?.status).toBe('pass')
  })

  test('the editor fragment declares all three surfaces with their state applicability', () => {
    const source = plugin.coverageFragments?.find(({ file }) => file === coveredFiles[0])
    expect(source).toBeDefined()
    const fragment = JSON.parse(source!.content)
    expect(Object.keys(fragment.surfaces).sort()).toEqual(plugin.targets.toSorted())
    for (const surface of ['sidebar-section:quirky.automations/automations', 'view:quirky.automations/settings']) {
      expect(fragment.surfaces[surface].loading.applicable).toBe(false)
      expect(fragment.surfaces[surface].empty.applicable).toBe(false)
      expect(fragment.surfaces[surface].error.applicable).toBe(true)
    }
    expect(fragment.surfaces['view:quirky.automations/automations']).toEqual({
      loading: { applicable: true }, empty: { applicable: true }, error: { applicable: true },
    })
  })

  test('only the list page remains uncovered by the editor fragment', () => {
    const failures = auditPlugin(inventory, plugin).flatMap(({ evidence }) => evidence).filter(({ code }) => !passCodes[code])
    expect(failures.filter(({ source, coverageFile }) => coveredFiles.includes(source?.file ?? '') || coveredFiles.includes(coverageFile ?? ''))).toEqual([])
    expect(failures.filter(({ code }) => code !== 'coverage-missing')).toEqual([])
    const missing = failures.filter(({ code }) => code === 'coverage-missing')
    expect(missing.length).toBeGreaterThan(0)
    expect([...new Set(missing.map(({ source }) => source?.file))]).toEqual([`${plugin.directory}/src/list/AutomationsPage.tsx`])
  })
})
