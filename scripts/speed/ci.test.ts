import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BUDGETS, METRICS, type SpeedReport } from './contracts'
import { readSpeedEvidence, runCi } from './ci'

const roots: string[] = []
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'speed-ci-')); roots.push(dir); return dir }
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const sha = (n: number) => n.toString(16).padStart(40, '0')
function report(commit = sha(1), echo = 40): SpeedReport {
  return {
    version: 1, commit, runId: '123', createdAt: '2026-11-12T00:00:00Z', status: 'complete', qualified: true,
    profile: { workloadVersion: 1, worktrees: 10, terminals: 20, diffAddedLines: 5000, renderer: 'dom', viewport: { width: 1400, height: 880 }, startup: 'daemon-restart-persistent-pty-fresh-context', floodChunkBytes: 65536, floodIntervalMs: 16, runner: 'macos-15', os: 'darwin', arch: 'arm64', cpuModel: 'test CPU', cpuCount: 4, bun: '1.4.0', chromium: 'test', imageVersion: 'test' },
    metrics: Object.fromEntries(METRICS.map(metric => [metric, { samplesMs: Array(20).fill(metric === 'echo' ? echo : 10), medianMs: metric === 'echo' ? echo : 10, budgetMs: BUDGETS[metric], budgetMiss: (metric === 'echo' ? echo : 10) > BUDGETS[metric] }])) as SpeedReport['metrics'],
    failures: [], cleanup: 'complete', evidence: { samples: 'samples.jsonl', diagnostics: [], misses: 'misses.json' },
  }
}
function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(['git', ...args], { cwd })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}
function repo() {
  const cwd = temp()
  git(cwd, 'init', '-q', '-b', 'main'); git(cwd, 'config', 'user.name', 'test'); git(cwd, 'config', 'user.email', 'test@example.invalid'); git(cwd, 'config', 'core.hooksPath', '/dev/null'); git(cwd, 'config', 'commit.gpgsign', 'false')
  git(cwd, 'commit', '-qm', 'base', '--allow-empty'); const base = git(cwd, 'rev-parse', 'HEAD')
  git(cwd, 'update-ref', 'refs/remotes/origin/main', base); git(cwd, 'checkout', '-qb', 'feature'); git(cwd, 'commit', '-qm', 'head', '--allow-empty')
  return { cwd, base, head: git(cwd, 'rev-parse', 'HEAD') }
}
function stage(current: SpeedReport) {
  const out = temp(); writeFileSync(join(out, 'report.json'), JSON.stringify(current)); return out
}

test('invalid arguments refuse before consulting GitHub', async () => {
  let calls = 0
  expect(await runCi(['compare', '--event', 'garbage'], { cwd: temp(), env: {}, gh: async () => { calls++; return '' }, err: () => {} })).toBe(2)
  expect(calls).toBe(0)
})

test('absent and malformed evidence are not measured', () => {
  const out = temp()
  expect(readSpeedEvidence(out, sha(1))).toContain('not measured:')
  writeFileSync(join(out, 'report.json'), '{')
  expect(readSpeedEvidence(out, sha(1))).toContain('not measured:')
})

test('a report from another head is not measured', () => {
  expect(readSpeedEvidence(stage(report()), sha(2))).toContain('not measured:')
})

test('complete current without a baseline shows absolute values and not compared', async () => {
  const { cwd, head } = repo(); const out = stage(report(head, 51))
  const code = await runCi(['compare', '--current', join(out, 'report.json'), '--out', out, '--event', 'pull_request', '--head', head], { cwd, env: { GITHUB_REPOSITORY: 'acme/quirky' }, gh: async () => '', err: () => {} })
  expect(code).toBe(0)
  const text = readSpeedEvidence(out, head)
  expect(text).toContain('not compared:'); expect(text).toContain('echo'); expect(text).toContain('MISS')
  expect(readFileSync(join(out, 'summary.md'), 'utf8')).toContain('### Speed')
})

test('GitHub failure is named evidence error, not bootstrap', async () => {
  const { cwd, head } = repo(); const out = stage(report(head))
  const code = await runCi(['compare', '--current', join(out, 'report.json'), '--out', out, '--event', 'pull_request', '--head', head], { cwd, env: { GITHUB_REPOSITORY: 'acme/quirky' }, gh: async () => { throw new Error('API unavailable') }, err: () => {} })
  expect(code).toBe(2)
  expect(readSpeedEvidence(out, head)).toContain('not measured:')
  expect(JSON.parse(readFileSync(join(out, 'comparison.json'), 'utf8')).status).toBe('error')
})

test('shared artifact discovery and download produce strict regression under original head', async () => {
  const { cwd, base, head } = repo(); const out = stage(report(head, 50.001)); const baseline = report(base)
  const calls: string[][] = []
  const gh = async (args: string[]) => {
    calls.push(args)
    if (args.some(arg => arg.includes('/actions/runs/'))) return JSON.stringify({ id: 7, event: 'push', path: '.github/workflows/tests.yml', head_branch: 'main', head_sha: base, repository: { id: 10 }, head_repository: { id: 10 } })
    if (args.some(arg => arg.includes('/actions/artifacts'))) return JSON.stringify({ id: 3, name: `speed-baseline-${base}`, expired: false, created_at: '2026-11-12T00:00:00Z', workflow_run: { id: 7, repository_id: 10, head_repository_id: 10, head_branch: 'main', head_sha: base } })
    throw new Error(`unexpected gh ${args.join(' ')}`)
  }
  const download = async (_args: string[], dest: string) => {
    const source = temp(); writeFileSync(join(source, 'report.json'), JSON.stringify(baseline))
    const zip = Bun.spawnSync(['zip', '-q', dest, 'report.json'], { cwd: source }); expect(zip.exitCode).toBe(0)
  }
  expect(await runCi(['compare', '--current', join(out, 'report.json'), '--out', out, '--event', 'pull_request', '--head', head], { cwd, env: { GITHUB_REPOSITORY: 'acme/quirky' }, gh, download, err: () => {} })).toBe(0)
  const comparison = JSON.parse(readFileSync(join(out, 'comparison.json'), 'utf8'))
  expect(comparison.status).toBe('compared')
  expect(readSpeedEvidence(out, head)).toContain('REGRESSION')
  expect(readSpeedEvidence(out, head)).toContain(base)
  expect(calls.some(args => args.includes('--paginate'))).toBe(true)
  baseline.profile.cpuModel = 'different CPU'
  writeFileSync(join(out, 'baseline.json'), JSON.stringify(baseline))
  expect(readSpeedEvidence(out, head)).toContain('not measured:')
})

test('forged comparison cannot replace recomputed sample arithmetic', () => {
  const out = stage(report(sha(2), 50.001))
  writeFileSync(join(out, 'baseline.json'), JSON.stringify(report(sha(1))))
  writeFileSync(join(out, 'comparison.json'), JSON.stringify({ status: 'compared', head: sha(2), baseline: sha(1), metrics: {} }))
  expect(readSpeedEvidence(out, sha(2))).toContain('not measured:')
})

test('duplicate metric keys cannot become a qualifying imported measurement', () => {
  const value = report()
  const out = stage(value)
  const echo = `"echo":${JSON.stringify(value.metrics.echo)}`
  writeFileSync(join(out, 'report.json'), JSON.stringify(value).replace(echo, `${echo},${echo}`))
  writeFileSync(join(out, 'comparison.json'), JSON.stringify({ status: 'unavailable', head: { commit: value.commit }, baseline: null, reason: 'no baseline' }))
  expect(readSpeedEvidence(out, value.commit)).toContain('not measured:')
})

test('an incompatible nearest main profile falls back to the older compatible ancestor', async () => {
  const { cwd, base } = repo()
  git(cwd, 'checkout', '-q', 'main')
  git(cwd, 'commit', '-qm', 'new main', '--allow-empty')
  const nearest = git(cwd, 'rev-parse', 'HEAD')
  git(cwd, 'update-ref', 'refs/remotes/origin/main', nearest)
  git(cwd, 'checkout', '-qb', 'new-feature')
  git(cwd, 'commit', '-qm', 'new head', '--allow-empty')
  const newHead = git(cwd, 'rev-parse', 'HEAD')
  const out = stage(report(newHead))
  const gh = async (args: string[]) => {
    const endpoint = args.find(arg => arg.includes('/actions/runs/'))
    if (endpoint) {
      const commit = endpoint.endsWith('/8') ? nearest : base
      return JSON.stringify({ id: endpoint.endsWith('/8') ? 8 : 7, event: 'push', path: '.github/workflows/tests.yml', head_branch: 'main', head_sha: commit, repository: { id: 10 }, head_repository: { id: 10 } })
    }
    return [nearest, base].map((commit, i) => JSON.stringify({ id: i + 3, name: `speed-baseline-${commit}`, created_at: '2026-11-12T00:00:00Z', expired: false, workflow_run: { id: i === 0 ? 8 : 7, repository_id: 10, head_repository_id: 10, head_branch: 'main', head_sha: commit } })).join('\n')
  }
  const download = async (args: string[], dest: string) => {
    const isNearest = args.some(arg => arg.includes('/artifacts/3/'))
    const value = report(isNearest ? nearest : base)
    if (isNearest) value.profile.cpuModel = 'incompatible'
    const source = temp()
    writeFileSync(join(source, 'report.json'), JSON.stringify(value))
    expect(Bun.spawnSync(['zip', '-q', dest, 'report.json'], { cwd: source }).exitCode).toBe(0)
  }
  expect(await runCi(['compare', '--current', join(out, 'report.json'), '--out', out, '--event', 'pull_request', '--head', newHead], { cwd, env: { GITHUB_REPOSITORY: 'acme/quirky' }, gh, download, err: () => {} })).toBe(0)
  expect(JSON.parse(readFileSync(join(out, 'baseline.json'), 'utf8')).commit).toBe(base)
  expect(readSpeedEvidence(out, newHead)).not.toContain('not measured:')
})
test('a version-2 report skips the nearest valid legacy baseline without losing medians', async () => {
  const { cwd, base, head } = repo()
  const v1 = report(head, 51)
  const current = {
    ...v1,
    profile: { ...v1.profile, workloadVersion: 2, compositor: 'software' },
  } as unknown as SpeedReport
  const out = stage(current)
  const gh = async (args: string[]) => {
    const endpoint = args.find(arg => arg.includes('/actions/runs/'))
    if (endpoint) {
      return JSON.stringify({ id: 7, event: 'push', path: '.github/workflows/tests.yml', head_branch: 'main', head_sha: base, repository: { id: 10 }, head_repository: { id: 10 } })
    }
    return JSON.stringify({ id: 3, name: `speed-baseline-${base}`, expired: false, created_at: '2026-11-12T00:00:00Z', workflow_run: { id: 7, repository_id: 10, head_repository_id: 10, head_branch: 'main', head_sha: base } })
  }
  const download = async (_args: string[], dest: string) => {
    const source = temp()
    writeFileSync(join(source, 'report.json'), JSON.stringify(report(base)))
    expect(Bun.spawnSync(['zip', '-q', dest, 'report.json'], { cwd: source }).exitCode).toBe(0)
  }

  const code = await runCi(['compare', '--current', join(out, 'report.json'), '--out', out, '--event', 'pull_request', '--head', head], {
    cwd, env: { GITHUB_REPOSITORY: 'acme/quirky' }, gh, download, err: () => {},
  })
  const comparison = JSON.parse(readFileSync(join(out, 'comparison.json'), 'utf8'))
  const summary = readFileSync(join(out, 'summary.md'), 'utf8')
  expect(code).toBe(0)
  expect(comparison.status).toBe('unavailable')
  expect(comparison.reason).toBe('no qualifying compatible main baseline in the first 500 ancestors')
  expect(summary).toContain('not compared: no qualifying compatible main baseline in the first 500 ancestors')
  for (const metric of METRICS) expect(summary).toContain(`| ${metric} | ${metric === 'echo' ? 51 : 10} | 20 |`)
  expect(summary).not.toContain('not measured:')
  expect(readSpeedEvidence(out, head)).not.toContain('not measured:')
})

test('runCi carries a report-correlated miss from an external current directory through the Tests evidence reader', async () => {
  const { cwd, head } = repo()
  const current = report(head, 51)
  current.evidence.diagnostics = ['diagnostics/echo.json']
  const input = stage(current)
  const out = temp()
  const finding = 'Observed echo acknowledgement delay in the diagnostic trial.'
  const misses = [{
    metric: 'echo',
    budgetMs: BUDGETS.echo,
    medianMs: 51,
    commit: current.commit,
    runId: current.runId,
    samples: current.evidence.samples,
    diagnostics: ['diagnostics/echo.json'],
    finding,
  }]
  writeFileSync(join(input, 'misses.json'), JSON.stringify(misses))

  expect(await runCi(['compare', '--current', join(input, 'report.json'), '--out', out, '--event', 'pull_request', '--head', head], {
    cwd, env: { GITHUB_REPOSITORY: 'acme/quirky' }, gh: async () => '', err: () => {},
  })).toBe(0)
  expect(JSON.parse(readFileSync(join(out, 'misses.json'), 'utf8'))).toEqual(misses)
  expect(readFileSync(join(out, 'summary.md'), 'utf8')).toContain(finding)
  expect(readSpeedEvidence(out, head)).toContain(finding)
})

test('missing, malformed, and report-mismatched misses use report-derived unavailable diagnoses', async () => {
  for (const evidence of ['missing', 'malformed', 'mismatched']) {
    const { cwd, head } = repo()
    const current = report(head, 51)
    current.evidence.diagnostics = ['diagnostics/echo.json']
    const input = stage(current)
    const out = temp()
    const forged = 'FORGED finding must not be rendered.'
    if (evidence === 'malformed') writeFileSync(join(input, 'misses.json'), '{')
    if (evidence === 'mismatched') writeFileSync(join(input, 'misses.json'), JSON.stringify([{
      metric: 'echo', budgetMs: BUDGETS.echo, medianMs: 51, commit: sha(2), runId: current.runId,
      samples: current.evidence.samples, diagnostics: ['diagnostics/echo.json'], finding: forged,
    }]))

    expect(await runCi(['compare', '--current', join(input, 'report.json'), '--out', out, '--event', 'pull_request', '--head', head], {
      cwd, env: { GITHUB_REPOSITORY: 'acme/quirky' }, gh: async () => '', err: () => {},
    })).toBe(0)
    const summary = readFileSync(join(out, 'summary.md'), 'utf8')
    expect(summary).toContain('not compared:')
    expect(summary).toContain('Diagnosis unavailable')
    expect(summary).not.toContain(forged)
  }
})
