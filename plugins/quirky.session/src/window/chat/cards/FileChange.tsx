import type { FileChangeItem } from '../turns'
import { callStateLabel, Card, CallDot, Delta, grow, mono } from './Card'

/** `path` relative to `root` when it lies inside it, else unchanged. */
export function displayPath(path: string, root: string): string {
  const base = root.replace(/\/+$/, '')
  return base !== '' && path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path
}

/** An agent's edit of one file: the path with its line counts, and the call's state while it is not done. */
export function FileChange({ item, root }: { item: FileChangeItem; root: string }) {
  const shown = displayPath(item.path, root)
  const verb = item.state === 'running' ? 'Editing' : 'Edited'
  return (
    <Card
      label={verb}
      ariaLabel={`${verb} ${shown}`}
      tone={item.state === 'failed' ? 'failing' : 'neutral'}
      header={
        <>
          <span style={mono} title={item.path}>{shown}</span>
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
