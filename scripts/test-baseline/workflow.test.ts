import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

type Step = { name?: string; uses?: string; run?: string; if?: string | boolean; with?: Record<string, unknown>; env?: Record<string, string> }
type Job = {
  name?: string
  if?: string | boolean
  needs?: string | string[]
  permissions?: Record<string, string>
  steps?: Step[]
}
type Workflow = {
  on: Record<string, unknown>
  concurrency: { group: string; 'cancel-in-progress': string | boolean }
  permissions?: Record<string, string>
  jobs: Record<string, Job>
}

const path = join(import.meta.dir, '../../.github/workflows/tests.yml')
const source = await Bun.file(path).text()
const workflow = Bun.YAML.parse(source) as Workflow

const jobs = workflow.jobs
const steps = (name: string): Step[] => jobs[name]!.steps ?? []
const runs = (name: string): string[] => steps(name).flatMap(step => (step.run ? [step.run] : []))
const allRuns = Object.keys(jobs).flatMap(runs)
const needsOf = (name: string): string[] => [jobs[name]!.needs ?? []].flat()
const effectivePermissions = (name: string): Record<string, string> => jobs[name]!.permissions ?? workflow.permissions ?? {}
const norm = (expr: unknown): string => String(expr).replace(/\$\{\{|\}\}/g, '').replace(/\s+/g, ' ').trim()

const JOBS_OK = "${{ !contains(needs.*.result, 'failure') && !contains(needs.*.result, 'cancelled') }}"

describe('tests.yml triggers and defaults', () => {
  test('runs on pull requests, pushes to main and manual dispatch', () => {
    expect(Object.keys(workflow.on).sort()).toEqual(['pull_request', 'push', 'workflow_dispatch'])
    expect((workflow.on.push as { branches: string[] }).branches).toEqual(['main'])
  })

  test('cancels superseded runs on pull requests only', () => {
    expect(workflow.concurrency.group).toBe('tests-${{ github.ref }}')
    expect(norm(workflow.concurrency['cancel-in-progress'])).toBe("github.event_name == 'pull_request'")
  })

  test('defaults the token to read-only contents', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' })
  })

  test('never uses pull_request_target', () => {
    expect(source).not.toContain('pull_request_target')
  })
})

describe('job graph', () => {
  test('defines exactly the five jobs', () => {
    expect(Object.keys(jobs).sort()).toEqual(['linux', 'macos', 'plan', 'rerun', 'tests'])
  })

  test('needs match the job table', () => {
    expect(needsOf('plan')).toEqual([])
    expect(needsOf('linux')).toEqual(['plan'])
    expect(needsOf('macos')).toEqual(['plan'])
    expect([...needsOf('rerun')].sort()).toEqual(['linux', 'plan'])
    expect([...needsOf('tests')].sort()).toEqual(['linux', 'macos', 'plan', 'rerun'])
  })

  test('the Tests job is named Tests and always runs', () => {
    expect(jobs.tests!.name).toBe('Tests')
    expect(jobs.tests!.if).toBe('always()')
  })

  test('test jobs skip when the plan selects nothing for them', () => {
    expect(String(jobs.linux!.if)).toContain("needs.plan.outputs.linux_shards != '[]'")
    expect(String(jobs.macos!.if)).toContain("needs.plan.outputs.has_macos == 'true'")
    expect(String(jobs.rerun!.if)).toContain("needs.plan.outputs.linux_shards != '[]'")
    expect(String(jobs.rerun!.if)).toContain("!contains(needs.*.result, 'cancelled')")
  })
})

describe('token scope', () => {
  test('no write permission on plan, linux, macos or rerun', () => {
    for (const name of ['plan', 'linux', 'macos', 'rerun']) {
      expect(Object.values(effectivePermissions(name)).filter(level => level === 'write')).toEqual([])
    }
  })

  test('plan adds only actions: read', () => {
    expect(effectivePermissions('plan')).toEqual({ contents: 'read', actions: 'read' })
  })

  test('only the Tests job writes, and only to pull requests and issues', () => {
    const writes = Object.entries(effectivePermissions('tests')).filter(([, level]) => level === 'write')
    expect(writes.map(([scope]) => scope).sort()).toEqual(['issues', 'pull-requests'])
  })

  test('linux and macos run test code with a 30 minute limit and no fail-fast', () => {
    for (const name of ['linux', 'macos']) {
      const job = jobs[name] as Job & { 'timeout-minutes'?: number; strategy?: { 'fail-fast'?: boolean } }
      expect(job['timeout-minutes']).toBe(30)
    }
    const linux = jobs.linux as Job & { strategy: { 'fail-fast': boolean; matrix: { shard: string } } }
    expect(linux.strategy['fail-fast']).toBe(false)
    expect(linux.strategy.matrix.shard).toBe('${{ fromJSON(needs.plan.outputs.linux_shards) }}')
  })

  test('no run script interpolates anything but the jobs-ok expression', () => {
    for (const script of allRuns) {
      const expressions = script.match(/\$\{\{[^}]*\}\}/g) ?? []
      expect(expressions.filter(expression => expression !== JOBS_OK)).toEqual([])
    }
  })
})

describe('the Tests job', () => {
  test('never installs dependencies', () => {
    for (const script of runs('tests')) expect(script).not.toMatch(/\bbun\s+(install|i)\b/)
  })

  test('passes the jobs-ok expression to verdict and keeps its exit code for last', () => {
    const verdict = steps('tests').find(step => step.run?.includes('cli.ts verdict'))!
    expect(verdict.run).toContain(`--jobs-ok ${JOBS_OK}`)
    expect((verdict as Step & { 'continue-on-error'?: boolean })['continue-on-error']).toBe(true)

    const verdictIndex = steps('tests').indexOf(verdict)
    const failStep = steps('tests').findIndex(step => String(step.if).includes('outcome'))
    expect(failStep).toBeGreaterThan(verdictIndex)
    expect(failStep).toBe(steps('tests').length - 1)
    expect(steps('tests')[failStep]!.run).toContain('exit 1')
  })

  test('tolerates a missing plan or results artifact', () => {
    const downloads = steps('tests').filter(step => step.uses?.startsWith('actions/download-artifact@'))
    expect(downloads.length).toBeGreaterThanOrEqual(2)
    for (const download of downloads) expect(download.with).toHaveProperty('pattern')
    expect(runs('tests').join('\n')).toContain('mkdir -p plan')
  })

  test('publishes the baseline by sha, 14 days, on push only', () => {
    const upload = steps('tests').find(step => step.uses?.startsWith('actions/upload-artifact@') && String(step.with?.name).startsWith('test-baseline-'))!
    expect(upload.with!.name).toBe('test-baseline-${{ github.sha }}')
    expect(upload.with!['retention-days']).toBe(14)
    expect(String(upload.if)).toContain("github.event_name == 'push'")
    expect(String(upload.if)).toContain("hashFiles('out/baseline.json') != ''")
  })

  test('files issues from the baseline on push only', () => {
    const issues = steps('tests').find(step => step.run?.includes('cli.ts issues'))!
    expect(issues.run).toContain('--plan plan --baseline out/baseline.json')
    expect(String(issues.if)).toContain("github.event_name == 'push'")
  })

  test('workflow_dispatch never publishes a baseline or files issues', () => {
    const gated = steps('tests').filter(
      step => String(step.with?.name).startsWith('test-baseline-') || step.run?.includes('cli.ts issues'),
    )
    expect(gated).toHaveLength(2)
    for (const step of gated) expect(String(step.if)).not.toContain('workflow_dispatch')
  })

  test('reports on pull requests through the step summary and one marked comment', () => {
    const script = runs('tests').join('\n')
    expect(script).toContain('$GITHUB_STEP_SUMMARY')
    expect(script).toContain('<!-- test-baseline-verdict -->')
    const comment = steps('tests').find(step => step.run?.includes('gh api'))!
    expect(String(comment.if)).toContain("github.event_name == 'pull_request'")
  })
})

describe('artifacts', () => {
  const uploads = Object.keys(jobs).flatMap(name =>
    steps(name).filter(step => step.uses?.startsWith('actions/upload-artifact@')).map(step => ({ job: name, step })),
  )

  test('each job writes the artifact the table names', () => {
    const named = (job: string) => uploads.filter(upload => upload.job === job).map(upload => String(upload.step.with?.name))
    expect(named('plan')).toEqual(['test-plan'])
    expect(named('linux')).toEqual(['test-results-linux-${{ matrix.shard }}'])
    expect(named('macos')).toEqual(['test-results-macos'])
    expect(named('rerun')).toEqual(['test-results-rerun'])
    expect(named('tests')).toEqual(['test-baseline-${{ github.sha }}'])
  })

  test('everything but the baseline keeps one day', () => {
    for (const { step } of uploads) {
      const baseline = String(step.with?.name).startsWith('test-baseline-')
      expect(step.with?.['retention-days']).toBe(baseline ? 14 : 1)
    }
  })
})

describe('bun flags the design rejects', () => {
  test('no run step uses --parallel, --isolate, --shard, --timings or --changed', () => {
    for (const raw of allRuns) {
      // run-shard's own --shard picks a plan shard; Bun's flag of that name is what's banned
      const script = raw.replace(/(cli\.ts run-shard[^\n]*?)--shard\b/g, '$1')
      for (const flag of ['--parallel', '--isolate', '--shard', '--timings', '--changed']) {
        expect(script).not.toMatch(new RegExp(`${flag}(?![\\w-])`))
      }
    }
  })
})
