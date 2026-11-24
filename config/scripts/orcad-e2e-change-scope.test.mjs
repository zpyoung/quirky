import { existsSync, readFileSync } from 'node:fs'
import { matchesGlob } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const workflows = {
  computer: parse(
    readFileSync(new URL('../../.github/workflows/computer-e2e.yml', import.meta.url), 'utf8')
  ),
  hostileHosts: parse(
    readFileSync(new URL('../../.github/workflows/ssh-hostile-hosts.yml', import.meta.url), 'utf8')
  )
}

function workflowIncludes(paths, files) {
  return files.some((file) =>
    paths.reduce((included, pattern) => {
      const excluded = pattern.startsWith('!')
      return matchesGlob(file, excluded ? pattern.slice(1) : pattern) ? !excluded : included
    }, false)
  )
}

describe.each(['computer'])('%s unit-support routing', (lane) => {
  const paths = workflows[lane].on.pull_request.paths
  const helpers = [
    'src/main/daemon/serialize-grid-roundtrip.ts',
    'src/main/daemon/mock-descendant-sweep.ts',
    'src/main/daemon/daemon-host-relocation.test-fixture.ts',
    'src/main/daemon/daemon-endpoint-reachability-test-harness.ts'
  ]
  const product = 'src/main/daemon/daemon-entry.ts'
  const renamed = 'src/main/daemon/serialize-grid-runtime.ts'

  it.each(helpers)('leaves known unit support to its suites: %s', (helper) => {
    expect(workflowIncludes(paths, [helper])).toBe(false)
    expect(workflowIncludes(paths, [helper, 'docs/ci.md'])).toBe(false)
    expect(workflowIncludes(paths, [helper, product])).toBe(true)
    // Both names of a rename must retain the production workflow.
    expect(workflowIncludes(paths, [helper, renamed])).toBe(true)
    expect(workflowIncludes(paths, [renamed, helper])).toBe(true)
    expect(workflowIncludes(paths, ['src/main/daemon/unknown-test-harness.ts'])).toBe(true)
  })

  it('keeps production selected when multiple unit fixtures change', () => {
    expect(workflowIncludes(paths, helpers)).toBe(false)
    expect(workflowIncludes(paths, [...helpers, product])).toBe(true)
  })
})

it.each([
  'config/scripts/daemon-boot-smoke.mjs',
  'config/scripts/daemon-endpoint-handover-smoke.mjs',
  'config/scripts/computer-use-smoke.test.mjs',
  'native/computer-use-macos/Sources/OrcaComputerUseMacOS/main.swift',
  'src/cli/handlers/computer.ts',
  '.github/workflows/computer-e2e.yml'
])('keeps the computer contract owner selected: %s', (file) => {
  expect(workflowIncludes(workflows.computer.on.pull_request.paths, [file])).toBe(true)
})

// Each remote host lane executes these sources, so a change to one must start the lane.
describe.each([
  [
    'hostileHosts',
    [
      'src/main/ssh/connection/ssh-connection.ts',
      'src/main/ssh/connection/ssh-connect-config.ts',
      'src/main/ssh/ssh-posix-command-wrapper.ts',
      'src/shared/shell-argument-quoting.ts'
    ]
  ]
])('%s remote transport routing', (lane, sources) => {
  const paths = workflows[lane].on.pull_request.paths

  it.each(sources)('starts the lane for %s', (file) => {
    expect(existsSync(new URL(`../../${file}`, import.meta.url)), file).toBe(true)
    expect(workflowIncludes(paths, [file])).toBe(true)
    expect(workflowIncludes(paths, [file.replace(/\.ts$/, '.test.ts')])).toBe(false)
  })
})
