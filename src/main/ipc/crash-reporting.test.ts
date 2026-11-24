import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CrashReportRecord } from '../../shared/crash-reporting'

const { handlers, listeners, clipboardWriteTextMock, recordCrashBreadcrumbMock } = vi.hoisted(
  () => ({
    handlers: new Map<string, (_event: unknown, args?: unknown) => unknown>(),
    listeners: new Map<string, (_event: unknown, args?: unknown) => void>(),
    clipboardWriteTextMock: vi.fn(),
    recordCrashBreadcrumbMock: vi.fn()
  })
)

vi.mock('electron', () => ({
  app: { getVersion: () => '1.2.3-test' },
  clipboard: { writeText: clipboardWriteTextMock },
  ipcMain: {
    removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
    handle: vi.fn((channel: string, handler: (_event: unknown, args?: unknown) => unknown) => {
      handlers.set(channel, handler)
    }),
    removeAllListeners: vi.fn((channel: string) => listeners.delete(channel)),
    on: vi.fn((channel: string, listener: (_event: unknown, args?: unknown) => void) => {
      listeners.set(channel, listener)
    })
  }
}))

vi.mock('../crash-reporting/crash-breadcrumb-store', () => ({
  getCrashBreadcrumbSnapshot: vi.fn(() => []),
  // Renderer breadcrumb routing is covered in crash-reporting-renderer-breadcrumbs.test.ts.
  recordCoalescedCrashBreadcrumb: vi.fn(),
  recordCrashBreadcrumb: (...args: unknown[]) => recordCrashBreadcrumbMock(...args)
}))

import {
  _resetRendererErrorReportDedupeForTests,
  registerCrashReportingHandlers
} from './crash-reporting'

function report(
  status: CrashReportRecord['status'] = 'pending',
  id = 'crash-1'
): CrashReportRecord {
  return {
    id,
    createdAt: '2026-05-16T01:00:00.000Z',
    status,
    source: 'renderer',
    processType: 'renderer',
    reason: 'crashed',
    exitCode: 5,
    appVersion: '1.0.0',
    platform: process.platform,
    osRelease: 'test',
    arch: process.arch,
    electronVersion: '41',
    chromeVersion: '141',
    details: {}
  }
}

describe('registerCrashReportingHandlers', () => {
  beforeEach(() => {
    handlers.clear()
    listeners.clear()
    clipboardWriteTextMock.mockReset()
    recordCrashBreadcrumbMock.mockReset()
    _resetRendererErrorReportDedupeForTests()
  })

  it('copies the requested captured report to the clipboard', async () => {
    const latest = report()
    registerCrashReportingHandlers({
      getById: vi.fn(async () => latest),
      dismiss: vi.fn(),
      markSent: vi.fn(),
      markDismissedSent: vi.fn(),
      listRecent: vi.fn(async () => [latest]),
      record: vi.fn(),
      formatDiagnosticText: vi.fn()
    } as never)

    const result = await handlers.get('crashReports:copyLatestDiagnostics')?.(null, {
      reportId: latest.id,
      notes: 'extra /Users/alice/project'
    })

    expect(result).toEqual({ ok: true })
    expect(clipboardWriteTextMock).toHaveBeenCalledWith(expect.stringContaining('[Crash Report]'))
    expect(clipboardWriteTextMock).toHaveBeenCalledWith(
      expect.stringContaining('extra [redacted-path]')
    )
  })

  it('copies an uncaptured crash report when the caller intentionally omits reportId', async () => {
    const pending = report('pending', 'crash-late-pending')
    const listRecent = vi.fn(async () => [pending])
    registerCrashReportingHandlers({
      getById: vi.fn(async () => null),
      dismiss: vi.fn(),
      markSent: vi.fn(),
      markDismissedSent: vi.fn(),
      listRecent,
      record: vi.fn(),
      formatDiagnosticText: vi.fn()
    } as never)

    const result = await handlers.get('crashReports:copyLatestDiagnostics')?.(null, {
      notes: 'after opening /Users/alice/project'
    })

    expect(result).toEqual({ ok: true })
    expect(clipboardWriteTextMock).toHaveBeenCalledWith(expect.stringContaining('not captured'))
    expect(clipboardWriteTextMock).toHaveBeenCalledWith(expect.stringContaining('[redacted-path]'))
    expect(clipboardWriteTextMock).not.toHaveBeenCalledWith(
      expect.stringContaining('crash-late-pending')
    )
    expect(listRecent).not.toHaveBeenCalled()
  })

  it('returns dismissed unsent reports for the manual Help menu entry', async () => {
    const dismissed = report('dismissed', 'crash-help-menu')
    registerCrashReportingHandlers({
      getById: vi.fn(async () => dismissed),
      dismiss: vi.fn(),
      markSent: vi.fn(),
      markDismissedSent: vi.fn(),
      listRecent: vi.fn(async () => [report('sent', 'crash-sent'), dismissed]),
      record: vi.fn(),
      formatDiagnosticText: vi.fn()
    } as never)

    await expect(handlers.get('crashReports:getLatestPending')?.(null)).resolves.toBeNull()
    await expect(handlers.get('crashReports:getLatestReport')?.(null)).resolves.toEqual(dismissed)
  })

  it('dismisses a pending report through the store', async () => {
    const latest = report('pending', 'crash-dismiss')
    const dismissed = report('dismissed', latest.id)
    const dismiss = vi.fn(async () => dismissed)
    registerCrashReportingHandlers({
      getById: vi.fn(async () => latest),
      dismiss,
      markSent: vi.fn(),
      markDismissedSent: vi.fn(),
      listRecent: vi.fn(async () => [latest]),
      record: vi.fn(),
      formatDiagnosticText: vi.fn()
    } as never)

    const result = await handlers.get('crashReports:dismiss')?.(null, {
      reportId: latest.id
    })

    expect(result).toEqual(dismissed)
    expect(dismiss).toHaveBeenCalledWith(latest.id)
  })

  it('records a deduped renderer error boundary report through the crash store', async () => {
    const recorded = report('pending', 'react-render')
    const recordMock = vi.fn(async () => recorded)
    registerCrashReportingHandlers({
      getById: vi.fn(),
      dismiss: vi.fn(),
      markSent: vi.fn(),
      markDismissedSent: vi.fn(),
      listRecent: vi.fn(async () => []),
      record: recordMock,
      formatDiagnosticText: vi.fn()
    } as never)

    const args = {
      boundaryId: 'terminal.workbench',
      surface: 'terminal-workbench',
      errorName: 'TypeError',
      errorMessage: 'Cannot read /Users/alice/project/token=abc123',
      errorStack: 'TypeError: nope\n    at /Users/alice/project/App.tsx:12:1',
      componentStack: 'at Terminal\nat App',
      activeView: 'terminal',
      activeModal: 'none',
      activeTabType: 'terminal',
      activeRightSidebarTab: 'source-control',
      hasActiveWorktree: true
    }

    await expect(handlers.get('crashReports:recordRendererError')?.(null, args)).resolves.toEqual({
      ok: true,
      report: recorded,
      deduped: false
    })
    await expect(handlers.get('crashReports:recordRendererError')?.(null, args)).resolves.toEqual({
      ok: true,
      report: null,
      deduped: true
    })

    expect(recordMock).toHaveBeenCalledTimes(1)
    expect(recordMock).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'renderer',
        processType: 'react-render',
        reason: 'react-error-boundary',
        exitCode: null,
        appVersion: '1.2.3-test',
        details: expect.objectContaining({
          boundary_id: 'terminal.workbench',
          surface: 'terminal-workbench',
          error_name: 'TypeError',
          error_message: 'Cannot read /Users/alice/project/token=abc123',
          active_view: 'terminal',
          active_modal: 'none',
          active_tab_type: 'terminal',
          right_sidebar_tab: 'source-control',
          has_active_worktree: true
        })
      })
    )
  })

  it('rejects invalid renderer error boundary surfaces', async () => {
    const recordMock = vi.fn()
    registerCrashReportingHandlers({
      getById: vi.fn(),
      dismiss: vi.fn(),
      markSent: vi.fn(),
      markDismissedSent: vi.fn(),
      listRecent: vi.fn(async () => []),
      record: recordMock,
      formatDiagnosticText: vi.fn()
    } as never)

    await expect(
      handlers.get('crashReports:recordRendererError')?.(null, {
        boundaryId: 'terminal.workbench',
        surface: 'unknown',
        errorName: 'TypeError',
        errorMessage: 'nope'
      })
    ).resolves.toEqual({ ok: false, error: 'Invalid renderer error report.' })
    expect(recordMock).not.toHaveBeenCalled()
  })

  it('bounds renderer error dedupe keys by evicting the oldest unique reports', async () => {
    let recordCount = 0
    const recordMock = vi.fn(async () => report('pending', `react-render-${recordCount++}`))
    registerCrashReportingHandlers({
      getById: vi.fn(),
      dismiss: vi.fn(),
      markSent: vi.fn(),
      markDismissedSent: vi.fn(),
      listRecent: vi.fn(async () => []),
      record: recordMock,
      formatDiagnosticText: vi.fn()
    } as never)

    const baseArgs = {
      boundaryId: 'terminal.workbench',
      surface: 'terminal-workbench',
      errorName: 'TypeError',
      componentStack: 'at Terminal'
    }

    for (let i = 0; i < 260; i += 1) {
      await handlers.get('crashReports:recordRendererError')?.(null, {
        ...baseArgs,
        errorMessage: `unique-render-error-${i}`
      })
    }

    await expect(
      handlers.get('crashReports:recordRendererError')?.(null, {
        ...baseArgs,
        errorMessage: 'unique-render-error-0'
      })
    ).resolves.toEqual({
      ok: true,
      report: expect.objectContaining({ id: 'react-render-260' }),
      deduped: false
    })
    await expect(
      handlers.get('crashReports:recordRendererError')?.(null, {
        ...baseArgs,
        errorMessage: 'unique-render-error-259'
      })
    ).resolves.toEqual({
      ok: true,
      report: null,
      deduped: true
    })

    expect(recordMock).toHaveBeenCalledTimes(261)
  })
})
