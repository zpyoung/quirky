import { Button, StatusDot } from '@quirky/ui'
import type { AvatarUiProps } from '../contracts'
import { useAvatarQuery, type StatusResult } from './AvatarView'

const OPEN_REPORT_COMMAND = 'command:quirky.avatar/open-report'
const HANDOFF_COMMAND = 'command:quirky.avatar/handoff'

/**
 * The window-bar pill: `Avatar · N handed off`, amber as `Avatar · N need you` while the needs-you
 * queue has items. A click opens the report when something needs you, else the hand-off sheet. It
 * renders nothing while nothing is handed off and nothing waits.
 */
export default function Pill({ context }: AvatarUiProps) {
  const { data } = useAvatarQuery<StatusResult>(context, 'status')
  if (data === null) return null
  const handedOff = data.handoffs.length
  const needs = data.needsYouCount
  if (handedOff === 0 && needs === 0) return null
  const needsYou = needs > 0
  const command = needsYou ? OPEN_REPORT_COMMAND : HANDOFF_COMMAND
  return (
    <Button
      data-avatar-ui="pill"
      data-tone={needsYou ? 'needs-you' : 'handed-off'}
      onClick={() => void context.executeCommand(command).catch((error: unknown) => context.log(`avatar pill: ${error instanceof Error ? error.message : String(error)}`))}
    >
      <StatusDot status={needsYou ? 'needs-you' : 'working'} />
      {needsYou ? `Avatar · ${needs} need you` : `Avatar · ${handedOff} handed off`}
    </Button>
  )
}
