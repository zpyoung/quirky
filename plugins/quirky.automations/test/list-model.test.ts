import { describe, expect, test } from 'bun:test'
import type { AutomationRun } from '../types'
import {
  appendRunPage,
  canRerun,
  dashboardStatusBucket,
  filterListRows,
  foldedOccurrences,
  parseSafeMarkdownInline,
  runContent,
  sameAutomationOwner,
  sortListRows,
  sortDirectionFor,
  summarizeDashboardRuns,
  summarizeUsage,
  toggleListSort,
  type AutomationListRow
} from '../src/list/list-model'

function row(overrides: Partial<AutomationListRow> = {}): AutomationListRow {
  return {
    key: 'native:a', id: 'a', kind: 'native', name: 'Alpha audit', projectName: 'Orca', hostId: 'local', hostName: 'This Mac',
    prompt: 'Review the weekly release', agentId: 'claude', agentName: 'Claude', enabled: true, lastRunAt: null, lastStatus: null, lastRunRead: 'available',
    ...overrides
  }
}

function run(overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: 'run-1', automationId: 'automation-1', title: 'Audit run 1', runNumber: 1, scheduledFor: 10_000,
    trigger: 'scheduled', status: 'completed', createdAt: 10_000, occurrenceCount: 1, runContext: null, sourceContext: null,
    workspaceId: null, sessionKind: 'structured', sessionId: null, launchSettings: null, error: null, ...overrides
  }
}

describe('automation list model', () => {
  test('searches name, project, prompt, and agent while applying host and status filters', () => {
    const rows = [
      row({ key: 'native:a', id: 'a', hostId: 'local', agentId: 'claude' }),
      row({ key: 'native:b', id: 'b', name: 'Beta', hostId: 'remote', enabled: false, prompt: 'Check deployment', agentId: 'codex', agentName: 'Codex' })
    ]

    expect(filterListRows(rows, { query: 'release', host: 'local', status: 'enabled', lastRun: 'all', agent: '' }).rows.map(({ id }) => id)).toEqual(['a'])
    expect(filterListRows(rows, { query: 'codex', host: 'all', status: 'all', lastRun: 'all', agent: '' }).rows.map(({ id }) => id)).toEqual(['b'])
    expect(filterListRows(rows, { query: '', host: 'remote', status: 'paused', lastRun: 'all', agent: '' }).rows.map(({ id }) => id)).toEqual(['b'])
  })
  test('does not treat a recorded status with a missing timestamp as never run', () => {
    const result = filterListRows([row({ lastRunAt: null, lastStatus: 'completed' })], {
      query: '', host: 'all', status: 'all', lastRun: 'never', agent: ''
    })
    expect(result.rows).toEqual([])
  })
  test('does not call an unreadable or still-loading run history never ran', () => {
    const rows = [
      row({ id: 'loaded-empty', lastRunRead: 'available' }),
      row({ key: 'native:loading', id: 'loading', lastRunRead: 'loading' }),
      row({ key: 'native:unavailable', id: 'unavailable', lastRunRead: 'unavailable' })
    ]
    const result = filterListRows(rows, { query: '', host: 'all', status: 'all', lastRun: 'never', agent: '' })
    expect(result.rows.map(({ id }) => id)).toEqual(['loaded-empty'])
  })
  test('last-run failure filter excludes skipped runs but recognizes external failed status', () => {
    const rows = [
      row({ id: 'native-failed', lastStatus: 'dispatch_failed', lastRunAt: 1 }),
      row({ key: 'native:skipped', id: 'skipped', lastStatus: 'skipped_unavailable', lastRunAt: 2 }),
      row({ key: 'external:failed', id: 'external', kind: 'external', lastStatus: 'failed', lastRunAt: 3 })
    ]
    expect(filterListRows(rows, { query: '', host: 'all', status: 'all', lastRun: 'failed', agent: '' }).rows.map(({ id }) => id))
      .toEqual(['native-failed', 'external'])
  })
  test('owner comparison rejects local workspace replacement and missing-owner drift', () => {
    const owner = {
      kind: 'local' as const, repoId: 'repo', repoPath: '/repo', workspaceId: 'workspace',
      workspacePath: '/repo/workspace', workspaceInstanceId: 'instance-1'
    }
    expect(sameAutomationOwner(owner, { ...owner })).toBe(true)
    expect(sameAutomationOwner(owner, { ...owner, workspaceInstanceId: 'instance-2' })).toBe(false)
    expect(sameAutomationOwner(undefined, owner)).toBe(false)
    expect(sameAutomationOwner(undefined, undefined)).toBe(true)
  })

  test('oversized search warns and leaves search unfiltered without discarding other filters', () => {
    const rows = [row({ id: 'a' }), row({ key: 'native:b', id: 'b', enabled: false })]
    const result = filterListRows(rows, {
      query: 'x'.repeat(513), host: 'all', status: 'enabled', lastRun: 'all', agent: ''
    })

    expect(result.tooLong).toBe(true)
    expect(result.rows.map(({ id }) => id)).toEqual(['a'])
  })

  test('uses name ascending and last-run descending defaults and toggles only the chosen header', () => {
    expect(sortDirectionFor('name')).toBe('asc')
    expect(sortDirectionFor('lastRun')).toBe('desc')
    expect(toggleListSort('name', 'asc', 'name')).toEqual({ sort: 'name', direction: 'desc' })
    expect(toggleListSort('name', 'desc', 'lastRun')).toEqual({ sort: 'lastRun', direction: 'desc' })
    expect(sortListRows([
      row({ key: 'native:old', id: 'old', name: 'Old', lastRunAt: 100 }),
      row({ key: 'native:new', id: 'new', name: 'New', lastRunAt: 300 }),
      row({ key: 'native:none', id: 'none', name: 'No run', lastRunAt: null })
    ], 'lastRun', 'desc').map(({ id }) => id)).toEqual(['new', 'old', 'none'])
  })
})

describe('automation run model', () => {
  test('dashboard counts successful and failed statuses by scheduledFor and excludes future runs', () => {
    const now = 8 * 86_400_000
    const metrics = summarizeDashboardRuns([
      run({ id: 's24', status: 'completed', scheduledFor: now - 86_400_000 }),
      run({ id: 'f7', status: 'dispatch_failed', scheduledFor: now - 6 * 86_400_000 }),
      run({ id: 'future', status: 'completed', scheduledFor: now + 1 }),
      run({ id: 'progress', status: 'dispatching', scheduledFor: now - 100 })
    ], now)

    expect(metrics).toEqual({ successful24h: 1, failed24h: 0, successful7d: 1, failed7d: 1 })
    expect(dashboardStatusBucket('dispatching')).toBe('progress')
    expect(dashboardStatusBucket('skipped_needs_interactive_auth')).toBe('skipped')
    expect(dashboardStatusBucket('completed')).toBe('successful')
    expect(dashboardStatusBucket('dispatch_failed')).toBe('failed')
  })

  test('unknown or absent usage stays unavailable instead of becoming zero spend', () => {
    expect(summarizeUsage([])).toMatchObject({ kind: 'no-runs' })
    expect(summarizeUsage([run({ usage: null })])).toMatchObject({ kind: 'unavailable', cost: null, tokens: null })
    expect(summarizeUsage([run({ status: 'pending', usage: null })])).toMatchObject({ kind: 'not-yet', cost: null, tokens: null })
    expect(summarizeUsage([run({ usage: {
      status: 'known', provider: 'claude', estimatedCostUsd: 0.012, inputTokens: 12, outputTokens: 8,
      cacheReadTokens: 7, cacheWriteTokens: 4, reasoningOutputTokens: 3
    } })])).toMatchObject({
      kind: 'known', cost: 0.012, tokens: 20, knownRuns: 1, totalRuns: 1, costRuns: 1, tokenRuns: 1, partialTokenRuns: 0
    })
    expect(summarizeUsage([run({ usage: {
      status: 'known', provider: 'codex', estimatedCostUsd: null, totalTokens: 20, inputTokens: 12, outputTokens: 8,
      cacheReadTokens: 7, cacheWriteTokens: 4, reasoningOutputTokens: 3
    } })])).toMatchObject({ kind: 'known', cost: null, tokens: 20, tokenRuns: 1, partialTokenRuns: 0 })
    expect(summarizeUsage([run({ usage: {
      status: 'known', provider: 'codex', estimatedCostUsd: null, inputTokens: 10, outputTokens: null, cacheReadTokens: 4,
      tokensUnavailableReason: 'output tokens unavailable'
    } })])).toMatchObject({ kind: 'known', cost: null, tokens: 10, partialTokenRuns: 1 })
    expect(summarizeUsage([run({ usage: {
      status: 'unavailable', provider: 'codex', estimatedCostUsd: null, unavailableReason: 'native_usage_missing'
    } })])).toMatchObject({ kind: 'unavailable', cost: null, tokens: null })
  })

  test('run content follows saved-output, precheck, error, usage, and fallback precedence', () => {
    const saved = runContent(run({
      outputSnapshot: { format: 'plain_text', content: '# Saved output', capturedAt: 1, truncated: true },
      precheckResult: { stderr: 'stderr text', stdout: 'stdout text' }, error: 'run failure',
      usage: { status: 'unavailable', provider: 'claude', unavailableReason: 'native_usage_missing', costUnavailableReason: 'cost unavailable', tokensUnavailableReason: 'usage unavailable' }
    }))
    expect(saved).toMatchObject({ source: 'output', content: '# Saved output', truncated: true, annotation: 'Latest saved output' })
    expect(runContent(run({ precheckResult: { stderr: 'stderr', stdout: 'stdout' } }))).toMatchObject({ source: 'precheck', content: 'stderr\n\nstdout' })
    expect(runContent(run({ error: 'run failure' }))).toMatchObject({ source: 'error', content: 'run failure' })
    expect(runContent(run({ usage: {
      status: 'unavailable', provider: 'claude', unavailableReason: 'native_usage_missing',
      costUnavailableReason: 'cost unavailable', tokensUnavailableReason: 'usage unavailable'
    } }))).toMatchObject({ source: 'usage', content: 'native_usage_missing\n\ncost unavailable\n\nusage unavailable' })
    expect(runContent(run())).toMatchObject({ source: 'empty', content: 'No output content available.' })
  })

  test('rerun is limited to repairable dispatch refusals', () => {
    expect(canRerun('dispatch_failed')).toBe(true)
    expect(canRerun('skipped_unavailable')).toBe(true)
    expect(canRerun('skipped_needs_interactive_auth')).toBe(true)
    expect(canRerun('completed')).toBe(false)
    expect(canRerun('pending')).toBe(false)
    expect(canRerun('skipped_missed')).toBe(false)
  })

  test('folded runs expose occurrence count/latest time and paging merges duplicate IDs stably', () => {
    const folded = run({ occurrenceCount: 4, scheduledFor: 100, lastOccurrenceAt: 500 })
    expect(foldedOccurrences(folded)).toEqual({ count: 4, latestAt: 500 })
    expect(foldedOccurrences(run({ occurrenceCount: 1 }))).toBeNull()
    expect(appendRunPage([run({ id: 'old' })], { runs: [run({ id: 'new' }), run({ id: 'old', title: 'duplicate' })], nextCursor: 'cursor-2' }))
      .toEqual({ runs: [run({ id: 'old' }), run({ id: 'new' })], nextCursor: 'cursor-2' })
    expect(appendRunPage([], { runs: [], nextCursor: null })).toEqual({ runs: [], nextCursor: null })
  })

  test('safe markdown keeps raw HTML and unsafe links as text while parsing supported emphasis', () => {
    expect(parseSafeMarkdownInline('<img src=x onerror=alert(1)> **safe** [bad](javascript:alert(1))')).toEqual([
      { type: 'text', value: '<img src=x onerror=alert(1)> ' },
      { type: 'strong', value: 'safe' },
      { type: 'text', value: ' [bad](javascript:alert(1))' }
    ])
  })
})
