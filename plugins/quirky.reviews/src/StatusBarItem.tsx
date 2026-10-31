import { useCallback, useEffect, useState } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import { CONTEXT_MENU_SEPARATOR, StatusBarItem, StatusDot, ToolIcon, type PopupItem, type UiStatus } from '@quirky/ui'
import { CHECKS_PANEL } from './contracts'
import { isRecord } from './checks/data'
import { parseChecksResult, type CheckSummary } from './detail/data'

function worktreeOf(layout: { worktree?: unknown }): string | null {
  return typeof layout.worktree === 'string' && layout.worktree.trim() !== '' ? layout.worktree : null
}

type Outcome = 'failed' | 'action needed' | 'running' | 'passed' | 'skipped' | 'neutral'

function outcomeOf(check: CheckSummary): Outcome {
  const status = check.status.toLowerCase()
  const conclusion = (check.conclusion ?? '').toLowerCase()
  if (conclusion === 'action_required' || conclusion === 'action required') return 'action needed'
  if (['failure', 'error', 'startup_failure', 'timed_out', 'cancelled'].includes(conclusion) || ['failure', 'error', 'action_required'].includes(status)) return 'failed'
  if (status !== 'completed' && !['success', 'passed'].includes(status)) return 'running'
  if (conclusion === 'skipped') return 'skipped'
  if (conclusion === 'success' || ['success', 'passed'].includes(status)) return 'passed'
  return 'neutral'
}

const DOT: Record<Outcome, UiStatus> = {
  failed: 'failing',
  'action needed': 'needs-you',
  running: 'working',
  passed: 'done',
  skipped: 'idle',
  neutral: 'idle'
}
const RANK: Record<Outcome, number> = { failed: 0, 'action needed': 1, running: 2, neutral: 3, passed: 4, skipped: 5 }

/**
 * The checks `quirky.reviews/checksGet` holds for `worktree`, or null when it has none. The daemon
 * keeps one worktree's checks, loaded by the Checks panel, so another worktree's are never shown as this one's.
 */
function useChecks(context: UiPluginContext, worktree: string | null): CheckSummary[] | null {
  const [checks, setChecks] = useState<CheckSummary[] | null>(null)
  const refresh = useCallback(async (isCurrent: () => boolean) => {
    try {
      const value = await context.call('quirky.reviews/checksGet')
      const held = isRecord(value) && isRecord(value.checks) ? value.checks : null
      const state = worktree !== null && held?.worktree === worktree ? held : null
      const number = state !== null && isRecord(state.review) && typeof state.review.number === 'number' ? state.review.number : null
      const parsed = state !== null && number !== null && isRecord(state.checks) ? parseChecksResult(state.checks, number) : null
      if (isCurrent()) setChecks(parsed !== null && parsed.checks.length > 0 ? parsed.checks : null)
    } catch {
      if (isCurrent()) setChecks(null)
    }
  }, [context, worktree])
  useEffect(() => {
    setChecks(null)
    let alive = true
    let ticket = 0
    const run = () => {
      const mine = ++ticket
      void refresh(() => alive && mine === ticket)
    }
    run()
    const unsubscribe = context.subscribe((event) => {
      if (event.type === 'quirky.reviews/changed') run()
    })
    const offConnection = context.onConnection((status) => {
      if (status === 'connected') run()
    })
    return () => {
      alive = false
      unsubscribe()
      offConnection()
    }
  }, [context, refresh])
  return checks
}

/** "Checks P/T" for the active review, with a popup listing each check; absent when there is no check data. */
export function ChecksSummary({ context }: { context: UiPluginContext }) {
  const [layout, setLayout] = useState(() => context.getLayout())
  useEffect(() => {
    setLayout(context.getLayout())
    return context.onLayout(setLayout)
  }, [context])
  const checks = useChecks(context, worktreeOf(layout))
  if (checks === null) return null

  const outcomes = checks.map((check) => ({ check, outcome: outcomeOf(check) }))
  const passed = outcomes.filter(({ outcome }) => outcome === 'passed').length
  const worst = outcomes.reduce<Outcome>((current, { outcome }) => (RANK[outcome] < RANK[current] ? outcome : current), 'skipped')
  const ordered = [...outcomes].sort((left, right) => RANK[left.outcome] - RANK[right.outcome])
  const rows = ordered.map(({ check, outcome }): PopupItem => ({
    label: check.name,
    subtitle: outcome,
    lead: <StatusDot status={DOT[outcome]} label={outcome} />,
    onSelect: () => context.togglePanel(CHECKS_PANEL, true)
  }))
  const items: PopupItem[] = [
    ...rows,
    CONTEXT_MENU_SEPARATOR,
    { label: 'Open the Checks panel', lead: <ToolIcon name="check-circle" hue="mint" />, onSelect: () => context.togglePanel(CHECKS_PANEL, true) }
  ]
  return (
    <StatusBarItem label={`${passed} of ${checks.length} checks passing`} popupTitle="Checks" items={items}>
      <StatusDot status={DOT[worst === 'skipped' ? 'passed' : worst]} />
      <span>Checks {passed}/{checks.length}</span>
    </StatusBarItem>
  )
}
