import { Button, IconButton, Menu, StatusDot } from '@quirky/ui'
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

  return (
    <div className="ui-cluster" style={{ flexWrap: 'nowrap' }}>
      <Button type="button" variant="primary" aria-label={copy.primary} title={copy.title} disabled={busy} onClick={onFix} style={{ flexShrink: 0, whiteSpace: 'nowrap' }}>
        {busy ? <StatusDot status="working" /> : <SparkleIcon />}
        {copy.label}
      </Button>
      {busy ? (
        <IconButton label={copy.chevron} title={copy.chevron} disabled>
          <span aria-hidden="true">▾</span>
        </IconButton>
      ) : (
        <div title={copy.chevron}>
          <Menu
            label={copy.chevron}
            trigger="▾"
            items={[{ id: 'customize-launch', label: 'Customize launch...', onAction: onCustomize }]}
          />
        </div>
      )}
    </div>
  )
}
