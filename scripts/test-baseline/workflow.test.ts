import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

type Step = { id?: string; name?: string; uses?: string; run?: string; if?: string | boolean; with?: Record<string, unknown>; env?: Record<string, string> }
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

const JOBS_OK = "${{ needs.plan.result != 'failure' && needs.plan.result != 'cancelled' && needs.linux.result != 'failure' && needs.linux.result != 'cancelled' && needs.macos.result != 'failure' && needs.macos.result != 'cancelled' }}"

describe('tests.yml triggers and defaults', () => {
  test('runs on pull requests, pushes to main and manual dispatch', () => {
    expect(Object.keys(workflow.on).sort()).toEqual(['pull_request', 'push', 'workflow_dispatch'])
    expect((workflow.on.push as { branches: string[] }).branches).toEqual(['main'])
  })

  test('a pull request reruns when labelled, and full-suite asks the plan for every test', () => {
    expect((workflow.on.pull_request as { types: string[] }).types).toEqual(['opened', 'synchronize', 'reopened', 'labeled'])
    const plan = steps('plan').find(step => step.name === 'Plan the run')!
    expect(plan.env?.FULL_SUITE).toBe("${{ contains(github.event.pull_request.labels.*.name, 'full-suite') }}")
    expect(plan.run).toContain('--full "$FULL_SUITE"')
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
  test('defines the unit jobs and independent speed evidence job', () => {
    expect(Object.keys(jobs).sort()).toEqual(['linux', 'macos', 'plan', 'speed', 'tests'])
  })

  test('needs match the job table', () => {
    expect(needsOf('plan')).toEqual([])
    expect(needsOf('linux')).toEqual(['plan'])
    expect(needsOf('macos')).toEqual(['plan'])
    expect([...needsOf('tests')].sort()).toEqual(['linux', 'macos', 'plan', 'speed'])
    expect(needsOf('speed')).toEqual([])
  })

  test('the Tests job is named Tests and always runs', () => {
    expect(jobs.tests!.name).toBe('Tests')
    expect(jobs.tests!.if).toBe('always()')
  })

  test('test jobs skip when the plan selects nothing for them', () => {
    expect(String(jobs.linux!.if)).toContain("needs.plan.outputs.linux_shards != '[]'")
    expect(String(jobs.macos!.if)).toContain("needs.plan.outputs.has_macos == 'true'")
  })

  test('every test job reruns its own failures, so no job waits on all the shards to rerun them', () => {
    for (const name of ['linux', 'macos']) {
      const shard = runs(name).filter(script => script.includes('cli.ts run-shard'))
      expect(shard).toHaveLength(1)
    }
    expect(allRuns.filter(script => /cli\.ts rerun\b/.test(script))).toEqual([])
  })

  test('linux shards install their test tools from a cache keyed on the runner image', () => {
    const cache = steps('linux').find(step => step.uses?.startsWith('actions/cache@'))!
    const name = steps('linux').find(step => step.id === 'tools')!
    expect(name.run).toContain('$ImageOS-$ImageVersion')
    expect(cache.with?.key).toBe('${{ steps.tools.outputs.key }}')
    const install = steps('linux').find(step => step.name === 'Install test tools')!
    expect(steps('linux').indexOf(install)).toBeGreaterThan(steps('linux').indexOf(cache))
    expect(install.run).toContain('apt-get install -y --download-only zsh ripgrep')
    expect(install.run).toContain('dpkg -i')
  })
})

describe('token scope', () => {
  test('no write permission on plan, linux or macos', () => {
    for (const name of ['plan', 'linux', 'macos', 'speed']) {
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
    expect(verdict.env?.JOBS_OK).toBe(JOBS_OK)
    expect(verdict.run).toContain('--jobs-ok "$JOBS_OK" --speed speed')
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

  test('files and closes issues from the baseline on push only', () => {
    const open = steps('tests').find(step => step.run?.includes('cli.ts issues') && step.run.includes('--only open'))!
    const close = steps('tests').find(step => step.run?.includes('cli.ts issues') && step.run.includes('--only close'))!
    expect(open.run).toContain('--plan plan --baseline out/baseline.json')
    expect(close.run).toContain('--plan plan --baseline out/baseline.json')
    for (const step of [open, close]) {
      expect(String(step.if)).toContain("github.event_name == 'push'")
      expect(String(step.if)).toContain("hashFiles('out/baseline.json') != ''")
    }
  })

  test('opens issues, then publishes the baseline, then closes issues, with the fail step last', () => {
    const list = steps('tests')
    const open = list.findIndex(step => step.run?.includes('cli.ts issues') && step.run.includes('--only open'))
    const upload = list.findIndex(step => String(step.with?.name).startsWith('test-baseline-'))
    const close = list.findIndex(step => step.run?.includes('cli.ts issues') && step.run.includes('--only close'))
    expect(open).toBeGreaterThanOrEqual(0)
    expect(upload).toBeGreaterThan(open)
    expect(close).toBeGreaterThan(upload)
    expect(list.findIndex(step => String(step.if).includes('outcome'))).toBe(list.length - 1)
    expect(list.length - 1).toBeGreaterThan(close)

    for (const index of [open, upload, close]) {
      expect(String(list[index]!.if)).not.toMatch(/\b(always|failure|cancelled|success)\(\)/)
      expect((list[index] as Step & { 'continue-on-error'?: boolean })['continue-on-error']).toBeUndefined()
    }
    expect(list.filter(step => step.run?.includes('cli.ts issues'))).toHaveLength(2)
  })

  test('workflow_dispatch never publishes a baseline, files issues or closes them', () => {
    const gated = steps('tests').filter(
      step => String(step.with?.name).startsWith('test-baseline-') || step.run?.includes('cli.ts issues'),
    )
    expect(gated).toHaveLength(3)
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
    expect(named('tests')).toEqual(['test-baseline-${{ github.sha }}'])
    expect(named('speed')).toEqual(['speed-run', 'speed-baseline-${{ github.sha }}'])
  })

  test('everything but the baseline keeps one day', () => {
    for (const { step } of uploads) {
      const retained = /^(test-baseline-|speed-)/.test(String(step.with?.name))
      expect(step.with?.['retention-days']).toBe(retained ? 14 : 1)
    }
  })
})

describe('speed evidence', () => {
  test('runs the guarded timer experiment before both browser measurements with shared evidence outside smoke output', () => {
    const speed = steps('speed')
    const isolate = speed.find(step => step.name === 'Isolate speed checks')!
    const configure = speed.find(step => step.name === 'Configure runner latency experiment')
    expect(configure).toBeDefined()
    expect(isolate.run).toContain('echo "QUIRKY_SPEED_RUNNER_LATENCY=$RUNNER_TEMP/speed-runner-latency.json" >> "$GITHUB_ENV"')
    expect(configure!.run).toBe('bun scripts/speed/runner-latency.ts --configure --out "$QUIRKY_SPEED_RUNNER_LATENCY"')
    expect(speed.indexOf(isolate)).toBeLessThan(speed.indexOf(configure!))
    for (const name of ['Check real-daemon smoke', 'Measure speed']) {
      expect(speed.indexOf(configure!)).toBeLessThan(speed.findIndex(step => step.name === name))
    }
    expect(allRuns.filter(run => run.includes('runner-latency.ts --configure'))).toHaveLength(1)
    expect(configure!.run).not.toContain('sudo')
    expect(configure!.run).not.toContain('defaults write')
  })

  test('compares a prepared base on the same runner after the solo benchmark', () => {
    expect(jobs.speed).toMatchObject({ 'runs-on': 'macos-15', 'timeout-minutes': 60 })
    expect(jobs.speed!.if).toBeUndefined()
    const headInstall = steps('speed').find(step => step.run === 'bun install --frozen-lockfile')
    expect(headInstall).toBeDefined()
    expect(steps('speed').indexOf(headInstall!)).toBeLessThan(steps('speed').findIndex(step => step.name === 'Check real-daemon smoke'))
    const prepare = steps('speed').find(step => step.name === 'Prepare speed base')!
    expect((prepare as Step & { 'continue-on-error'?: boolean })['continue-on-error']).toBe(true)
    expect(prepare.env).toEqual({
      EVENT_NAME: '${{ github.event_name }}',
      HEAD_SHA: '${{ github.event.pull_request.head.sha || github.sha }}',
    })
    expect(prepare.run).toContain('if [ "$EVENT_NAME" = "pull_request" ]')
    expect(prepare.run).toContain('git merge-base "$HEAD_SHA" origin/main')
    expect(prepare.run).toContain('git rev-parse "$HEAD_SHA^"')
    expect(prepare.run).toContain('git worktree add --detach "$RUNNER_TEMP/speed-base" "$BASE_SHA"')
    expect(prepare.run).toContain('(cd "$RUNNER_TEMP/speed-base" && bun install --frozen-lockfile)')
    expect(prepare.run!.indexOf('git worktree add')).toBeLessThan(prepare.run!.indexOf('bun install --frozen-lockfile'))
    expect(prepare.run!.indexOf('bun install --frozen-lockfile')).toBeLessThan(prepare.run!.indexOf('>> "$GITHUB_ENV"'))

    const measure = steps('speed').find(step => step.name === 'Measure speed')!
    expect(measure.run).toContain('measure_args=(--out speed --samples 20)')
    expect(measure.run).toContain('if [ -n "${SPEED_BASE_ROOT:-}" ]')
    expect(measure.run).toContain('measure_args+=(--base-root "$SPEED_BASE_ROOT" --base-basis "$SPEED_BASE_BASIS")')
    expect(measure.run).toContain('bun scripts/speed.ts "${measure_args[@]}"')
    expect(steps('speed').indexOf(prepare)).toBeLessThan(steps('speed').indexOf(measure))

    const commands = runs('speed').join('\n')
    expect(commands).toContain('QUIRKY_SPEED_IMAGE_VERSION=')
    expect(commands).toContain('bun node_modules/playwright/cli.js install chromium')
    expect(commands).toContain('bun test scripts/speed/run.e2e.test.ts')
    expect(commands.indexOf('bun test scripts/speed/run.e2e.test.ts')).toBeLessThan(commands.indexOf('bun scripts/speed.ts'))
    expect(commands).not.toContain('run-shard')
    expect(effectivePermissions('speed')).toEqual({ contents: 'read' })
  })

  test('compares local paired evidence without a GitHub token', () => {
    const compare = steps('speed').find(step => step.name === 'Compare speed')!
    expect(compare.run).toBe('bun scripts/speed/ci.ts compare --current speed/report.json --pair speed/pair.json --out speed --head "$HEAD_SHA"')
    expect(compare.env).toEqual({ HEAD_SHA: '${{ github.event.pull_request.head.sha || github.sha }}' })
    expect(compare.env).not.toHaveProperty('GH_TOKEN')
  })

  test('always retains partial evidence and publishes only qualified main evidence', () => {
    const evidence = steps('speed').find(step => step.with?.name === 'speed-run')!
    expect(evidence.if).toBe('always()')
    const baseline = steps('speed').find(step => String(step.with?.name).startsWith('speed-baseline-'))!
    expect(String(baseline.if)).toContain("github.event_name == 'push'")
    expect(String(baseline.if)).toContain("steps.qualify.outputs.qualified == 'true'")
    expect(baseline.with?.path).toBe('speed/report.json')
    const qualify = steps('speed').find(step => step.id === 'qualify')!
    expect(qualify.run).toContain('validateReport')
    expect(qualify.run).toContain('parseArtifactJson')
    expect(qualify.run).not.toContain('.json()')
    expect(qualify.run).toContain('qualified')
  })

  test('keeps speed downloads advisory and outside unit results, with main summaries', () => {
    const download = steps('tests').find(step => step.with?.pattern === 'speed-run')!
    expect(download.with?.path).toBe('speed')
    expect(download.if).toBe('always()')
    expect(steps('tests').find(step => step.id === 'verdict')?.if).toBe('always()')
    expect(steps('tests').find(step => step.name === 'Ensure a comment exists')?.run).toContain('### Speed')
    expect((download as Step & { 'continue-on-error'?: boolean })['continue-on-error']).toBe(true)
    const summary = steps('tests').find(step => step.run?.includes('cat out/comment.md'))!
    expect(summary.if).toBe('always()')
    expect(steps('speed').some(step => step.run?.includes('scripts/speed/ci.ts compare'))).toBe(true)
    expect(allRuns.filter(script => script.includes('gh api --method POST'))).toHaveLength(1)
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
