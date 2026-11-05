import { describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GateReport, Scores } from './contracts'
import { SCORE_FLOOR, applyGate, runScore, scoresFromReport, type UiReviewRunner } from './score'

const SCRIPT = join(import.meta.dir, 'score.ts')

function capture(targetId: string, theme: 'dark' | 'light', score: number, targetVisible = true) {
  return { targetId, theme, score, passed: targetVisible && score >= 85, assessment: { targetVisible } }
}

const report = {
  schemaVersion: 1,
  createdAt: '2026-11-05T10:00:00.000Z',
  status: 'failed',
  captures: [
    capture('panel:quirky.git/source-control', 'dark', 71),
    capture('panel:quirky.git/source-control', 'light', 74),
    capture('view:quirky.git/review', 'dark', 88.5),
    capture('view:quirky.git/review', 'light', 0, false)
  ]
}

function scores(surfaces: Array<[string, number | null, number | null]>): Scores {
  return {
    createdAt: '2026-11-05T10:00:00.000Z',
    plugins: ['quirky.git'],
    reportPath: '/tmp/report.json',
    surfaces: surfaces.map(([id, dark, light]) => ({ id, plugin: 'quirky.git', dark, light }))
  }
}

describe('scoresFromReport', () => {
  test('pairs dark and light scores per target and parses the plugin from the id', () => {
    const result = scoresFromReport(report, ['quirky.git'])
    expect(result.createdAt).toBe(report.createdAt)
    expect(result.plugins).toEqual(['quirky.git'])
    expect(result.surfaces[0]).toEqual({
      id: 'panel:quirky.git/source-control',
      plugin: 'quirky.git',
      dark: 71,
      light: 74
    })
  })

  test('gives null to a theme whose target was not visible', () => {
    const result = scoresFromReport(report, ['quirky.git'])
    expect(result.surfaces[1]).toEqual({ id: 'view:quirky.git/review', plugin: 'quirky.git', dark: 88.5, light: null })
  })

  test('gives null to a theme with no capture at all', () => {
    const result = scoresFromReport({ ...report, captures: [capture('panel:a.b/c', 'dark', 90)] }, ['a.b'])
    expect(result.surfaces).toEqual([{ id: 'panel:a.b/c', plugin: 'a.b', dark: 90, light: null }])
  })

  test('rejects a report without a captures array', () => {
    expect(() => scoresFromReport({ status: 'passed' }, [])).toThrow('captures')
    expect(() => scoresFromReport(null, [])).toThrow('captures')
  })
})

describe('applyGate', () => {
  const before = scores([
    ['changes', 71, 74],
    ['conflict', 89, 91]
  ])
  const after = scores([
    ['changes', 88, 90],
    ['review', 86, 84],
    ['conflict', 87, 92]
  ])

  test('reproduces the SC-19 example table', () => {
    const gate = applyGate(before, after, [])
    expect(gate.floor).toBe(SCORE_FLOOR)
    expect(gate.passed).toBe(false)
    const byId = Object.fromEntries(gate.rows.map((row) => [row.id, row]))
    expect(byId.changes).toMatchObject({ result: 'clears', reasons: [], before: { dark: 71, light: 74 }, after: { dark: 88, light: 90 } })
    expect(byId.review).toMatchObject({ result: 'fails', reasons: ['light 84 below 85'], before: null })
    expect(byId.conflict).toMatchObject({ result: 'fails', reasons: ['dark 87 below before 89'] })
  })

  test('marks a new surface that clears the floor as new', () => {
    const gate = applyGate(scores([]), scores([['fresh', 85, 90]]), [])
    expect(gate.rows[0]).toMatchObject({ id: 'fresh', result: 'new', reasons: [] })
    expect(gate.passed).toBe(true)
  })

  test('marks a surface removed when it is listed, and never scores it', () => {
    const gate = applyGate(scores([['gone', 10, 10]]), scores([]), ['gone'])
    expect(gate.rows).toEqual([{ id: 'gone', before: { dark: 10, light: 10 }, after: null, result: 'removed', reasons: [] }])
    expect(gate.passed).toBe(true)
  })

  test('fails an unlisted surface that is missing after', () => {
    const gate = applyGate(scores([['gone', 90, 90]]), scores([]), [])
    expect(gate.rows[0]).toMatchObject({ id: 'gone', result: 'fails', reasons: ['missing after'], after: null })
    expect(gate.passed).toBe(false)
  })

  test('fails a null after score as not captured', () => {
    const gate = applyGate(scores([['x', 80, 80]]), scores([['x', null, 90]]), [])
    expect(gate.rows[0]).toMatchObject({ result: 'fails', reasons: ['dark not captured'] })
  })

  test('reports one reason per broken rule', () => {
    const gate = applyGate(scores([['x', 89, 91]]), scores([['x', 80, 92]]), [])
    expect(gate.rows[0]!.reasons).toEqual(['dark 80 below 85', 'dark 80 below before 89'])
  })

  test('clears at exactly the floor and at an unchanged score', () => {
    const gate = applyGate(scores([['x', 85, 85]]), scores([['x', 85, 85]]), [])
    expect(gate.rows[0]!.result).toBe('clears')
  })

  test('ignores a null before theme when comparing to before', () => {
    const gate = applyGate(scores([['x', null, 80]]), scores([['x', 86, 86]]), [])
    expect(gate.rows[0]!.result).toBe('clears')
  })
})

describe('runScore', () => {
  async function freshRoot() {
    return mkdtemp(join(tmpdir(), 'redesign-score-'))
  }

  const writingRunner =
    (reportBody: unknown, exitCode: number, stderrTail = ''): UiReviewRunner =>
    async ({ outputDir }) => {
      if (reportBody !== null) {
        await mkdir(outputDir, { recursive: true })
        await writeFile(join(outputDir, 'review-report.json'), JSON.stringify(reportBody))
      }
      return { exitCode, stderrTail }
    }

  test('writes scores.json when ui:review reports failed, since a before pass expects low scores', async () => {
    const out = join(await freshRoot(), 'before')
    const result = await runScore({ plugins: ['quirky.git'], out, authorFamily: 'anthropic' }, writingRunner(report, 1))
    expect(result.exitCode).toBe(0)
    const written = JSON.parse(await readFile(join(out, 'scores.json'), 'utf8')) as Scores
    expect(written.reportPath).toBe(join(out, 'ui-review', 'review-report.json'))
    expect(written.surfaces).toHaveLength(2)
  })

  test('passes the plugin selectors and threshold to the runner', async () => {
    const out = join(await freshRoot(), 'before')
    let seen: string[] = []
    await runScore({ plugins: ['a.b', 'c.d'], out, authorFamily: 'google' }, async (input) => {
      seen = input.args
      await mkdir(input.outputDir, { recursive: true })
      await writeFile(join(input.outputDir, 'review-report.json'), JSON.stringify({ ...report, status: 'passed' }))
      return { exitCode: 0, stderrTail: '' }
    })
    expect(seen).toEqual(['--author-family', 'google', '--output', join(out, 'ui-review'), '--threshold', '85', '--only', 'a.b', '--only', 'c.d'])
  })

  test('exits 2 with the stderr tail when ui:review wrote no report', async () => {
    const out = join(await freshRoot(), 'before')
    const result = await runScore({ plugins: ['a.b'], out, authorFamily: 'anthropic' }, writingRunner(null, 2, 'no browser installed'))
    expect(result.exitCode).toBe(2)
    expect(result.json).toMatchObject({ error: expect.stringContaining('no browser installed') })
  })

  test('exits 2 when the report status is error', async () => {
    const out = join(await freshRoot(), 'before')
    const result = await runScore({ plugins: ['a.b'], out, authorFamily: 'anthropic' }, writingRunner({ ...report, status: 'error' }, 2, 'reviewer down'))
    expect(result.exitCode).toBe(2)
    expect(result.json).toMatchObject({ error: expect.stringContaining('reviewer down') })
  })

  test('refuses an output directory that already exists', async () => {
    const out = await freshRoot()
    const result = await runScore({ plugins: ['a.b'], out, authorFamily: 'anthropic' }, writingRunner(report, 0))
    expect(result.exitCode).toBe(2)
    expect(result.json).toMatchObject({ error: expect.stringContaining('already exists') })
  })
})

describe('score.ts CLI', () => {
  async function cli(...args: string[]) {
    const proc = Bun.spawn([process.execPath, SCRIPT, ...args], { stdout: 'pipe', stderr: 'pipe' })
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    return { exitCode, json: JSON.parse(stdout) as Record<string, unknown> }
  }

  test('run without --plugin exits 2 with a JSON error', async () => {
    const { exitCode, json } = await cli('run', '--out', join(tmpdir(), 'redesign-score-never'))
    expect(exitCode).toBe(2)
    expect(json.error).toContain('--plugin')
  })

  test('run without --out exits 2', async () => {
    const { exitCode, json } = await cli('run', '--plugin', 'a.b')
    expect(exitCode).toBe(2)
    expect(json.error).toContain('--out')
  })

  test('run with an existing --out exits 2', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'redesign-score-'))
    const { exitCode, json } = await cli('run', '--plugin', 'a.b', '--out', dir)
    expect(exitCode).toBe(2)
    expect(json.error).toContain('already exists')
  })

  test('an unknown subcommand exits 2', async () => {
    const { exitCode } = await cli('nope')
    expect(exitCode).toBe(2)
  })

  test('gate exits 1 with the report when a surface fails, and 0 when none do', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'redesign-score-'))
    const beforePath = join(dir, 'before.json')
    const afterPath = join(dir, 'after.json')
    await writeFile(beforePath, JSON.stringify(scores([['x', 80, 80]])))
    await writeFile(afterPath, JSON.stringify(scores([['x', 84, 90]])))
    const failing = await cli('gate', '--before', beforePath, '--after', afterPath)
    expect(failing.exitCode).toBe(1)
    expect((failing.json as unknown as GateReport).rows[0]!.reasons).toEqual(['dark 84 below 85'])

    await writeFile(afterPath, JSON.stringify(scores([['x', 90, 90]])))
    const passing = await cli('gate', '--before', beforePath, '--after', afterPath)
    expect(passing.exitCode).toBe(0)
    expect((passing.json as unknown as GateReport).passed).toBe(true)
  })

  test('gate honors --removed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'redesign-score-'))
    await writeFile(join(dir, 'b.json'), JSON.stringify(scores([['x', 80, 80]])))
    await writeFile(join(dir, 'a.json'), JSON.stringify(scores([])))
    const { exitCode, json } = await cli('gate', '--before', join(dir, 'b.json'), '--after', join(dir, 'a.json'), '--removed', 'x')
    expect(exitCode).toBe(0)
    expect((json as unknown as GateReport).rows[0]!.result).toBe('removed')
  })

  test('gate with an unreadable file exits 2', async () => {
    const { exitCode, json } = await cli('gate', '--before', '/nonexistent/b.json', '--after', '/nonexistent/a.json')
    expect(exitCode).toBe(2)
    expect(json.error).toBeString()
  })
})
