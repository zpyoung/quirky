import { useEffect, useState } from 'react'
import { Badge, StatusDot as UiStatusDot, type UiStatus } from '@quirky/ui'
import type { AgentDisplayState } from '@quirky/protocol'
import type { DisplayStatus, WorktreeGlyph } from './status'

const TICK_MS = 60_000

/** The current time, refreshed every minute so a state that has gone stale shows as such without an event. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(timer)
  }, [])
  return now
}

export function semanticStatus(value: AgentDisplayState | DisplayStatus): UiStatus {
  switch (value) {
    case 'working':
    case 'monitoring':
      return 'working'
    case 'waiting':
    case 'permission':
    case 'blocked':
      return 'needs-you'
    case 'failed':
      return 'failing'
    case 'done':
      return 'done'
    case 'running':
      return 'queued'
    case 'interrupted':
    case 'unverifiable':
    case 'unconfirmed':
    case 'idle':
    case 'exited':
      return 'idle'
  }
}

/** A worktree's status dot uses shared semantic colors, with the agent's real progress when present. */
export function StatusDot({ glyph }: { glyph: WorktreeGlyph | null }) {
  if (!glyph) return <UiStatusDot status="idle" label="Idle" />
  if (glyph.kind === 'agent') {
    return (
      <span title={glyph.label}>
        <UiStatusDot
          status={semanticStatus(glyph.display)}
          label={glyph.label}
          progress={glyph.percent ?? undefined}
        />
      </span>
    )
  }
  return <UiStatusDot status={semanticStatus(glyph.status)} label={glyph.status} />
}

/** A worktree's glyph for unread activity, styled as a shared badge. */
export function UnreadBell() {
  return <Badge tone="accent" label="Unread">Unread</Badge>
}
