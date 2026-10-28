import { useRef, useState } from 'react'
import { PopupMenu } from '../panel/Menu'
import { SparkleIcon } from './SparkleIcon'

/** What a card needs to offer an AI launch: the action, whether one is running, and the two ways to start it. */
export type FixButtonProps = {
  action: 'fixCommitFailure' | 'fixPushFailure' | 'resolveConflicts'
  busy: boolean
  onFix(): void
  onCustomize(): void
}

type Copy = { label: string; primary: string; title: string; chevron: string }

const COPY: Readonly<Record<FixButtonProps['action'], Copy>> = {
  fixCommitFailure: {
    label: 'AI Fix',
    primary: 'Start the default AI agent to fix this commit failure',
    title: 'Fix commit failure with AI',
    chevron: 'Choose an agent for this commit failure'
  },
  fixPushFailure: {
    label: 'AI Fix',
    primary: 'Start the default AI agent to fix this push failure',
    title: 'Fix push failure with AI',
    chevron: 'Choose an agent for this push failure'
  },
  resolveConflicts: {
    label: 'Resolve with AI',
    primary: 'Start the default AI agent to resolve these conflicts',
    title: 'Resolve conflicts with AI',
    chevron: 'Choose an agent to resolve these conflicts'
  }
}

/** The AI launch button of a card: the primary starts the default agent, the chevron offers Customize launch... */
export function FixSplitButton({ action, busy, onFix, onCustomize }: FixButtonProps) {
  const copy = COPY[action]
  const chevron = useRef<HTMLButtonElement>(null)
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null)

  const openMenu = () => {
    const box = chevron.current?.getBoundingClientRect()
    setMenuAt({ x: box?.left ?? 0, y: box?.bottom ?? 0 })
  }

  return (
    <div className="scm-split scm-ai-fix">
      <button type="button" className="scm-ai-fix-primary" aria-label={copy.primary} title={copy.title} disabled={busy} onClick={onFix}>
        {busy ? <span className="scm-spinner" aria-hidden="true" /> : <SparkleIcon />}
        {copy.label}
      </button>
      <button
        ref={chevron}
        type="button"
        className="scm-ai-fix-chevron"
        aria-label={copy.chevron}
        title={copy.chevron}
        aria-haspopup="menu"
        disabled={busy}
        onClick={openMenu}
      >
        ▾
      </button>
      {menuAt && (
        <PopupMenu
          x={menuAt.x}
          y={menuAt.y}
          label={copy.chevron}
          items={[{ label: 'Customize launch...', onSelect: onCustomize }]}
          onClose={() => setMenuAt(null)}
        />
      )}
    </div>
  )
}
