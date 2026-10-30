import { describe, expect, test } from 'bun:test'
import { compareResults } from './compare'
import type { Attempt, Baseline, FileError, FileResult, Selection, TestStatus } from './types'

type Input = Parameters<typeof compareResults>[0]

const k = (file: string, name: string, classname = 'suite') => `${file}\0${classname}\0${name}`
const A = 'pkg/a.test.ts'
const B = 'pkg/b.test.ts'

function attempt(tests: Record<string, TestStatus> = {}, opts: { exitCode?: number; fileError?: FileError } = {}): Attempt {
  const failed = Object.values(tests).includes('failed')
  return {
    exitCode: opts.exitCode ?? (failed ? 1 : 0),
    fileError: opts.fileError ?? null,
    tests: Object.entries(tests).map(([key, status]) => ({ key, status })),
  }
}

function file(name: string, first: Attempt, rerun?: Attempt): FileResult {
  return { file: name, platform: 'linux', durationMs: 10, first, ...(rerun ? { rerun } : {}) }
}

function baselineOf(
  tests: Record<string, TestStatus>,
  files: Record<string, { fileError: FileError }> = {},
): Baseline {
  return {
    version: 1,
    commit: 'c'.repeat(40),
    createdAt: '2026-10-30T00:00:00.000Z',
    runId: '1',
    files: Object.fromEntries(
      Object.entries(files).map(([name, f]) => [name, { platform: 'linux' as const, durationMs: 10, flaky: false, ...f }]),
    ),
    tests,
    flakeHistory: {},
  }
}

function selectionOf(files: string[]): Selection {
  return { mode: 'some', files, reasons: [] }
}

function run(over: Partial<Input> & { results: FileResult[] }): ReturnType<typeof compareResults> {
  return compareResults({
    baseline: null,
    selection: selectionOf(over.results.map((r) => r.file)),
    deleted: [],
    notOnCi: [],
    advisory: false,
    runBroken: false,
    ...over,
  })
}

describe('labels', () => {
  test('a failure the baseline also has is known and does not block', () => {
    const v = run({
      baseline: baselineOf({ [k(A, 'x')]: 'failed' }),
      results: [file(A, attempt({ [k(A, 'x')]: 'failed' }))],
    })
    expect(v.known).toEqual([k(A, 'x')])
    expect(v.new).toEqual([])
    expect(v.ok).toBe(true)
  })

  test('a failure the baseline passed is new and blocks', () => {
    const v = run({
      baseline: baselineOf({ [k(A, 'x')]: 'passed' }),
      results: [file(A, attempt({ [k(A, 'x')]: 'failed' }))],
    })
    expect(v.new).toEqual([k(A, 'x')])
    expect(v.ok).toBe(false)
  })

  test('a failure absent from the baseline is new', () => {
    const v = run({ baseline: baselineOf({}), results: [file(A, attempt({ [k(A, 'x')]: 'failed' }))] })
    expect(v.new).toEqual([k(A, 'x')])
  })

  test('a pass the baseline failed is fixed', () => {
    const v = run({
      baseline: baselineOf({ [k(A, 'x')]: 'failed' }),
      results: [file(A, attempt({ [k(A, 'x')]: 'passed' }))],
    })
    expect(v.fixed).toEqual([k(A, 'x')])
    expect(v.ok).toBe(true)
  })

  test('a skip the baseline failed is neither fixed nor missing', () => {
    const v = run({
      baseline: baselineOf({ [k(A, 'x')]: 'failed' }),
      results: [file(A, attempt({ [k(A, 'x')]: 'skipped' }))],
    })
    expect(v.fixed).toEqual([])
    expect(v.missing).toEqual([])
  })

  test('a pass the baseline passed carries no label', () => {
    const v = run({
      baseline: baselineOf({ [k(A, 'x')]: 'passed' }),
      results: [file(A, attempt({ [k(A, 'x')]: 'passed' }))],
    })
    expect([v.new, v.known, v.flaky, v.fixed, v.missing]).toEqual([[], [], [], [], []])
  })

  test('repeated names keep their suffixed keys as distinct tests', () => {
    const v = run({
      baseline: baselineOf({ [k(A, 'x')]: 'passed', [k(A, 'x#2')]: 'failed' }),
      results: [file(A, attempt({ [k(A, 'x')]: 'failed', [k(A, 'x#2')]: 'failed' }))],
    })
    expect(v.new).toEqual([k(A, 'x')])
    expect(v.known).toEqual([k(A, 'x#2')])
  })
})

describe('SC-6: a PR is blocked only by failures it is responsible for', () => {
  test('known is listed and new blocks', () => {
    const v = run({
      baseline: baselineOf({ [k(A, 'keeps tabs in order')]: 'failed', [k(A, 'opens a pane')]: 'passed' }),
      results: [file(A, attempt({ [k(A, 'keeps tabs in order')]: 'failed', [k(A, 'opens a pane')]: 'failed' }))],
    })
    expect(v.known).toEqual([k(A, 'keeps tabs in order')])
    expect(v.new).toEqual([k(A, 'opens a pane')])
    expect(v.ok).toBe(false)
  })
})

describe('SC-7: a new test must succeed', () => {
  test('a failing test the baseline never saw is new', () => {
    const v = run({
      baseline: baselineOf({ [k(A, 'old')]: 'passed' }),
      results: [file(A, attempt({ [k(A, 'old')]: 'passed', [k(A, 'fresh')]: 'failed' }))],
    })
    expect(v.new).toEqual([k(A, 'fresh')])
  })
})

describe('SC-8: a file that cannot load', () => {
  const loaded = baselineOf({ [k(A, 'x')]: 'passed', [k(A, 'y')]: 'passed' }, { [A]: { fileError: null } })

  test('is a new file-level failure and its tests are not missing', () => {
    const v = run({ baseline: loaded, results: [file(A, attempt({}, { exitCode: 1, fileError: 'no-report' }))] })
    expect(v.new).toEqual([A])
    expect(v.missing).toEqual([])
    expect(v.ok).toBe(false)
  })

  test('is known when the baseline file had the same kind of problem', () => {
    const v = run({
      baseline: baselineOf({}, { [A]: { fileError: 'timeout' } }),
      results: [file(A, attempt({}, { exitCode: 1, fileError: 'no-report' }))],
    })
    expect(v.known).toEqual([A])
    expect(v.new).toEqual([])
    expect(v.ok).toBe(true)
  })

  test('is new when the baseline has no record of the file', () => {
    const v = run({ baseline: baselineOf({}), results: [file(A, attempt({}, { exitCode: 1, fileError: 'timeout' }))] })
    expect(v.new).toEqual([A])
  })

  test('is new with no baseline at all', () => {
    const v = run({ results: [file(A, attempt({}, { exitCode: 1, fileError: 'exit-mismatch' }))] })
    expect(v.new).toEqual([A])
  })

  test('a rerun that still has the error leaves it new', () => {
    const bad = attempt({}, { exitCode: 1, fileError: 'no-report' })
    const v = run({ baseline: loaded, results: [file(A, bad, bad)] })
    expect(v.new).toEqual([A])
    expect(v.flaky).toEqual([])
    expect(v.missing).toEqual([])
  })

  test('a rerun that cleared the error makes the file flaky', () => {
    const v = run({
      baseline: loaded,
      results: [
        file(
          A,
          attempt({}, { exitCode: 1, fileError: 'timeout' }),
          attempt({ [k(A, 'x')]: 'passed', [k(A, 'y')]: 'passed' }),
        ),
      ],
    })
    expect(v.flaky).toEqual([A])
    expect(v.new).toEqual([])
    expect(v.missing).toEqual([])
    expect(v.ok).toBe(true)
  })

  test('a cleared error does not hide tests the rerun lacks', () => {
    const v = run({
      baseline: loaded,
      results: [file(A, attempt({}, { exitCode: 1, fileError: 'timeout' }), attempt({ [k(A, 'x')]: 'passed' }))],
    })
    expect(v.missing).toEqual([k(A, 'y')])
  })
})

describe('SC-9: the baseline has not caught up with main', () => {
  test('a failure the baseline passed is new, and the verdict names the baseline', () => {
    const base = baselineOf({ [k(A, 'x')]: 'passed' })
    const v = run({ baseline: base, results: [file(A, attempt({ [k(A, 'x')]: 'failed' }))] })
    expect(v.new).toEqual([k(A, 'x')])
    expect(v.baseline).toEqual({ commit: base.commit, createdAt: base.createdAt })
  })

  test('the same failure is known once a newer baseline has it', () => {
    const v = run({
      baseline: baselineOf({ [k(A, 'x')]: 'failed' }),
      results: [file(A, attempt({ [k(A, 'x')]: 'failed' }))],
    })
    expect(v.known).toEqual([k(A, 'x')])
    expect(v.ok).toBe(true)
  })
})

describe('SC-10: a flake gets through and is visible', () => {
  const base = baselineOf({ [k(A, 'x')]: 'passed', [k(A, 'y')]: 'passed' })

  test('failed first and passed in the rerun is flaky', () => {
    const v = run({
      baseline: base,
      results: [
        file(
          A,
          attempt({ [k(A, 'x')]: 'failed', [k(A, 'y')]: 'passed' }),
          attempt({ [k(A, 'x')]: 'passed', [k(A, 'y')]: 'passed' }),
        ),
      ],
    })
    expect(v.flaky).toEqual([k(A, 'x')])
    expect(v.new).toEqual([])
    expect(v.ok).toBe(true)
  })

  test('failed in the rerun is judged as failed', () => {
    const v = run({
      baseline: base,
      results: [file(A, attempt({ [k(A, 'x')]: 'failed' }), attempt({ [k(A, 'x')]: 'failed' }))],
    })
    expect(v.new).toEqual([k(A, 'x')])
    expect(v.flaky).toEqual([])
  })

  test('a failure in the rerun alone is judged as failed', () => {
    const v = run({
      baseline: base,
      results: [file(A, attempt({ [k(A, 'x')]: 'passed' }), attempt({ [k(A, 'x')]: 'failed' }))],
    })
    expect(v.new).toEqual([k(A, 'x')])
  })

  test('failed first and absent from the rerun counts as failed', () => {
    const v = run({
      baseline: base,
      results: [file(A, attempt({ [k(A, 'x')]: 'failed' }), attempt({ [k(A, 'y')]: 'passed' }))],
    })
    expect(v.new).toEqual([k(A, 'x')])
    expect(v.flaky).toEqual([])
    expect(v.missing).toEqual([])
  })

  test('a persistent failure the baseline has is known after the rerun', () => {
    const v = run({
      baseline: baselineOf({ [k(A, 'x')]: 'failed' }),
      results: [file(A, attempt({ [k(A, 'x')]: 'failed' }), attempt({ [k(A, 'x')]: 'failed' }))],
    })
    expect(v.known).toEqual([k(A, 'x')])
    expect(v.flaky).toEqual([])
  })

  test('a test failing in the baseline but flaky now is flaky', () => {
    const v = run({
      baseline: baselineOf({ [k(A, 'x')]: 'failed' }),
      results: [file(A, attempt({ [k(A, 'x')]: 'failed' }), attempt({ [k(A, 'x')]: 'passed' }))],
    })
    expect(v.flaky).toEqual([k(A, 'x')])
    expect(v.known).toEqual([])
    expect(v.fixed).toEqual([])
  })

  test('without a rerun each failure is judged against the baseline', () => {
    const v = run({
      baseline: baselineOf({ [k(A, 'x')]: 'failed', [k(A, 'y')]: 'passed' }),
      results: [file(A, attempt({ [k(A, 'x')]: 'failed', [k(A, 'y')]: 'failed' }))],
    })
    expect(v.known).toEqual([k(A, 'x')])
    expect(v.new).toEqual([k(A, 'y')])
    expect(v.flaky).toEqual([])
  })

  test('a test that passed first and in the rerun is not labelled', () => {
    const v = run({
      baseline: base,
      results: [file(A, attempt({ [k(A, 'y')]: 'passed' }), attempt({ [k(A, 'y')]: 'passed' }))],
    })
    expect(v.flaky).toEqual([])
  })
})

describe('SC-11: no usable baseline', () => {
  test('every failure is new, and fixed and missing are empty', () => {
    const v = run({
      baseline: null,
      deleted: [B],
      results: [file(A, attempt({ [k(A, 'x')]: 'failed', [k(A, 'y')]: 'failed', [k(A, 'z')]: 'passed' }))],
    })
    expect(v.new).toEqual([k(A, 'x'), k(A, 'y')])
    expect(v.known).toEqual([])
    expect(v.fixed).toEqual([])
    expect(v.missing).toEqual([])
    expect(v.baseline).toBeNull()
    expect(v.ok).toBe(false)
  })
})

describe('missing', () => {
  test('is a baseline test absent from a selected, error-free file', () => {
    const v = run({
      baseline: baselineOf({ [k(A, 'x')]: 'passed', [k(A, 'gone')]: 'failed', [k(B, 'other')]: 'passed' }),
      results: [file(A, attempt({ [k(A, 'x')]: 'passed' }))],
    })
    expect(v.missing).toEqual([k(A, 'gone')])
    expect(v.ok).toBe(true)
  })

  test('includes every baseline test in a deleted file', () => {
    const v = run({
      baseline: baselineOf({ [k(B, 'p')]: 'passed', [k(B, 'q')]: 'failed', [k(A, 'x')]: 'passed' }),
      deleted: [B],
      results: [file(A, attempt({ [k(A, 'x')]: 'passed' }))],
    })
    expect(v.missing).toEqual([k(B, 'p'), k(B, 'q')])
  })

  test('does not count a skipped result as missing', () => {
    const v = run({
      baseline: baselineOf({ [k(A, 'x')]: 'passed' }),
      results: [file(A, attempt({ [k(A, 'x')]: 'skipped' }))],
    })
    expect(v.missing).toEqual([])
  })

  test('does not cover files that were not selected', () => {
    const v = run({
      baseline: baselineOf({ [k(B, 'other')]: 'passed' }),
      results: [file(A, attempt({ [k(A, 'x')]: 'passed' }))],
    })
    expect(v.missing).toEqual([])
  })

  test('counts a test present in either attempt as present', () => {
    const v = run({
      baseline: baselineOf({ [k(A, 'x')]: 'passed', [k(A, 'y')]: 'passed' }),
      results: [file(A, attempt({ [k(A, 'x')]: 'failed', [k(A, 'y')]: 'passed' }), attempt({ [k(A, 'x')]: 'passed' }))],
    })
    expect(v.missing).toEqual([])
  })
})

describe('incomplete', () => {
  test('lists selected files that have no result and fails the verdict', () => {
    const v = run({
      selection: selectionOf([A, B]),
      results: [file(A, attempt({ [k(A, 'x')]: 'passed' }))],
    })
    expect(v.incomplete).toEqual([B])
    expect(v.ok).toBe(false)
  })

  test('does not count a not-on-CI file, and passes notOnCi through', () => {
    const v = run({
      selection: selectionOf([A, B]),
      notOnCi: [B],
      results: [file(A, attempt({ [k(A, 'x')]: 'passed' }))],
    })
    expect(v.incomplete).toEqual([])
    expect(v.notOnCi).toEqual([B])
    expect(v.ok).toBe(true)
  })

  test('is empty when nothing was selected', () => {
    const v = run({ selection: { mode: 'none', files: [], reasons: [] }, results: [] })
    expect(v.incomplete).toEqual([])
    expect(v.ok).toBe(true)
  })
})

describe('runBroken and passthrough', () => {
  test('a broken run is not ok even with no failures', () => {
    const v = run({ runBroken: true, results: [file(A, attempt({ [k(A, 'x')]: 'passed' }))] })
    expect(v.runBroken).toBe(true)
    expect(v.ok).toBe(false)
  })

  test('known, flaky and fixed alone do not fail the verdict', () => {
    const v = run({
      baseline: baselineOf({ [k(A, 'x')]: 'failed', [k(A, 'y')]: 'failed', [k(A, 'z')]: 'failed' }),
      results: [
        file(
          A,
          attempt({ [k(A, 'x')]: 'failed', [k(A, 'y')]: 'failed', [k(A, 'z')]: 'passed' }),
          attempt({ [k(A, 'x')]: 'failed', [k(A, 'y')]: 'passed' }),
        ),
      ],
    })
    expect(v.known).toEqual([k(A, 'x')])
    expect(v.flaky).toEqual([k(A, 'y')])
    expect(v.fixed).toEqual([k(A, 'z')])
    expect(v.ok).toBe(true)
  })

  test('copies advisory and the selection through', () => {
    const selection = selectionOf([A])
    const v = run({ advisory: true, selection, results: [file(A, attempt({ [k(A, 'x')]: 'passed' }))] })
    expect(v.advisory).toBe(true)
    expect(v.selection).toEqual(selection)
  })
})

describe('output order', () => {
  test('every array is sorted regardless of input order', () => {
    const v = run({
      baseline: baselineOf({
        [k(B, 'm')]: 'passed',
        [k(B, 'n')]: 'passed',
        [k(A, 'a')]: 'failed',
        [k(A, 'b')]: 'failed',
        [k(A, 'gone2')]: 'passed',
        [k(A, 'gone1')]: 'passed',
        [k('pkg/z.test.ts', 'q')]: 'passed',
        [k('pkg/y.test.ts', 'q')]: 'passed',
      }),
      deleted: ['pkg/z.test.ts', 'pkg/y.test.ts'],
      notOnCi: ['pkg/n2.test.ts', 'pkg/n1.test.ts'],
      selection: selectionOf(['pkg/c.test.ts', 'pkg/d.test.ts', A, B]),
      results: [
        file(B, attempt({ [k(B, 'n')]: 'failed', [k(B, 'm')]: 'failed' })),
        file(A, attempt({ [k(A, 'b')]: 'passed', [k(A, 'a')]: 'passed' })),
      ],
    })
    expect(v.new).toEqual([k(B, 'm'), k(B, 'n')])
    expect(v.fixed).toEqual([k(A, 'a'), k(A, 'b')])
    expect(v.missing).toEqual([k(A, 'gone1'), k(A, 'gone2'), k('pkg/y.test.ts', 'q'), k('pkg/z.test.ts', 'q')])
    expect(v.incomplete).toEqual(['pkg/c.test.ts', 'pkg/d.test.ts'])
    expect(v.notOnCi).toEqual(['pkg/n1.test.ts', 'pkg/n2.test.ts'])
  })

  test('does not mutate its input', () => {
    const notOnCi = ['pkg/n2.test.ts', 'pkg/n1.test.ts']
    run({ notOnCi, results: [] })
    expect(notOnCi).toEqual(['pkg/n2.test.ts', 'pkg/n1.test.ts'])
  })
})
