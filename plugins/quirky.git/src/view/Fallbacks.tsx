import type { GitDiff } from '@quirky/protocol'
import { Badge, EmptyState, ListRow, StatusDot } from '@quirky/ui'

import { LIMITS_TEXT, reasonText, type TooLarge } from './limits'

/** The notice for a diff whose load failed; git's message is shown as-is. */
export function ErrorNotice({ message, subject = 'diff' }: { message: string; subject?: string }) {
  return (
    <div role="alert">
      <EmptyState message={`Error loading ${subject}: ${message}`} icon={<StatusDot status="failing" />} />
    </div>
  )
}

/** The fallback for a text diff past the display limits: the counts, the reason and the limits. */
export function TooLargeNotice({ tooLarge }: { tooLarge: TooLarge }) {
  return (
    <section className="ui-stack" role="status" aria-label="This diff is too large to display safely." style={{ padding: 'var(--ui-space-12)' }}>
      <Badge tone="needs-you">This diff is too large to display safely.</Badge>
      <ListRow title="Original lines" trailing={<Badge>{tooLarge.originalLines.toLocaleString('en-US')}</Badge>} />
      <ListRow title="Modified lines" trailing={<Badge>{tooLarge.modifiedLines.toLocaleString('en-US')}</Badge>} />
      <ListRow title="Characters" trailing={<Badge>{tooLarge.characters.toLocaleString('en-US')}</Badge>} />
      <p>{reasonText(tooLarge.reason)}</p>
      <p className="ui-text-muted">{LIMITS_TEXT}</p>
    </section>
  )
}

/** Shown above a text diff whose sides match, such as an open diff of a change since committed. */
export function NoChangesNotice() {
  return (
    <p className="ui-text-muted" role="status" style={{ padding: 'var(--ui-space-8) var(--ui-space-12)' }}>
      No changes in this file.
    </p>
  )
}

/** The fallback for a file git treats as binary, which has no text diff. */
export function BinaryNotice() {
  return (
    <section className="ui-stack" role="status" aria-label="Binary file changed" style={{ padding: 'var(--ui-space-12)' }}>
      <Badge>Binary file changed</Badge>
      <p>Text diff is unavailable for this file.</p>
    </section>
  )
}

function ImageSide({ label, data, mime }: { label: string; data: string; mime: string | undefined }) {
  const previewable = data !== '' && mime !== undefined && mime.startsWith('image/')
  return (
    <figure className="ui-stack" style={{ flex: '1 1 0%', minWidth: 0, overflow: 'auto' }}>
      <figcaption>{label}</figcaption>
      {previewable ? (
        <img alt={label} src={`data:${mime};base64,${data}`} style={{ maxWidth: '100%', height: 'auto' }} />
      ) : (
        <span className="ui-text-muted">No preview</span>
      )}
    </figure>
  )
}

/** Both sides of an image diff, each as a pane; a side that does not exist says "No preview". */
export function ImagePanes({ diff }: { diff: GitDiff }) {
  return (
    <div className="ui-cluster" role="group" aria-label="Image diff" style={{ alignItems: 'stretch', flexWrap: 'nowrap', minHeight: 0, minWidth: 0, overflow: 'auto' }}>
      <ImageSide label="Original" data={diff.original} mime={diff.mime} />
      <ImageSide label="Modified" data={diff.modified} mime={diff.mime} />
    </div>
  )
}
