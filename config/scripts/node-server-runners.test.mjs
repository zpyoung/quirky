import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { parse } from 'yaml'

const workflow = parse(readFileSync('.github/workflows/node-server-tests.yml', 'utf8'))

const runnerOf = (job) => job['runs-on']

it('runs every qualification lane on a GitHub-hosted runner', () => {
  expect(JSON.stringify(workflow)).not.toMatch(/blacksmith/i)
  expect(runnerOf(workflow.jobs.persistence)).toBe('${{ matrix.os }}')
})

it('retains both Linux architectures and the pinned libc qualification containers', () => {
  for (const name of ['linux_glibc_floor', 'linux_musl']) {
    const job = workflow.jobs[name]
    expect(job.strategy.matrix.os).toEqual(['ubuntu-22.04', 'ubuntu-24.04-arm'])
    expect(runnerOf(job)).toBe('${{ matrix.os }}')
  }
  const floor = workflow.jobs.linux_glibc_floor
  expect(floor.container).toBe('${{ matrix.image }}')
  for (const { image } of floor.strategy.matrix.include) {
    expect(image).toMatch(/^quay\.io\/pypa\/manylinux_2_28_.*@sha256:/)
  }
  expect(workflow.jobs.linux_glibc217_compat.steps.map((step) => step.run).join('\n')).toContain(
    'quay.io/pypa/manylinux2014_x86_64@sha256:'
  )
})

it.each([
  ['changes', 'ubuntu-latest'],
  ['mobile_web_bundle', 'ubuntu-latest'],
  ['desktop_template', 'ubuntu-latest'],
  ['linux_glibc217_compat', 'ubuntu-22.04']
])('runs %s on %s', (name, hostedRunner) => {
  expect(runnerOf(workflow.jobs[name])).toBe(hostedRunner)
})

it('still builds and uploads cross-compiled Windows template addons on the x64 lane', () => {
  const steps = workflow.jobs.persistence.steps
  for (const fragment of ['process-table addons', 'CLI launchers', 'security addons']) {
    const upload = steps.find((step) => step.name?.includes(`Keep the Windows ${fragment}`))
    expect(upload.if).toContain("matrix.os == 'windows-2022'")
  }
  const launcher = steps.find((step) => step.uses?.includes('prepare-windows-cli-launcher'))
  expect(launcher.with.arches).toContain("matrix.os == 'windows-2022'")
  expect(launcher.with.arches).toContain("'x64 arm64'")
})
