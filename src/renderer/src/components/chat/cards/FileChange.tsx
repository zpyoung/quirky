import type { RenderItemOf } from '../chat-turns'
import { Card, Delta } from './Card'
import { countPatchLines } from './patch-lines'

/** An agent's edit of one file: the path with its line counts. */
export function FileChange({ item }: { item: RenderItemOf<'diff'> }): React.JSX.Element {
  const { path, patch } = item.body
  const counts = countPatchLines(patch.head, patch.truncated)
  return (
    <Card
      label="Edited"
      ariaLabel={`Edited ${path}`}
      header={
        <>
          <span className="min-w-0 truncate font-mono text-chat-code" title={path}>
            {path}
          </span>
          {counts && <Delta added={counts.added} removed={counts.removed} />}
        </>
      }
    />
  )
}
