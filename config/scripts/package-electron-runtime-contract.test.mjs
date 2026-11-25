import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const projectDir = resolve(import.meta.dirname, '../..')
const readProject = (file) => readFileSync(join(projectDir, file), 'utf8')

describe('Electron runtime package contract', () => {
  it('keeps release-cut signing provenance on GitHub-hosted runners', () => {
    const releaseWorkflow = parse(
      readFileSync(join(projectDir, '.github/workflows/release-cut.yml'), 'utf8')
    )
    const releaseWorkflowText = readFileSync(
      join(projectDir, '.github/workflows/release-cut.yml'),
      'utf8'
    )
    const macDispatchStep = releaseWorkflow.jobs['build-mac'].steps.find(
      (step) => step.name === 'Run isolated macOS release build'
    )

    expect(releaseWorkflowText).not.toContain('blacksmith-')
    expect(releaseWorkflow.jobs['build-mac']['runs-on']).toBe('ubuntu-latest')
    expect(releaseWorkflow.jobs['build-mac'].permissions.actions).toBe('write')
    expect(macDispatchStep.run).toBe(
      'node config/scripts/run-release-mac-build-workflow.mjs dispatch'
    )
    expect(macDispatchStep.env.RELEASE_MAC_BUILD_WORKFLOW).toBe('release-mac-build.yml')
    expect(macDispatchStep.env.RELEASE_MAC_BUILD_TAG).toBe('${{ needs.cut.outputs.tag }}')
    // Fork is macOS-only: the Windows/Linux `build` job is disabled, so publishing
    // must not depend on it (a skipped dependency would cascade-skip publish-release).
    expect(releaseWorkflow.jobs['publish-release'].needs).not.toContain('build')
    expect(releaseWorkflow.jobs['publish-release'].needs).toContain('build-mac')
    expect(releaseWorkflow.jobs['publish-release'].needs).toContain('verify-mac-build')
    const macVerification = releaseWorkflow.jobs['verify-mac-build']
    expect(macVerification.needs).toEqual(['cut', 'build-mac'])
    expect(macVerification.if).toContain('!cancelled()')
    expect(macVerification.if).not.toContain('needs.build.result')
    expect(macVerification.permissions).toEqual({ actions: 'read', contents: 'read' })
    expect(releaseWorkflow.jobs['publish-release'].if).toContain(
      "needs.verify-mac-build.result == 'success'"
    )
  })

  it('qualifies macOS after failed sibling builds and publishes only complete successful builds', () => {
    const { jobs } = parse(readProject('.github/workflows/release-cut.yml'))
    const evaluate = (source, needs, cancelled) =>
      runInNewContext(source.replace(/needs\.([a-z][a-z0-9-]*)/g, 'needs["$1"]'), {
        needs,
        cancelled: () => cancelled
      })
    const results = ['success', 'failure', 'skipped', 'cancelled']
    for (const matrix of results) {
      for (const dispatch of results) {
        for (const verification of results) {
          for (const cancelled of [false, true]) {
            const needs = {
              cut: { result: 'success', outputs: { should_release: 'true' } },
              build: { result: matrix },
              'build-mac': { result: dispatch },
              'verify-mac-build': { result: verification },
              'skill-sharing-linux-floor-release-gate': { result: 'success' },
              'skill-sharing-release-gate': { result: 'success' },
              'terminal-rendering-golden': { result: 'success' }
            }
            expect(evaluate(jobs['verify-mac-build'].if, needs, cancelled)).toBe(
              !cancelled && dispatch === 'success'
            )
            // Fork is macOS-only: the Windows/Linux `build` result never gates publishing.
            expect(evaluate(jobs['publish-release'].if, needs, cancelled)).toBe(
              !cancelled && dispatch === 'success' && verification === 'success'
            )
          }
        }
      }
    }
    // The fork's release carries neither skill-sharing gate, so only these gate publishing.
    for (const prerequisite of ['cut', 'terminal-rendering-golden']) {
      const needs = Object.fromEntries([
        ['cut', { result: 'success', outputs: { should_release: 'true' } }],
        ...[
          'build',
          'build-mac',
          'verify-mac-build',
          'skill-sharing-linux-floor-release-gate',
          'skill-sharing-release-gate',
          'terminal-rendering-golden'
        ].map((name) => [name, { result: 'success' }])
      ])
      needs[prerequisite].result = 'failure'
      expect(evaluate(jobs['publish-release'].if, needs, false)).toBe(false)
    }
  })
})
