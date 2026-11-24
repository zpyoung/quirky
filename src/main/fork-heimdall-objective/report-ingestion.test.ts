import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ObjectiveWorkspaceTarget } from './content-identity'
import {
  MAX_OBJECTIVE_REPORT_BYTES,
  issueObjectiveReportPath,
  readObjectiveRoleReport,
  resolveExpectedObjectiveReportPath
} from './report-ingestion'
import {
  cleanupTemporaryDirectories,
  createLocalFolderTarget
} from './objective-temp-workspace-test-fixtures'

const temporaryDirectories: string[] = []

async function localFolderTarget(): Promise<ObjectiveWorkspaceTarget> {
  return createLocalFolderTarget(temporaryDirectories, 'quirky-objective-report-')
}

function remoteFolderTarget(): ObjectiveWorkspaceTarget {
  return {
    kind: 'folder',
    executionHostId: 'ssh:objective-report-test',
    workspacePath: '/srv/objective'
  }
}

afterEach(async () => {
  await cleanupTemporaryDirectories(temporaryDirectories)
})

describe('objective role report ingestion', () => {
  it('issues a fingerprint-safe path beneath the objective report directory', async () => {
    const target = await localFolderTarget()
    const path = await issueObjectiveReportPath(target, '../../mailbox-path\0with unsafe text')

    expect(dirname(path)).toBe(
      join(target.workspacePath, '.quirky', 'heimdall', 'objective', 'reports')
    )
    expect(basename(path)).toMatch(/^[0-9a-f]{64}\.json$/u)
    await expect(
      resolveExpectedObjectiveReportPath(target, '../../mailbox-path\0with unsafe text')
    ).resolves.toBe(path)
  })

  it('refuses an arbitrary mailbox path before stat or read reaches the host', async () => {
    const target = await localFolderTarget()

    await expect(
      readObjectiveRoleReport({
        target,
        attemptFingerprint: 'attempt-1',
        mailboxReportPath: '/tmp/attacker-selected.json',
        role: 'planner'
      })
    ).resolves.toEqual({ ok: false, reason: 'path-mismatch' })
  })

  it('refuses to issue a report path for a non-local execution host', async () => {
    await expect(issueObjectiveReportPath(remoteFolderTarget(), 'remote-attempt')).rejects.toThrow(
      'Remote objective target is not served by this host'
    )
  })

  it('enforces the complete report cap in UTF-8 bytes independently of field code units', async () => {
    const target = await localFolderTarget()
    const path = await issueObjectiveReportPath(target, 'report-byte-boundary')
    const report = JSON.stringify({
      plan: [
        {
          taskKey: 'core',
          title: 'Core',
          spec: '界',
          deps: [],
          criteria: [{ body: 'Works', shellCheckable: false, checkCommand: null }],
          declaresDependencyChange: false
        }
      ]
    })
    const exact = `${report}${' '.repeat(MAX_OBJECTIVE_REPORT_BYTES - Buffer.byteLength(report, 'utf8'))}`

    expect(exact.length).toBeLessThan(MAX_OBJECTIVE_REPORT_BYTES)
    expect(Buffer.byteLength(exact, 'utf8')).toBe(MAX_OBJECTIVE_REPORT_BYTES)
    await writeFile(path, exact)
    await expect(
      readObjectiveRoleReport({
        target,
        attemptFingerprint: 'report-byte-boundary',
        mailboxReportPath: path,
        role: 'planner'
      })
    ).resolves.toMatchObject({ ok: true })

    await writeFile(path, `${exact} `)
    await expect(
      readObjectiveRoleReport({
        target,
        attemptFingerprint: 'report-byte-boundary',
        mailboxReportPath: path,
        role: 'planner'
      })
    ).resolves.toEqual({ ok: false, reason: 'oversize' })
  })

  it('rejects structurally invalid strict-schema reports', async () => {
    const target = await localFolderTarget()
    const path = await issueObjectiveReportPath(target, 'malformed-attempt')
    await writeFile(path, JSON.stringify({ plan: [], untrusted: true }))

    await expect(
      readObjectiveRoleReport({
        target,
        attemptFingerprint: 'malformed-attempt',
        mailboxReportPath: path,
        role: 'planner'
      })
    ).resolves.toMatchObject({ ok: false, reason: 'malformed' })
  })

  it('exposes the parsed JSON on a schema-invalid repair report so the ingest step can still store it (X1)', async () => {
    const target = await localFolderTarget()
    const path = await issueObjectiveReportPath(target, 'repair-schema-invalid')
    await writeFile(path, JSON.stringify({ repair: { dropTaskKeys: ['extra'] } }))

    const result = await readObjectiveRoleReport({
      target,
      attemptFingerprint: 'repair-schema-invalid',
      mailboxReportPath: path,
      role: 'planner',
      plannerMode: 'repair'
    })

    expect(result).toMatchObject({ ok: false, reason: 'malformed' })
    if (!result.ok) {
      expect(result.rawInput).toEqual({ repair: { dropTaskKeys: ['extra'] } })
    }
  })

  it('omits rawInput when the file never parsed as JSON', async () => {
    const target = await localFolderTarget()
    const path = await issueObjectiveReportPath(target, 'not-json')
    await writeFile(path, 'not json at all')

    const result = await readObjectiveRoleReport({
      target,
      attemptFingerprint: 'not-json',
      mailboxReportPath: path,
      role: 'planner'
    })

    expect(result).toEqual({ ok: false, reason: 'malformed' })
  })

  it('rejects planner globs with an actionable field path while preserving classification', async () => {
    const target = await localFolderTarget()
    const path = await issueObjectiveReportPath(target, 'planner-glob-attempt')
    await writeFile(
      path,
      JSON.stringify({
        plan: [
          {
            taskKey: 'task-1',
            title: 'Implement behavior',
            spec: 'Implement the objective behavior completely.',
            deps: [],
            criteria: [{ body: 'Behavior works', shellCheckable: true, checkCommand: 'true' }],
            declaresDependencyChange: false,
            declaredPaths: ['src/**']
          }
        ]
      })
    )

    const result = await readObjectiveRoleReport({
      target,
      attemptFingerprint: 'planner-glob-attempt',
      mailboxReportPath: path,
      role: 'planner'
    })

    expect(result).toMatchObject({
      ok: false,
      reason: 'malformed',
      detail: 'plan[0].declaredPaths[0]: Path must be a concrete workspace-relative path'
    })
    if (!result.ok) {
      expect(result.detail).not.toContain('src/**')
    }
  })

  it('distinguishes a complete report for the wrong role from malformed JSON', async () => {
    const target = await localFolderTarget()
    const path = await issueObjectiveReportPath(target, 'role-attempt')
    await writeFile(
      path,
      JSON.stringify({ verdict: 'approve', criteriaResults: [], summary: 'Review complete.' })
    )

    await expect(
      readObjectiveRoleReport({
        target,
        attemptFingerprint: 'role-attempt',
        mailboxReportPath: path,
        role: 'integrator'
      })
    ).resolves.toMatchObject({ ok: false, reason: 'role-mismatch' })
  })

  it('reads a plan-review report under the internal plan-review role, distinct from reviewer', async () => {
    const target = await localFolderTarget()
    const path = await issueObjectiveReportPath(target, 'plan-review-attempt')
    await writeFile(
      path,
      JSON.stringify({
        verdict: 'approve',
        assumptions: [],
        findings: [],
        summary: 'Plan looks sound.'
      })
    )

    const result = await readObjectiveRoleReport({
      target,
      attemptFingerprint: 'plan-review-attempt',
      mailboxReportPath: path,
      role: 'plan-review'
    })
    expect(result).toMatchObject({ ok: true, role: 'plan-review' })
    if (result.ok) {
      expect(result.report).toMatchObject({ verdict: 'approve' })
    }

    await expect(
      readObjectiveRoleReport({
        target,
        attemptFingerprint: 'plan-review-attempt',
        mailboxReportPath: path,
        role: 'reviewer'
      })
    ).resolves.toMatchObject({ ok: false, reason: 'role-mismatch' })
  })

  it('accepts a real repair-shaped report for role planner when no shape is specified', async () => {
    const target = await localFolderTarget()
    const path = await issueObjectiveReportPath(target, 'repair-attempt-unspecified')
    await writeFile(
      path,
      JSON.stringify({
        repair: {
          upsertTasks: [
            {
              taskKey: 'core-2',
              title: 'Core follow-up',
              spec: 'Implement the core follow-up work.',
              deps: [],
              criteria: [{ body: 'Follow-up works', shellCheckable: false, checkCommand: null }],
              declaresDependencyChange: false,
              territory: ['src/**']
            }
          ],
          dropTaskKeys: []
        },
        assumptions: []
      })
    )

    const result = await readObjectiveRoleReport({
      target,
      attemptFingerprint: 'repair-attempt-unspecified',
      mailboxReportPath: path,
      role: 'planner'
    })
    expect(result.ok).toBe(true)
    if (result.ok && 'repair' in result.report) {
      expect(result.report.repair.upsertTasks[0]?.taskKey).toBe('core-2')
    }
  })

  it('accepts a real repair-shaped report when plannerMode is repair', async () => {
    const target = await localFolderTarget()
    const path = await issueObjectiveReportPath(target, 'repair-attempt-explicit')
    await writeFile(
      path,
      JSON.stringify({
        repair: { upsertTasks: [], dropTaskKeys: ['dropped-task'] }
      })
    )

    const result = await readObjectiveRoleReport({
      target,
      attemptFingerprint: 'repair-attempt-explicit',
      mailboxReportPath: path,
      role: 'planner',
      plannerMode: 'repair'
    })
    expect(result.ok).toBe(true)
    if (result.ok && 'repair' in result.report) {
      expect(result.report.repair.dropTaskKeys).toEqual(['dropped-task'])
    }
  })

  it('rejects a full-plan report when plannerMode is repair', async () => {
    const target = await localFolderTarget()
    const path = await issueObjectiveReportPath(target, 'repair-attempt-mismatched')
    await writeFile(
      path,
      JSON.stringify({
        plan: [
          {
            taskKey: 'core',
            title: 'Core',
            spec: 'Implement core.',
            deps: [],
            criteria: [{ body: 'Works', shellCheckable: false, checkCommand: null }],
            declaresDependencyChange: false
          }
        ]
      })
    )

    await expect(
      readObjectiveRoleReport({
        target,
        attemptFingerprint: 'repair-attempt-mismatched',
        mailboxReportPath: path,
        role: 'planner',
        plannerMode: 'repair'
      })
    ).resolves.toMatchObject({ ok: false, reason: 'malformed' })
  })

  it('rejects a repair-shaped report when plannerMode is full', async () => {
    const target = await localFolderTarget()
    const path = await issueObjectiveReportPath(target, 'full-attempt-mismatched')
    await writeFile(
      path,
      JSON.stringify({ repair: { upsertTasks: [], dropTaskKeys: ['dropped-task'] } })
    )

    await expect(
      readObjectiveRoleReport({
        target,
        attemptFingerprint: 'full-attempt-mismatched',
        mailboxReportPath: path,
        role: 'planner',
        plannerMode: 'full'
      })
    ).resolves.toMatchObject({ ok: false, reason: 'malformed' })
  })

  it('requires an implementer report to name the dispatched task', async () => {
    const target = await localFolderTarget()
    const path = await issueObjectiveReportPath(target, 'task-attempt')
    await writeFile(
      path,
      JSON.stringify({
        taskKey: 'different-task',
        summary: 'Implemented the requested behavior.',
        filesModified: ['src/changed.ts'],
        criteriaSelfAssessment: [{ criterionIndex: 0, result: 'pass', note: 'Verified.' }]
      })
    )

    await expect(
      readObjectiveRoleReport({
        target,
        attemptFingerprint: 'task-attempt',
        mailboxReportPath: path,
        role: 'implementer',
        taskKey: 'expected-task'
      })
    ).resolves.toEqual({ ok: false, reason: 'task-mismatch' })
  })

  it('rejects a local report whose issued leaf was replaced by a symlink', async () => {
    const target = await localFolderTarget()
    const path = await issueObjectiveReportPath(target, 'symlink-leaf')
    const source = join(target.workspacePath, 'attacker-report.json')
    await writeFile(
      source,
      JSON.stringify({ verdict: 'approve', criteriaResults: [], summary: 'x' })
    )
    await symlink(source, path)

    await expect(
      readObjectiveRoleReport({
        target,
        attemptFingerprint: 'symlink-leaf',
        mailboxReportPath: path,
        role: 'reviewer'
      })
    ).resolves.toEqual({ ok: false, reason: 'malformed' })
  })

  it('rejects a local report redirected through a symlinked metadata ancestor', async () => {
    const target = await localFolderTarget()
    const path = await issueObjectiveReportPath(target, 'symlink-ancestor')
    const outside = await mkdtemp(join(tmpdir(), 'quirky-objective-report-outside-'))
    temporaryDirectories.push(outside)
    const redirectedDirectory = join(outside, 'heimdall', 'objective', 'reports')
    await mkdir(redirectedDirectory, { recursive: true })
    await writeFile(
      join(redirectedDirectory, basename(path)),
      JSON.stringify({ verdict: 'approve', criteriaResults: [], summary: 'x' })
    )
    await rm(join(target.workspacePath, '.quirky'), { recursive: true, force: true })
    await symlink(outside, join(target.workspacePath, '.quirky'))

    await expect(
      readObjectiveRoleReport({
        target,
        attemptFingerprint: 'symlink-ancestor',
        mailboxReportPath: path,
        role: 'reviewer'
      })
    ).resolves.toEqual({ ok: false, reason: 'malformed' })
  })

  it('returns a validated report and a digest only from the issued host path', async () => {
    const target = await localFolderTarget()
    const path = await issueObjectiveReportPath(target, 'valid-attempt')
    await writeFile(
      path,
      JSON.stringify({
        plan: [
          {
            taskKey: 'task-1',
            title: 'Implement behavior',
            spec: 'Implement the objective behavior completely.',
            deps: [],
            criteria: [{ body: 'Behavior works', shellCheckable: true, checkCommand: 'true' }],
            declaresDependencyChange: false,
            declaredPaths: ['src/behavior.ts']
          }
        ]
      })
    )

    const result = await readObjectiveRoleReport({
      target,
      attemptFingerprint: 'valid-attempt',
      mailboxReportPath: path,
      role: 'planner'
    })
    expect(result.ok).toBe(true)
    if (result.ok && 'plan' in result.report) {
      expect(result.report.plan[0]?.taskKey).toBe('task-1')
      expect(result.report.plan[0]?.declaredPaths).toEqual(['src/behavior.ts'])
      expect(result.reportDigest).toMatch(/^[0-9a-f]{64}$/u)
      expect(result.path).toBe(path)
    }
  })
})
