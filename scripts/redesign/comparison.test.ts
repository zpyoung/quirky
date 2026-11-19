import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ComparisonData } from './contracts'
import { renderComparison } from './comparison'

const SCRIPT = join(import.meta.dir, 'comparison.ts')

function data(overrides: Partial<ComparisonData> = {}): ComparisonData {
  return {
    feature: 'Source control',
    failures: [],
    goals: [
      { id: 'g1', title: 'Stage a file', tag: 'fixture', before: 'shots/g1-before.png', after: 'shots/g1-after.png', result: 'replayed' },
      { id: 'g2', title: 'Resolve a conflict', tag: 'fixture', before: 'shots/g2-before.png', after: null, result: 'failed', reason: 'button missing' },
      { id: 'g3', title: 'Open the stash', tag: 'real-app', before: null, after: null, result: 'cut', reason: 'unused' },
      { id: 'g4', title: 'Push to remote', tag: 'real-app', before: null, after: null, result: 'not-replayed', reason: 'needs a real remote' }
    ],
    gate: {
      passed: false,
      floor: 85,
      rows: [
        { id: 'changes', before: { dark: 71, light: 74 }, after: { dark: 88, light: 90 }, result: 'clears', reasons: [] },
        { id: 'review', before: null, after: { dark: 86, light: 84 }, result: 'fails', reasons: ['light 84 below 85'] },
        { id: 'fresh', before: null, after: { dark: 90, light: 91 }, result: 'new', reasons: [] },
        { id: 'conflict', before: { dark: 89, light: null }, after: { dark: 87, light: 92 }, result: 'fails', reasons: ['dark 87 below before 89'] },
        { id: 'old', before: { dark: 60, light: 61 }, after: null, result: 'removed', reasons: [] }
      ]
    },
    capabilities: [
      { name: 'Stage hunks', decision: 'kept' },
      { name: 'Blame view', decision: 'moved', where: 'the file tab' },
      { name: 'Stash list', decision: 'cut', reason: 'rarely used' }
    ],
    ...overrides
  }
}

describe('renderComparison', () => {
  test('opens with the title, then Goals, Scores and Capabilities when nothing failed', () => {
    const page = renderComparison(data())
    expect(page.startsWith('# Source control: before and after\n')).toBe(true)
    expect(page).not.toContain('Still failing')
    const order = ['## Goals', '## Scores', '## Capabilities'].map((heading) => page.indexOf(heading))
    expect(order.every((index) => index > 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  test('puts Still failing first, right after the title', () => {
    const page = renderComparison(data({ failures: ['g2: button missing', 'review: light 84 below 85'] }))
    const headings = page.split('\n').filter((line) => line.startsWith('#'))
    expect(headings).toEqual(['# Source control: before and after', '## Still failing', '## Goals', '## Scores', '## Capabilities'])
    expect(page).toContain('- g2: button missing')
    expect(page).toContain('- review: light 84 below 85')
  })

  test('renders every goal result kind', () => {
    const page = renderComparison(data())
    expect(page).toContain('| Goal | Before | After | Result |')
    expect(page).toContain('✓ replayed')
    expect(page).toContain('✗ failed: button missing')
    expect(page).toContain('cut: unused')
    expect(page).toContain('not replayed: needs a real remote')
  })

  test('renders screenshots as sized img tags and an absent one as none', () => {
    const page = renderComparison(data())
    expect(page).toContain('<img src="shots/g1-before.png" width="420">')
    expect(page).toContain('<img src="shots/g1-after.png" width="420">')
    const failedRow = page.split('\n').find((line) => line.includes('Resolve a conflict'))!
    expect(failedRow).toContain('<img src="shots/g2-before.png" width="420"> | none |')
  })

  test('escapes pipes in text so a table row keeps its columns', () => {
    const page = renderComparison(data({ goals: [{ id: 'g1', title: 'a | b', tag: 'fixture', before: null, after: null, result: 'cut', reason: 'x | y' }] }))
    const row = page.split('\n').find((line) => line.includes('a \\| b'))!
    expect(row).toContain('cut: x \\| y')
  })

  test('renders score rows from the gate report', () => {
    const page = renderComparison(data())
    expect(page).toContain('| Surface | Before (dark / light) | After (dark / light) | Result |')
    expect(page).toContain('| changes | 71 / 74 | 88 / 90 | ✓ clears |')
    expect(page).toContain('| review | none, new | 86 / 84 | ✗ light 84 below 85 |')
    expect(page).toContain('| fresh | none, new | 90 / 91 | ✓ clears |')
    expect(page).toContain('| conflict | 89 / none | 87 / 92 | ✗ dark 87 below before 89 |')
    expect(page).toContain('| old | 60 / 61 | removed | removed |')
  })

  test('renders every capability decision', () => {
    const page = renderComparison(data())
    expect(page).toContain('| Capability | Decision |')
    expect(page).toContain('| Stage hunks | kept |')
    expect(page).toContain('| Blame view | moved to the file tab |')
    expect(page).toContain('| Stash list | cut: rarely used |')
  })
})

describe('comparison.ts CLI', () => {
  async function cli(folder: string, payload: unknown) {
    const dataPath = join(folder, 'comparison-data.json')
    await writeFile(dataPath, typeof payload === 'string' ? payload : JSON.stringify(payload))
    const proc = Bun.spawn([process.execPath, SCRIPT, folder, dataPath], { stdout: 'pipe', stderr: 'pipe' })
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    return { exitCode, json: JSON.parse(stdout) as Record<string, string> }
  }

  test('writes comparison.md and prints its path', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'redesign-comparison-'))
    const { exitCode, json } = await cli(folder, data())
    expect(exitCode).toBe(0)
    expect(json.written).toBe(join(folder, 'comparison.md'))
    expect(await readFile(json.written!, 'utf8')).toBe(renderComparison(data()))
  })

  test.each([
    ['feature', { ...data(), feature: '' }, 'feature'],
    ['failures', { ...data(), failures: 'nope' }, 'failures'],
    ['goal result', { ...data(), goals: [{ ...data().goals[0]!, result: 'maybe' }] }, 'goals[0].result'],
    ['goal reason', { ...data(), goals: [{ ...data().goals[0]!, result: 'cut' }] }, 'goals[0].reason'],
    ['goal screenshot', { ...data(), goals: [{ ...data().goals[0]!, before: 5 }] }, 'goals[0].before'],
    ['gate', { ...data(), gate: { passed: true } }, 'gate.floor'],
    ['capability where', { ...data(), capabilities: [{ name: 'x', decision: 'moved' }] }, 'capabilities[0].where'],
    ['capability reason', { ...data(), capabilities: [{ name: 'x', decision: 'cut' }] }, 'capabilities[0].reason']
  ])('exits 2 naming the bad field: %s', async (_label, payload, field) => {
    const folder = await mkdtemp(join(tmpdir(), 'redesign-comparison-'))
    const { exitCode, json } = await cli(folder, payload)
    expect(exitCode).toBe(2)
    expect(json.error).toContain(field)
  })

  test('exits 2 on unparseable JSON', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'redesign-comparison-'))
    const { exitCode, json } = await cli(folder, '{not json')
    expect(exitCode).toBe(2)
    expect(json.error).toBeString()
  })

  test('exits 2 when arguments are missing', async () => {
    const proc = Bun.spawn([process.execPath, SCRIPT], { stdout: 'pipe', stderr: 'pipe' })
    const stdout = await new Response(proc.stdout).text()
    expect(await proc.exited).toBe(2)
    expect(JSON.parse(stdout).error).toBeString()
  })
})
