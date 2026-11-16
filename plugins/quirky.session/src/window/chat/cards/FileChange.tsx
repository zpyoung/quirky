import type { FileChangeItem } from '../turns'
import { callStateLabel, Card, CallDot, Delta, grow, mono } from './Card'

/** An agent's edit of one file: the path with its line counts, and the call's state while it is not done. */
export function FileChange({ item }: { item: FileChangeItem }) {
  const verb = item.state === 'running' ? 'Editing' : 'Edited'
  return (
    <Card
      label={verb}
      ariaLabel={`${verb} ${item.path}`}
      tone={item.state === 'failed' ? 'failing' : 'neutral'}
      header={
        <>
          <span style={mono}>{item.path}</span>
          <Delta added={item.added} removed={item.removed} />
          <span style={grow} />
          {item.state !== 'done' && (
            <>
              <CallDot state={item.state} />
              <span>{callStateLabel[item.state]}</span>
            </>
          )}
        </>
      }
    />
  )
}
