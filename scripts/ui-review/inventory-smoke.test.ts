import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { captureApplication } from './capture'
import { captureBrowserExecutable } from './browser'
import { pngDimensions } from './goldens'
import { collectInventory } from '../ui-scoreboard/inventory'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const ids = [
  'sidebar-section:quirky.agent-status/dashboard',
  'view:quirky.mobile/page',
  'panel:quirky.editor/explorer',
  'view:quirky.automations/automations',
  'view:quirky.heimdall/fleet',
  'panel:quirky.ledger/ledger'
]

test('conditional and canonical tool bodies capture twelve real cells with matching source inventory', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'quirky-inventory-smoke-'))
  const previousHome = process.env.QUIRKY_HOME
  process.env.QUIRKY_HOME = join(scratch, 'home')
  mkdirSync(process.env.QUIRKY_HOME)
  const outputDir = join(scratch, 'output')
  mkdirSync(outputDir)
  try {
    const manifest = await captureApplication({
      repoRoot, outputDir, only: ids, skipBuild: false,
      browserExecutable: captureBrowserExecutable(), timeoutMs: 180_000
    })
    expect(manifest.failures).toEqual([])
    expect(manifest.targets.map(({ id }) => id).sort()).toEqual([...ids].sort())
    const expected = ids.flatMap((id) => ['dark', 'light'].map((theme) => `${id}\0${theme}`)).sort()
    expect(manifest.captures.map(({ targetId, theme }) => `${targetId}\0${theme}`).sort()).toEqual(expected)
    for (const cell of manifest.captures) {
      expect(cell.status).toBe('captured')
      expect(cell.image).not.toBeNull()
      const bytes = readFileSync(cell.image!.path)
      expect(bytes.byteLength).toBeGreaterThan(0)
      expect(pngDimensions(bytes)).toEqual({ width: 2800, height: 1760 })
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(cell.image!.sha256)
    }
    expect(manifest.activatedVisibilitySettings).toContain('setting:quirky.agent-status/dashboard-enabled')
    const source = collectInventory(repoRoot)
    const scoped = manifest.contributionInventory!
    expect(scoped).toBeDefined()
    const owners = new Set(manifest.targets.map(({ plugin }) => plugin))
    const shape = (target: { id: string; plugin: string | null; kind: string }) => ({ id: target.id, plugin: target.plugin, kind: target.kind })
    const selected = new Set(ids)
    const aliases = source.contributionInventory!.toolAliases.filter((alias) => selected.has(alias.renderedTarget.id))
    const declarations = source.contributionInventory!.declaredTargets.filter((target) =>
      selected.has(target.id) || aliases.some((alias) => alias.declaration.id === target.id))
    expect(scoped.declaredTargets.map(shape)).toEqual(declarations.map(shape))
    expect(scoped.toolAliases.map((alias) => ({ declaration: shape(alias.declaration), toolId: alias.toolId, renderedTarget: shape(alias.renderedTarget), reason: alias.reason })))
      .toEqual(aliases.map((alias) => ({ declaration: shape(alias.declaration), toolId: alias.toolId, renderedTarget: shape(alias.renderedTarget), reason: alias.reason })))
    expect(scoped.declaredTargets.every((target) => owners.has(target.plugin))).toBe(true)
    expect(scoped.toolAliases).toHaveLength(5)
    console.log(`inventory smoke: ${manifest.captures.length} captured cells; no model review`)
  } finally {
    if (previousHome === undefined) delete process.env.QUIRKY_HOME
    else process.env.QUIRKY_HOME = previousHome
    rmSync(scratch, { recursive: true, force: true })
  }
}, 600_000)
