import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

type Step = {
  name?: string
  uses?: string
  if?: string | boolean
  run?: string
  env?: Record<string, string>
  with?: Record<string, unknown>
}
type Workflow = {
  on: {
    schedule: { cron: string }[]
    workflow_dispatch: { inputs: Record<string, { default: string }> }
    pull_request: { paths: string[] }
  }
  jobs: Record<string, { 'timeout-minutes': number; steps: Step[] }>
}

const path = join(import.meta.dir, '../../.github/workflows/soak.yml')
const workflow = Bun.YAML.parse(await Bun.file(path).text()) as Workflow
const job = workflow.jobs.soak!
const soakStep = job.steps.find(step => step.name === 'Run isolated soak')!

describe('soak workflow', () => {
  test('runs notification changes in a 30-minute pull-request soak', () => {
    expect(workflow.on.pull_request.paths).toEqual(expect.arrayContaining([
      'plugins/quirky.notifications/**',
      'scripts/soak.ts',
      'scripts/soak/**',
      '.github/workflows/soak.yml',
    ]))
    expect(soakStep.env?.MINUTES).toBe("${{ github.event_name == 'pull_request' && '30' || inputs.minutes || '30' }}")
  })

  test('preserves scheduled and dispatch runs, isolation, defaults, limits and artifacts', () => {
    expect(workflow.on.schedule).toEqual([{ cron: '17 9 * * *' }])
    expect(workflow.on.workflow_dispatch.inputs.minutes.default).toBe('30')
    expect(workflow.on.workflow_dispatch.inputs.slow_git.default).toBe('')
    expect(soakStep.env?.SLOW_GIT).toBe('${{ inputs.slow_git }}')
    expect(job['timeout-minutes']).toBe(50)

    expect(soakStep.run).toContain('export QUIRKY_HOME="$(mktemp -d)"')
    expect(soakStep.run).toContain("trap 'rm -rf \"$QUIRKY_HOME\"' EXIT")
    expect(soakStep.run).toContain('args=(--minutes "$MINUTES" --out soak)')
    expect(soakStep.run).toContain('if [ -n "$SLOW_GIT" ]; then args+=(--slow-git "$SLOW_GIT"); fi')
    expect(soakStep.run).not.toContain('--windows')
    expect(soakStep.run).not.toContain('--workers')
    expect(soakStep.run).not.toContain('--fault')
    expect(soakStep.run).not.toContain('--max-')

    const upload = job.steps.find(step => step.uses === 'actions/upload-artifact@v4')
    expect(upload).toMatchObject({
      if: 'always()',
      with: { name: 'soak-${{ github.sha }}', path: 'soak/', 'retention-days': 14 },
    })
  })
})
