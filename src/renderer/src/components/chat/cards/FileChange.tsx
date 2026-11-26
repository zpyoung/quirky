import type { RenderItemOf } from '../chat-turns'
import { translate } from '@/i18n/i18n'
import { Card, Delta } from './Card'
import { countPatchLines } from './patch-lines'

/** An agent's edit of one file: the path with its line counts. */
export function FileChange({ item }: { item: RenderItemOf<'diff'> }): React.JSX.Element {
  const { path, patch } = item.body
  const counts = countPatchLines(patch.head, patch.truncated)
  return (
    <Card
      label={translate('components.chat.cards.editedLabel', 'Edited')}
      ariaLabel={translate('components.chat.cards.editedAria', 'Edited {{path}}', { path })}
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
