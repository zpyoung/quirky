import { expect, test } from 'bun:test'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseFeatureTable, REQUIRED_FEATURE_IDS, type FeatureTableExport } from './feature-table'

const repositoryRoot = resolve(import.meta.dir, '../..')
const featureTablePath = join(repositoryRoot, 'docs/parity/orca-features.md')
const requiredFixtureIds = ['c', 'g', 'x', 'd']
const fixtureCheck = "`bun test fixtures/check.test.ts` title: `keeps state`"

function fixtureTable(check = fixtureCheck, excludedReason = 'BRIEF drops dictation'): string {
  return [
    '| ID | Orca feature / provenance | Quirky equivalent | Check | Disposition / reason |',
    '| --- | --- | --- | --- | --- |',
    `| c | fixture covered behavior | fixture API | ${check} — asserts a retained state value | covered: fixture behavior |`,
    '| g | fixture gap | no equivalent | none | gap: Missing reference search |',
    `| x | fixture exclusion | none | none | excluded: ${excludedReason} |`,
    '| d | fixture delegation | goal-owned | none | delegated: Goal 10 owns browser parity |'
  ].join('\n')
}

function fixtureRoot(files: Record<string, string> = { 'fixtures/check.test.ts': "import { expect, test } from 'bun:test'\ntest('keeps state', () => expect(1).toBe(1))\n" }): string {
  const root = mkdtempSync(join(tmpdir(), 'quirky-feature-table-fixture-'))
  for (const [path, content] of Object.entries(files)) {
    const destination = join(root, path)
    mkdirSync(join(destination, '..'), { recursive: true })
    writeFileSync(destination, content)
  }
  return root
}

function parseFixture(root: string, markdown = fixtureTable(), notOnCi = '# intentionally empty\n\n'): FeatureTableExport {
  return parseFeatureTable(markdown, root, notOnCi, requiredFixtureIds)
}

function fixtureRow(result: FeatureTableExport, id: string): FeatureTableExport['rows'][number] {
  const row = result.rows.find((candidate) => candidate.id === id)
  if (!row) throw new Error(`missing exported fixture row ${id}`)
  return row
}

function invokeCli(args: string[], options: { script?: string; cwd?: string } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'quirky-feature-table-home-'))
  try {
    const child = Bun.spawnSync([process.execPath, options.script ?? join(import.meta.dir, 'feature-table.ts'), ...args], {
      cwd: options.cwd ?? repositoryRoot,
      env: {
        PATH: '/usr/bin:/bin',
        HOME: home,
        QUIRKY_HOME: home,
        TMPDIR: home,
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0'
      },
      stdout: 'pipe',
      stderr: 'pipe'
    })
    return {
      exitCode: child.exitCode,
      stdout: child.stdout.toString(),
      stderr: child.stderr.toString(),
      homeContents: readdirSync(home)
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

test('feature table exports the complete required inventory in document order with behavioral evidence', () => {
  const markdown = readFileSync(featureTablePath, 'utf8')
  const notOnCi = readFileSync(join(repositoryRoot, 'scripts/test-not-on-ci.txt'), 'utf8')
  const result = parseFeatureTable(markdown, repositoryRoot, notOnCi)

  expect(result.errors).toEqual([])
  expect(result.rows.map((row) => row.id)).toEqual(REQUIRED_FEATURE_IDS)
  expect(new Set(result.rows.map((row) => row.id)).size).toBe(REQUIRED_FEATURE_IDS.length)

  for (const row of result.rows) {
    if (row.disposition === 'covered') {
      expect(row.checks.length, row.id).toBeGreaterThan(0)
      for (const check of row.checks) {
        expect(existsSync(join(repositoryRoot, check.file)), `${row.id}: ${check.file}`).toBe(true)
      }
    }
  }

  for (const row of result.rows) {
    if (row.disposition === 'excluded') expect(row.reason).toMatch(/BRIEF|OWNER|Decision/i)
    if (row.disposition === 'delegated') expect(row.reason).toMatch(/Goal\s+\d+|g\d+-\d+/i)
  }

  expect(result.rows.find((row) => row.id === 'linked-references')).toMatchObject({ disposition: 'gap' })
  expect(fixtureRow(result, 'linked-references').reason).toMatch(/cross-workspace discovery|absent removal/i)
})

test('fixture export has the exact four-row schema and preserves every check', () => {
  const root = fixtureRoot()
  try {
    expect(parseFixture(root)).toEqual({
      schemaVersion: 1,
      rows: [
        { id: 'c', disposition: 'covered', checks: [{ file: 'fixtures/check.test.ts', testTitle: 'keeps state' }], reason: null },
        { id: 'g', disposition: 'gap', checks: [], reason: 'Missing reference search' },
        { id: 'x', disposition: 'excluded', checks: [], reason: 'BRIEF drops dictation' },
        { id: 'd', disposition: 'delegated', checks: [], reason: 'Goal 10 owns browser parity' }
      ],
      errors: []
    })

    const multi = fixtureTable(
      `${fixtureCheck}; \`bun test fixtures/second.test.ts\` title: \`records state\``
    )
    const withSecond = fixtureRoot({
      'fixtures/check.test.ts': "import { expect, test } from 'bun:test'\ntest('keeps state', () => expect(1).toBe(1))\n",
      'fixtures/second.test.ts': "import { expect, test } from 'bun:test'\ntest('records state', () => expect(2).toBe(2))\n"
    })
    try {
      expect(fixtureRow(parseFixture(withSecond, multi), 'c').checks).toEqual([
        { file: 'fixtures/check.test.ts', testTitle: 'keeps state' },
        { file: 'fixtures/second.test.ts', testTitle: 'records state' }
      ])
    } finally {
      rmSync(withSecond, { recursive: true, force: true })
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('omitting a check title exports a null title', () => {
  const root = fixtureRoot()
  try {
    const result = parseFixture(root, fixtureTable('`bun test fixtures/check.test.ts` — asserts a retained state value'))
    expect(fixtureRow(result, 'c').checks).toEqual([{ file: 'fixtures/check.test.ts', testTitle: null }])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the validator never executes a Markdown check command', () => {
  const root = fixtureRoot()
  const sentinel = join(root, 'command-ran')
  writeFileSync(
    join(root, 'fixtures/check.test.ts'),
    `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(sentinel)}, 'ran')\n`
  )
  try {
    expect(parseFixture(root).errors).toEqual([])
    expect(existsSync(sentinel)).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})


test('validator reports a missing required feature ID', () => {
  const root = fixtureRoot()
  try {
    const result = parseFixture(root, fixtureTable().replace('| d | fixture delegation | goal-owned | none | delegated: Goal 10 owns browser parity |', ''))
    expect(result).toEqual({
      schemaVersion: 1,
      rows: [],
      errors: [{ code: 'missing-feature', rowId: 'd', file: null }]
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('validator reports duplicate feature IDs', () => {
  const root = fixtureRoot()
  try {
    const duplicate = '| c | duplicate fixture | fixture API | none | excluded: duplicate |'
    const result = parseFixture(root, `${fixtureTable()}\n${duplicate}`)
    expect(result.rows).toEqual([])
    expect(result.errors).toContainEqual({ code: 'duplicate-feature', rowId: 'c', file: null })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('validator reports a missing non-covered reason', () => {
  const root = fixtureRoot()
  try {
    const result = parseFixture(root, fixtureTable(fixtureCheck, ''))
    expect(result.rows).toEqual([])
    expect(result.errors).toContainEqual({ code: 'missing-reason', rowId: 'x', file: null })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('validator rejects a nonexistent covered check path', () => {
  const root = fixtureRoot()
  try {
    const missing = '`bun test fixtures/missing.test.ts` title: `keeps state`'
    const result = parseFixture(root, fixtureTable(missing))
    expect(result).toEqual({
      schemaVersion: 1,
      rows: [],
      errors: [{ code: 'missing-check', rowId: 'c', file: 'fixtures/missing.test.ts' }]
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('validator rejects extra command arguments and non-repository-relative check paths', () => {
  const root = fixtureRoot()
  try {
    for (const check of [
      '`bun test fixtures/check.test.ts --watch`',
      '`bun test ../fixtures/check.test.ts`',
      'bun test fixtures/check.test.ts'
    ]) {
      const result = parseFixture(root, fixtureTable(check))
      expect(result.rows).toEqual([])
      expect(result.errors).toContainEqual({ code: 'invalid-check', rowId: 'c', file: null })
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('not-on-CI exclusions use the first path word, ignoring comments and blank lines', () => {
  const root = fixtureRoot()
  try {
    const excluded = parseFixture(root, fixtureTable(), '# heading\n\nfixtures/check.test.ts  runner limitation\n')
    expect(excluded).toEqual({
      schemaVersion: 1,
      rows: [],
      errors: [{ code: 'check-not-on-ci', rowId: 'c', file: 'fixtures/check.test.ts' }]
    })

    mkdirSync(join(root, 'scripts'), { recursive: true })
    writeFileSync(join(root, 'scripts/test-on-macos.txt'), 'fixtures/check.test.ts  macOS-only runner\n')
    expect(parseFixture(root, fixtureTable(), '# no not-on-CI entries\n\n').errors).toEqual([])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the real CLI reads its fixed inventory and emits one JSON document without running checks', () => {
  const result = invokeCli(['--json'], { cwd: tmpdir() })
  expect(result.exitCode).toBe(0)
  expect(result.stderr).toBe('')
  expect(result.homeContents).toEqual([])
  const exported = JSON.parse(result.stdout) as FeatureTableExport
  expect(result.stdout).toBe(`${JSON.stringify(exported)}\n`)
  expect(exported.schemaVersion).toBe(1)
  expect(exported.errors).toEqual([])
  expect(exported.rows.map((row) => row.id)).toEqual(REQUIRED_FEATURE_IDS)
})

test('the real CLI accepts only help or JSON and exits with the documented codes', () => {
  const help = invokeCli(['--help'])
  expect(help.exitCode).toBe(0)
  expect(help.stdout).toContain('Usage: bun scripts/parity/feature-table.ts [--json | --help]')
  expect(help.stderr).toBe('')
  expect(help.homeContents).toEqual([])

  const invalid = invokeCli(['--table', '/tmp/arbitrary.md'])
  expect(invalid.exitCode).toBe(2)
  expect(invalid.stdout).toBe('')
  expect(invalid.stderr).toContain('Usage: bun scripts/parity/feature-table.ts [--json | --help]')
  expect(invalid.homeContents).toEqual([])
})

test('the real CLI reports invalid fixed-path inventory with exit 1 and no partial rows', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'quirky-feature-table-invalid-cli-'))
  const script = join(temporary, 'scripts/parity/feature-table.ts')
  mkdirSync(join(temporary, 'scripts/parity'), { recursive: true })
  mkdirSync(join(temporary, 'docs/parity'), { recursive: true })
  copyFileSync(join(import.meta.dir, 'feature-table.ts'), script)
  writeFileSync(join(temporary, 'docs/parity/orca-features.md'), '| ID | Orca feature / provenance | Quirky equivalent | Check | Disposition / reason |\n| --- | --- | --- | --- | --- |\n')
  writeFileSync(join(temporary, 'scripts/test-not-on-ci.txt'), '# no exclusions\n')
  try {
    const result = invokeCli(['--json'], { script, cwd: temporary })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toBe('')
    expect(result.homeContents).toEqual([])
    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: 1,
      rows: [],
      errors: REQUIRED_FEATURE_IDS.map((id) => ({ code: 'missing-feature', rowId: id, file: null }))
    })
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
})

