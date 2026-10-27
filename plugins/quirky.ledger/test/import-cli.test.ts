import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { startLedgerHarness, projectTarget, type LedgerHarness } from './harness'

type JsonEntry = {
  id: string
  type: string
  sequence: number
  revision: number
  state: string
  reviewed: boolean
  content: Record<string, unknown>
  history?: { revision: number; actor?: Record<string, unknown> }[]
}
type JsonSummary = { ledgerId: string; tier: string; revision: number; entryCount: number; nextSequence: number; owner?: unknown }
type JsonOutput = {
  schemaVersion?: number
  runtime?: { runtimeId: string; profileId: string }
  ledger?: JsonSummary | null
  entry?: JsonEntry
  entries?: JsonEntry[]
  matches?: JsonEntry[]
  ledgers?: JsonSummary[]
  candidates?: { entry: JsonEntry; stale: boolean; reason: string; evidence?: Record<string, unknown> }[]
  importResult?: { created: string[]; updated: string[]; alreadyPresent: string[]; skipped: { anchor?: string; reason: string; sourcePath?: string }[] }
  error?: { code: string; message: string; data?: Record<string, unknown> }
}
type CliRunOptions = { cwd?: string; env?: Record<string, string> }

let h: LedgerHarness | undefined
afterEach(async () => {
  await h?.cleanup()
  h = undefined
})

async function start(): Promise<LedgerHarness> {
  h = await startLedgerHarness()
  return h
}

async function ledgerCli(harness: LedgerHarness, args: string[], options: CliRunOptions = {}) {
  return harness.runCli(['ledger', ...args], options)
}

async function successfulCli(harness: LedgerHarness, args: string[], options: CliRunOptions = {}) {
  const result = await ledgerCli(harness, args, options)
  expect(result.code).toBe(0)
  expect(result.stderr).toBe('')
  return result
}

function jsonOutput(result: { stdout: string }): JsonOutput {
  const parsed: unknown = JSON.parse(result.stdout.trim())
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('CLI JSON output must be an object')
  return parsed as JsonOutput
}

function writeSource(root: string, relativePath: string, body: string): void {
  const path = join(root, relativePath)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body)
}

function sourceSnapshot(root: string, paths: string[]): Map<string, Buffer> {
  return new Map(paths.map((path) => [path, readFileSync(join(root, path))] as const))
}

function sourcePathMatches(skip: { sourcePath?: string }, filename: string): boolean {
  return skip.sourcePath !== undefined && basename(skip.sourcePath) === filename
}

function expectSourcesUnchanged(root: string, before: Map<string, Buffer>): void {
  for (const [path, bytes] of before) expect(readFileSync(join(root, path))).toEqual(bytes)
}

const bugFlags = ['--type', 'bug', '--title', 'CLI bug', '--file', 'src/main.ts:13', '--description', 'Filed by CLI', '--severity', 'high']

// CLI commands are spawned from packages/cli against the harness daemon; no command or RPC is forwarded.
describe('Project ledger CLI: positional, flag, text, JSON and exit contracts', () => {
  test('files each type with its documented flags and handles workspace aliases, ids, filters, state and revert', async () => {
    const harness = await start()
    const cwd = harness.project.path
    const commands = [
      ['file', ...bugFlags, '--workspace', 'current', '--json'],
      ['file', '--type', 'deferred', '--title', 'Defer cache rewrite', '--why-deferred', 'Wait for stable benchmarks.', '--priority', 'medium', '--workspace', 'active', '--json'],
      ['file', '--type', 'test-gap', '--title', 'Cover parser error', '--file-under-test', 'src/main.ts:19', '--reason-skipped', 'Fixture is missing.', '--workspace', harness.project.workspace.id, '--json'],
      ['file', '--type', 'proposal', '--title', 'Cache lookups', '--context', 'The list is repeated.', '--recommendation', 'Memoize owner resolution.', '--workspace', harness.project.workspace.id, '--json'],
      ['file', '--type', 'decision', '--title', 'Use stable IDs', '--context', 'IDs survive restart.', '--decision', 'Use the ledger sequence.', '--consequences', 'Deleted IDs are not reused.', '--status', 'accepted', '--workspace', harness.project.workspace.id, '--json']
    ]
    const filed: JsonOutput[] = []
    for (const args of commands) filed.push(jsonOutput(await successfulCli(harness, args, { cwd })))
    expect(filed.map((response) => response.entry?.id)).toEqual(['bug-1', 'deferred-2', 'test-gap-3', 'proposal-4', 'decision-5'])
    expect(filed.map((response) => response.entry?.revision)).toEqual([1, 1, 1, 1, 1])
    expect(filed[0]!.entry!.content.file).toMatchObject({ line: 13, path: 'src/main.ts' })

    const positional = jsonOutput(await successfulCli(harness, ['show', 'bug-1', '--json'], { cwd }))
    expect(positional.entry).toMatchObject({ id: 'bug-1', revision: 1, history: [{ revision: 1 }] })
    const byFlag = jsonOutput(await successfulCli(harness, ['show', '--id', 'deferred-2', '--json'], { cwd }))
    expect(byFlag.entry).toMatchObject({ id: 'deferred-2', content: { why_deferred: 'Wait for stable benchmarks.', priority: 'medium' } })

    const filtered = jsonOutput(await successfulCli(harness, [
      'list', '--type', 'bug', '--state', 'open', '--reviewed', 'false', '--stale', 'false',
      '--origin-workspace', harness.project.workspace.id, '--branch', 'refs/heads/main', '--json'
    ], { cwd }))
    expect(filtered.entries?.map((entry) => entry.id)).toEqual(['bug-1'])
    const textList = await successfulCli(harness, ['list'], { cwd })
    const ledgerId = jsonOutput(await successfulCli(harness, ['catalog', '--json'], { cwd })).ledgers![0]!.ledgerId
    const explicitOrigin = jsonOutput(await successfulCli(harness, ['list', '--ledger', ledgerId, '--workspace', harness.project.workspace.id, '--json'], { cwd }))
    expect(explicitOrigin.entries?.map((entry) => entry.id)).toHaveLength(5)
    expect(textList.stdout).toContain('bug-1')
    expect(textList.stdout).toContain('decision-5')
    expect(textList.stderr).toBe('')

    const edited = jsonOutput(await successfulCli(harness, ['edit', 'bug-1', '--if-revision', '1', '--severity', 'critical', '--json'], { cwd }))
    expect(edited.entry).toMatchObject({ id: 'bug-1', revision: 2, content: { severity: 'critical' } })
    const editedById = jsonOutput(await successfulCli(harness, ['edit', '--id', 'deferred-2', '--if-revision', '1', '--priority', 'high', '--json'], { cwd }))
    expect(editedById.entry).toMatchObject({ id: 'deferred-2', revision: 2, content: { priority: 'high' } })
    const moved = jsonOutput(await successfulCli(harness, ['state', 'bug-1', '--state', 'resolved', '--if-revision', '2', '--json'], { cwd }))
    expect(moved.entry).toMatchObject({ state: 'resolved', revision: 3 })
    const reverted = jsonOutput(await successfulCli(harness, ['revert', 'bug-1', '--to-revision', '1', '--if-revision', '3', '--json'], { cwd }))
    expect(reverted.entry).toMatchObject({ state: 'open', revision: 4, content: { severity: 'high' } })

    const review = jsonOutput(await successfulCli(harness, ['review', '--json'], { cwd }))
    expect(review.candidates?.map((candidate) => candidate.entry.id)).toContain('bug-1')
    expect((await harness.operation('show', { target: projectTarget(harness.project), id: 'bug-1' }) as { entry: { revision: number } }).entry.revision).toBe(4)
  })

  test('usage errors exit 2; daemon validation and stale revision errors exit 1 with JSON error details', async () => {
    const harness = await start()
    const cwd = harness.project.path
    const missing = await ledgerCli(harness, ['file', '--type', 'bug', '--title', 'No location', '--json'], { cwd })
    expect(missing.code).toBe(2)
    expect(missing.stderr).toBe('')
    expect(jsonOutput(missing).error).toMatchObject({ code: 'usage', message: expect.stringContaining('file') })
    const missingText = await ledgerCli(harness, ['file', '--type', 'bug', '--title', 'No location'], { cwd })
    expect(missingText.code).toBe(2)
    expect(missingText.stdout).toBe('')
    expect(missingText.stderr).toMatch(/--file|file/i)
    expect((await harness.operation('list', { target: projectTarget(harness.project) }) as { ledger: unknown }).ledger).toBeNull()

    const invalidEnum = await ledgerCli(harness, [
      'file', '--type', 'bug', '--title', 'Bad severity', '--file', 'src/main.ts:5', '--description', 'Invalid enum', '--severity', 'urgent', '--json'
    ], { cwd })
    expect(invalidEnum.code).toBe(1)
    expect(invalidEnum.stderr).toBe('')
    expect(jsonOutput(invalidEnum).error).toMatchObject({ data: { kind: 'invalid-enum' } })

    const created = jsonOutput(await successfulCli(harness, ['file', ...bugFlags, '--json'], { cwd }))
    const firstWrite = jsonOutput(await successfulCli(harness, ['edit', created.entry!.id, '--if-revision', '1', '--severity', 'critical', '--json'], { cwd }))
    expect(firstWrite.entry).toMatchObject({ revision: 2, content: { severity: 'critical' } })
    const stale = await ledgerCli(harness, ['edit', created.entry!.id, '--if-revision', '1', '--title', 'Stale edit', '--json'], { cwd })
    expect(stale.code).toBe(1)
    expect(jsonOutput(stale).error).toMatchObject({ code: 'conflict', data: { kind: 'conflict', currentRevision: 2 } })
    const invalidLocation = await ledgerCli(harness, [
      'file', '--type', 'bug', '--title', 'Bad line', '--file', 'src/main.ts:0', '--description', 'Bad line number', '--severity', 'low', '--json'
    ], { cwd })
    expect(invalidLocation.code).toBe(1)
    expect(jsonOutput(invalidLocation).error?.data).toMatchObject({ kind: 'invalid-request' })
  })

  test('group and workspace selectors choose the intended owner; contradictory scopes and unmanaged cwd fail', async () => {
    const harness = await start()
    const group = await harness.client.callAny('quirky.repo/groupCreate', { name: 'CLI tools' }) as { id: string }
    await harness.client.callAny('quirky.repo/groupAdd', { group: group.id, repo: harness.project.repo.id })
    const cwd = harness.project.path
    const member = jsonOutput(await successfulCli(harness, [
      'file', '--type', 'proposal', '--title', 'Group flag', '--context', 'Group owner.', '--recommendation', 'Use membership.', '--workspace', harness.project.workspace.id, '--group', '--json'
    ], { cwd }))
    expect(member.ledger).toMatchObject({ tier: 'group', owner: { id: group.id } })
    const selected = jsonOutput(await successfulCli(harness, [
      'file', '--type', 'decision', '--title', 'Group selector', '--context', 'Exact group.', '--decision', 'Select by ID.', '--consequences', 'Scoped.', '--status', 'proposed', '--group-selector', group.id, '--json'
    ], { cwd }))
    expect(selected.ledger).toMatchObject({ tier: 'group', owner: { id: group.id } })
    const selectedWithWorkspace = jsonOutput(await successfulCli(harness, [
      'file', '--type', 'deferred', '--title', 'Workspace plus group selector', '--why-deferred', 'No group conflict.', '--priority', 'low',
      '--workspace', harness.project.workspace.id, '--group-selector', group.id, '--json'
    ], { cwd }))
    expect(selectedWithWorkspace.ledger).toMatchObject({ tier: 'group', owner: { id: group.id } })
    const groupEntries = jsonOutput(await successfulCli(harness, ['list', '--group-selector', group.id, '--json'], { cwd }))
    expect(groupEntries.entries?.map((entry) => entry.id)).toEqual(expect.arrayContaining(['proposal-1', 'decision-2', 'deferred-3']))
    expect(groupEntries.entries).toHaveLength(3)
    const byName = jsonOutput(await successfulCli(harness, ['list', '--group-selector', 'CLI tools', '--json'], { cwd }))
    expect(byName.entries?.map((entry) => entry.id)).toEqual(expect.arrayContaining(['proposal-1', 'decision-2', 'deferred-3']))

    const conflict = await ledgerCli(harness, [
      'file', '--type', 'proposal', '--title', 'Conflicting selectors', '--context', 'x', '--recommendation', 'y',
      '--workspace', harness.project.workspace.id, '--group', '--group-selector', group.id, '--json'
    ], { cwd })
    expect(conflict.code).toBe(1)
    expect(jsonOutput(conflict).error?.data).toMatchObject({ kind: 'invalid-target' })

    const unmanaged = join(harness.home, 'unmanaged-cwd')
    mkdirSync(unmanaged, { recursive: true })
    const missing = await ledgerCli(harness, ['list', '--json'], { cwd: unmanaged })
    expect(missing.code).toBe(1)
    expect(jsonOutput(missing).error?.data).toMatchObject({ kind: 'workspace-missing' })
  })

  test('catalog, approve, bulk-state, settings, deletion and removal-preview are scriptable with JSON flags and --yes', async () => {
    const harness = await start()
    const cwd = harness.project.path
    const first = jsonOutput(await successfulCli(harness, ['file', ...bugFlags, '--json'], { cwd }))
    const second = jsonOutput(await successfulCli(harness, [
      'file', '--type', 'proposal', '--title', 'Scriptable operations', '--context', 'CLI test.', '--recommendation', 'Exercise actions.', '--json'
    ], { cwd }))
    const selections = JSON.stringify([{ id: first.entry!.id, revision: 1 }])

    const catalog = jsonOutput(await successfulCli(harness, ['catalog', '--json'], { cwd }))
    expect(catalog.ledgers).toHaveLength(1)
    expect(catalog.ledgers![0]).toMatchObject({ entryCount: 2, nextSequence: 3 })

    const approved = jsonOutput(await successfulCli(harness, ['approve', '--selections', selections, '--workspace', harness.project.workspace.id, '--json'], { cwd }))
    expect(approved.entries?.[0]).toMatchObject({ id: first.entry!.id, revision: 2, reviewed: true })
    const setState = jsonOutput(await successfulCli(harness, [
      'bulk-state', '--state', 'resolved', '--selections', JSON.stringify([{ id: first.entry!.id, revision: 2 }, { id: second.entry!.id, revision: 1 }]),
      '--workspace', harness.project.workspace.id, '--yes', '--json'
    ], { cwd }))
    expect(setState.entries?.map((entry) => [entry.id, entry.state])).toEqual([[first.entry!.id, 'resolved'], [second.entry!.id, 'resolved']])

    const summary = jsonOutput(await successfulCli(harness, ['catalog', '--json'], { cwd })).ledgers![0]!
    const settings = jsonOutput(await successfulCli(harness, [
      'settings', '--workspace', harness.project.workspace.id, '--if-ledger-revision', String(summary.revision), '--stale-after-days', '0', '--json'
    ], { cwd }))
    expect(settings.ledger).toMatchObject({ staleAfterDays: 0, revision: summary.revision + 1 })

    const removedEntry = jsonOutput(await successfulCli(harness, [
      'delete-entries', '--workspace', harness.project.workspace.id,
      '--selections', JSON.stringify([{ id: first.entry!.id, revision: 3 }]), '--yes', '--json'
    ], { cwd }))
    expect(removedEntry.schemaVersion).toBe(1)
    const preview = jsonOutput(await successfulCli(harness, ['removal-preview', '--repo-id', harness.project.repo.id, '--json'], { cwd }))
    expect(preview.removalPreview).toEqual([expect.objectContaining({ entryCount: 1 })])

    const finalSummary = jsonOutput(await successfulCli(harness, ['catalog', '--json'], { cwd })).ledgers![0]!
    const deleted = jsonOutput(await successfulCli(harness, [
      'delete-ledger', '--ledger', finalSummary.ledgerId, '--if-ledger-revision', String(finalSummary.revision), '--yes', '--json'
    ], { cwd }))
    expect(deleted.ledger).toBeNull()
    expect((jsonOutput(await successfulCli(harness, ['catalog', '--json'], { cwd })).ledgers)).toEqual([])
  })

  test('attach is scriptable; detached ledgers remain directly readable and can be removed with a revision snapshot', async () => {
    const harness = await start()
    const created = jsonOutput(await successfulCli(harness, ['file', ...bugFlags, '--json'], { cwd: harness.project.path }))
    await harness.client.callAny('quirky.repo/remove', { repo: harness.project.repo.id })
    const destination = await harness.addProject('cli-destination')
    const detached = await harness.operation('list', { target: { ledgerId: created.ledger!.ledgerId } }) as { ledger: { ledgerId: string; revision: number } }
    const direct = jsonOutput(await successfulCli(harness, ['show', created.entry!.id, '--ledger', detached.ledger.ledgerId, '--json'], { cwd: destination.path }))
    expect(direct.entry?.id).toBe(created.entry!.id)

    const attached = jsonOutput(await successfulCli(harness, [
      'attach', '--ledger', detached.ledger.ledgerId, '--if-ledger-revision', String(detached.ledger.revision),
      '--attach-to', JSON.stringify({ tier: 'project', id: destination.repo.id }), '--yes', '--json'
    ], { cwd: destination.path }))
    expect(attached.ledger).toMatchObject({ owner: { tier: 'project', id: destination.repo.id } })

    const latest = jsonOutput(await successfulCli(harness, ['catalog', '--json'], { cwd: destination.path })).ledgers![0]!
    await successfulCli(harness, [
      'delete-ledger', '--ledger', latest.ledgerId, '--if-ledger-revision', String(latest.revision), '--yes', '--json'
    ], { cwd: destination.path })
    expect(jsonOutput(await successfulCli(harness, ['catalog', '--json'], { cwd: destination.path })).ledgers).toEqual([])
  })
})

// SC-08 / SC-09: real CLI imports read the source tree, commit per record and never write source files.
describe('Project ledger CLI: legacy import formats and replay safety', () => {
  test('imports pipe tables, plain and bold heading labels, bullets, ADR frontmatter and preserved extras', async () => {
    const harness = await start()
    const root = harness.project.path
    writeSource(root, 'BUGS.md', `# Bugs\n\n| ID | Title | File | Description | Severity | Reporter |\n| --- | --- | --- | --- | --- | --- |\n| BUG-12 | Pipe table failure | src/main.ts:4 | Table description | HIGH | QA |\n\n## [BUG-13] Heading parser failure\nFile: src/main.ts:5\nDescription: A plain label record.\nSeverity: low\n- Release: next\n`)
    writeSource(root, 'DEFERRED.md', `## DEFER-7 - Delay cache rewrite\n- Why Deferred: Waiting for benchmark results.\n- Priority: HIGH\n- Owner: Runtime team\n`)
    writeSource(root, 'TEST_BACKLOG.md', `## TEST-4: Cover parser cancellation\n**File Under Test:** src/main.ts:21\n**Reason Skipped:** Stable cancellation fixture is missing.\n**Ticket:** TEST-101\n`)
    writeSource(root, 'proposals.md', `## PROP-2: Cache owner resolution\nContext: Repeated list operations scan the owner catalog.\n**Recommendation:** Cache by catalog generation.\n- Impact: faster reads\n`)
    writeSource(root, 'docs/adr/001-stable-ids.md', `---\nstatus: accepted\n---\n# ADR-001: Use stable entry IDs\n\n## Context\nEntry references outlive worktrees.\n\n## Decision\nUse a monotonic ledger sequence.\n\n## Consequences\nDeleted numbers are never reused.\n\n## Status\naccepted\n`)
    const paths = ['BUGS.md', 'DEFERRED.md', 'TEST_BACKLOG.md', 'proposals.md', 'docs/adr/001-stable-ids.md']
    const before = sourceSnapshot(root, paths)

    const result = jsonOutput(await successfulCli(harness, ['import', '--json'], { cwd: root }))
    expect(result.importResult).toMatchObject({ created: expect.arrayContaining(['bug-1', 'bug-2', 'deferred-3', 'test-gap-4', 'proposal-5', 'decision-6']), updated: [], alreadyPresent: [], skipped: [] })
    const listed = jsonOutput(await successfulCli(harness, ['list', '--json'], { cwd: root }))
    const entries = listed.entries ?? []
    expect(entries).toHaveLength(6)
    expect(entries.map((entry) => entry.type).sort()).toEqual(['bug', 'bug', 'deferred', 'test-gap', 'proposal', 'decision'].sort())
    const byId = new Map(entries.map((entry) => [entry.id, entry] as const))
    expect(byId.get('bug-1')).toMatchObject({ content: { title: 'Pipe table failure', severity: 'high', reporter: 'QA' } })
    expect(byId.get('bug-2')).toMatchObject({ content: { title: 'Heading parser failure', severity: 'low', release: 'next' } })
    expect(byId.get('deferred-3')).toMatchObject({ content: { why_deferred: 'Waiting for benchmark results.', priority: 'high', owner: 'Runtime team' } })
    expect(byId.get('test-gap-4')).toMatchObject({ content: { file_under_test: expect.objectContaining({ path: 'src/main.ts', line: 21 }), reason_skipped: 'Stable cancellation fixture is missing.', ticket: 'TEST-101' } })
    expect(byId.get('proposal-5')).toMatchObject({ content: { context: expect.stringContaining('Repeated list operations'), recommendation: 'Cache by catalog generation.', impact: 'faster reads' } })
    expect(byId.get('decision-6')).toMatchObject({ content: { title: 'Use stable entry IDs', status: 'accepted', context: expect.stringContaining('outlive worktrees'), decision: expect.stringContaining('monotonic'), consequences: expect.stringContaining('never reused') } })
    const importedDetail = jsonOutput(await successfulCli(harness, ['show', 'bug-1', '--json'], { cwd: root }))
    expect(importedDetail.entry!.history?.[0]!.actor).toMatchObject({ kind: 'import', initiator: expect.any(Object) })
    await successfulCli(harness, ['edit', 'bug-1', '--if-revision', '1', '--severity', 'critical', '--json'], { cwd: root })
    await successfulCli(harness, ['state', 'bug-1', '--state', 'resolved', '--if-revision', '2', '--json'], { cwd: root })
    const reverted = jsonOutput(await successfulCli(harness, ['revert', 'bug-1', '--to-revision', '1', '--if-revision', '3', '--json'], { cwd: root }))
    expect(reverted.entry).toMatchObject({ id: 'bug-1', revision: 4, state: 'open', content: { severity: 'high', reporter: 'QA' } })
    expectSourcesUnchanged(root, before)
  })

  test('missing sources are silent; duplicate anchors, malformed fields and read errors are partial skips with exit 1', async () => {
    const harness = await start()
    const root = harness.project.path
    writeSource(root, 'BUGS.md', `| ID | Title | File | Description | Severity |\n| --- | --- | --- | --- | --- |\n| BUG-50 | Duplicate one | src/main.ts:8 | First copy. | high |\n| BUG-50 | Duplicate two | src/main.ts:9 | Second copy. | medium |\n\n## BUG-51: Good record remains\nFile: src/main.ts:10\nDescription: Independent record.\nSeverity: LOW\n\n## BUG-52: Missing severity\nFile: src/main.ts:11\nDescription: Invalid record.\n\n## No legacy id\nFile: src/main.ts:12\nDescription: No explicit ID.\nSeverity: high\n\n## BUG-53: Bad enum\nFile: src/main.ts:13\nDescription: Invalid enum.\nSeverity: impossible\n`)
    mkdirSync(join(root, 'DEFERRED.md'), { recursive: true })
    writeSource(root, 'docs/adr/002-invalid.md', `# ADR-002: Missing decision sections\n\n## Context\nOnly context is present.\n`)
    const before = sourceSnapshot(root, ['BUGS.md', 'docs/adr/002-invalid.md'])

    const imported = await ledgerCli(harness, ['import', '--json'], { cwd: root })
    expect(imported.code).toBe(1)
    const output = jsonOutput(imported)
    expect(output.importResult?.created).toEqual(['bug-1'])
    expect(output.importResult?.skipped.length).toBeGreaterThanOrEqual(5)
    expect(output.importResult!.skipped.every((skip) => skip.reason.length > 0)).toBe(true)
    const duplicates = output.importResult!.skipped.filter((skip) => skip.anchor?.includes('BUG-50') && sourcePathMatches(skip, 'BUGS.md'))
    expect(duplicates).toHaveLength(2)
    expect(duplicates[0]!.anchor).toBe(duplicates[1]!.anchor)
    const textImport = await ledgerCli(harness, ['import'], { cwd: root })
    expect(textImport.code).toBe(1)
    expect(textImport.stdout).toMatch(/skipped/i)
    const entries = jsonOutput(await successfulCli(harness, ['list', '--json'], { cwd: root }))
    expect(entries.entries?.map((entry) => entry.content.title)).toEqual(['Good record remains'])
    expectSourcesUnchanged(root, before)
  })

  test('an empty or all-invalid import does not allocate a ledger', async () => {
    const harness = await start()
    const root = harness.project.path
    const empty = jsonOutput(await successfulCli(harness, ['import', '--json'], { cwd: root }))
    expect(empty.importResult).toMatchObject({ created: [], updated: [], alreadyPresent: [], skipped: [] })
    writeSource(root, 'BUGS.md', `## BUG-90: Invalid only\nFile: src/main.ts:9\nSeverity: high\n`)
    const skipped = await ledgerCli(harness, ['import', '--json'], { cwd: root })
    expect(skipped.code).toBe(1)
    expect(jsonOutput(skipped).importResult?.created).toEqual([])
    expect((jsonOutput(await successfulCli(harness, ['catalog', '--json'], { cwd: root })).ledgers)).toEqual([])
  })

  test('re-import detects unchanged sources, source-only updates, local conflicts and deletion tombstones', async () => {
    const harness = await start()
    const root = harness.project.path
    const source = `## BUG-12: Original title\nFile: src/main.ts:7\nDescription: Original source description.\nSeverity: high\n`
    writeSource(root, 'BUGS.md', source)
    const initialBytes = readFileSync(join(root, 'BUGS.md'))

    const first = jsonOutput(await successfulCli(harness, ['import', '--json'], { cwd: root }))
    expect(first.importResult).toMatchObject({ created: ['bug-1'], updated: [], alreadyPresent: [], skipped: [] })
    await harness.restart()
    const repeat = jsonOutput(await successfulCli(harness, ['import', '--json'], { cwd: root }))
    expect(repeat.importResult).toMatchObject({ created: [], updated: [], alreadyPresent: ['bug-1'], skipped: [] })
    expect((jsonOutput(await successfulCli(harness, ['show', 'bug-1', '--json'], { cwd: root })).entry)).toMatchObject({ revision: 1 })
    expect(readFileSync(join(root, 'BUGS.md'))).toEqual(initialBytes)

    const changedSource = `## BUG-12: Source update title\nFile: src/main.ts:7\nDescription: Source-only change.\nSeverity: critical\n`
    writeSource(root, 'BUGS.md', changedSource)
    const changedBytes = readFileSync(join(root, 'BUGS.md'))
    const updated = jsonOutput(await successfulCli(harness, ['import', '--json'], { cwd: root }))
    expect(updated.importResult).toMatchObject({ created: [], updated: ['bug-1'], alreadyPresent: [], skipped: [] })
    expect(jsonOutput(await successfulCli(harness, ['show', 'bug-1', '--json'], { cwd: root })).entry).toMatchObject({
      id: 'bug-1', revision: 2, content: { title: 'Source update title', severity: 'critical' }
    })
    expect(readFileSync(join(root, 'BUGS.md'))).toEqual(changedBytes)

    const local = jsonOutput(await successfulCli(harness, ['edit', 'bug-1', '--if-revision', '2', '--title', 'Local ledger title', '--json'], { cwd: root }))
    expect(local.entry).toMatchObject({ revision: 3, content: { title: 'Local ledger title' } })
    const newerSource = `## BUG-12: Newer source title\nFile: src/main.ts:7\nDescription: Newer source content.\nSeverity: low\n`
    writeSource(root, 'BUGS.md', newerSource)
    const newerBytes = readFileSync(join(root, 'BUGS.md'))
    const conflicted = await ledgerCli(harness, ['import', '--json'], { cwd: root })
    expect(conflicted.code).toBe(1)
    const conflicts = jsonOutput(conflicted).importResult?.skipped ?? []
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]!).toMatchObject({ reason: 'conflict' })
    expect(sourcePathMatches(conflicts[0]!, 'BUGS.md')).toBe(true)
    expect(jsonOutput(await successfulCli(harness, ['show', 'bug-1', '--json'], { cwd: root })).entry).toMatchObject({ revision: 3, content: { title: 'Local ledger title' } })
    expect(readFileSync(join(root, 'BUGS.md'))).toEqual(newerBytes)

    const removed = await successfulCli(harness, [
      'delete-entries', '--workspace', harness.project.workspace.id,
      '--selections', JSON.stringify([{ id: 'bug-1', revision: 3 }]), '--yes', '--json'
    ], { cwd: root })
    expect(jsonOutput(removed).schemaVersion).toBe(1)
    await harness.restart()
    const tombstone = await ledgerCli(harness, ['import', '--json'], { cwd: root })
    expect(tombstone.code).toBe(1)
    const deleted = jsonOutput(tombstone).importResult?.skipped ?? []
    expect(deleted).toHaveLength(1)
    expect(deleted[0]!).toMatchObject({ reason: 'deleted' })
    expect(sourcePathMatches(deleted[0]!, 'BUGS.md')).toBe(true)
    expect((jsonOutput(await successfulCli(harness, ['list', '--json'], { cwd: root })).entries)).toEqual([])
    expect(readFileSync(join(root, 'BUGS.md'))).toEqual(newerBytes)
  })

  test('equivalent project attachment prevents an imported source anchor from colliding into a duplicate entry', async () => {
    const harness = await start()
    const original = harness.project
    const source = `## BUG-22: Same canonical source identity\nFile: src/main.ts:22\nDescription: Imported before attachment.\nSeverity: high\n`
    writeSource(original.path, 'BUGS.md', source)
    const imported = jsonOutput(await successfulCli(harness, ['import', '--json'], { cwd: original.path }))
    expect(imported.importResult?.created).toEqual(['bug-1'])
    const originalLedger = imported.ledger!
    await harness.client.callAny('quirky.repo/remove', { repo: original.repo.id })
    const detached = await harness.operation('list', { target: { ledgerId: originalLedger.ledgerId } }) as { ledger: { revision: number } }
    const destination = await harness.addProject('equivalent-destination', { origin: 'https://github.com/acme/destination.git' })
    const ui = await harness.connectAs('ui', destination)
    await harness.operation('attach', {
      target: { ledgerId: originalLedger.ledgerId },
      ifLedgerRevision: detached.ledger.revision,
      attachTo: { tier: 'project', id: destination.repo.id },
      confirmed: true,
      yes: true
    }, ui)
    writeSource(destination.path, 'BUGS.md', source)

    const collision = await ledgerCli(harness, ['import', '--json'], { cwd: destination.path })
    expect(collision.code).toBe(1)
    const skips = jsonOutput(collision).importResult?.skipped ?? []
    expect(skips).toHaveLength(1)
    expect(skips[0]!).toMatchObject({ reason: 'canonical-anchor-collision' })
    expect(sourcePathMatches(skips[0]!, 'BUGS.md')).toBe(true)
    const list = jsonOutput(await successfulCli(harness, ['list', '--json'], { cwd: destination.path }))
    expect(list.entries?.map((entry) => entry.id)).toEqual(['bug-1'])
    expect(list.entries?.[0]?.content.title).toBe('Same canonical source identity')
    ui.close()
  })
})
