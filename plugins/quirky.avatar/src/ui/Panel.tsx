import { useState } from 'react'
import { Button, EmptyState, ListRow, SectionHeader, ToolPanelFrame } from '@quirky/ui'
import type { AvatarUiProps } from '../contracts'
import { levelLabel, messageOf, stateLabel, uiStatusOf, useAvatarQuery, type StatusResult } from './AvatarView'

const HANDOFF_COMMAND = 'command:quirky.avatar/handoff'
const OPEN_REPORT_COMMAND = 'command:quirky.avatar/open-report'

/**
 * The side panel: one row per handed-off worktree with its state and level and a Take back
 * button, plus Hand off… and Take back all. Take back all asks first.
 */
export default function Panel({ context }: AvatarUiProps) {
  const { data, error, refresh } = useAvatarQuery<StatusResult>(context, 'status')
  const [failure, setFailure] = useState<string | null>(null)

  const takeBack = async (selection: { worktreeIds: string[] } | { all: true }) => {
    setFailure(null)
    try {
      await context.call('quirky.avatar/takeBack', selection)
    } catch (cause) {
      setFailure(messageOf(cause))
    }
    refresh()
  }

  const takeBackAll = async () => {
    const confirmed = await context.confirm({
      title: 'Take back all worktrees?',
      body: 'The avatar stops deciding for them and their agents keep running. Open needs are closed as handed back.',
      confirmLabel: 'Take back all'
    })
    if (confirmed) await takeBack({ all: true })
  }

  const run = (command: string) =>
    void context.executeCommand(command).catch((cause: unknown) => setFailure(messageOf(cause)))

  const handoffs = data?.handoffs ?? []
  const needs = data?.needsYouCount ?? 0
  return (
    <ToolPanelFrame title="Avatar">
      <div data-avatar-ui="panel">
        <SectionHeader
          title="Handed off"
          actions={
            <>
              <Button onClick={() => run(HANDOFF_COMMAND)}>Hand off…</Button>
              <Button disabled={handoffs.length === 0} onClick={() => void takeBackAll()}>Take back all</Button>
            </>
          }
        />
        {(error !== null || failure !== null) && <p role="alert">{failure ?? error}</p>}
        {needs > 0 && <Button variant="primary" onClick={() => run(OPEN_REPORT_COMMAND)}>{`Open report · ${needs} need you`}</Button>}
        {handoffs.length === 0 ? (
          <EmptyState message="Nothing handed off." />
        ) : (
          handoffs.map((handoff) => (
            <ListRow
              key={handoff.worktreeId}
              title={handoff.name}
              description={`${stateLabel(handoff.state)} · ${levelLabel(handoff.level)}`}
              status={uiStatusOf(handoff.state)}
              trailing={
                <Button aria-label={`Take back ${handoff.name}`} onClick={() => void takeBack({ worktreeIds: [handoff.worktreeId] })}>
                  Take back
                </Button>
              }
            />
          ))
        )}
      </div>
    </ToolPanelFrame>
  )
}
