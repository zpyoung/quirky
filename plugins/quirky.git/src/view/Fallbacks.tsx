import type { GitDiff } from '@quirky/protocol'
import { LIMITS_TEXT, reasonText, type TooLarge } from './limits'

/** The notice for a diff whose load failed; git's message is shown as-is. */
export function ErrorNotice({ message, subject = 'diff' }: { message: string; subject?: string }) {
  return (
    <p className="qgv-error" role="alert">
      Error loading {subject}: {message}
    </p>
  )
}

/** The fallback for a text diff past the display limits: the counts, the reason and the limits. */
export function TooLargeNotice({ tooLarge }: { tooLarge: TooLarge }) {
  return (
    <div className="qgv-notice qgv-too-large">
      <strong>This diff is too large to display safely.</strong>
      <dl>
        <dt>Original lines</dt>
        <dd>{tooLarge.originalLines.toLocaleString('en-US')}</dd>
        <dt>Modified lines</dt>
        <dd>{tooLarge.modifiedLines.toLocaleString('en-US')}</dd>
        <dt>Characters</dt>
        <dd>{tooLarge.characters.toLocaleString('en-US')}</dd>
      </dl>
      <p>{reasonText(tooLarge.reason)}</p>
      <p className="qgv-muted">{LIMITS_TEXT}</p>
    </div>
  )
}

/** The fallback for a file git treats as binary, which has no text diff. */
export function BinaryNotice() {
  return (
    <div className="qgv-notice">
      <strong>Binary file changed</strong>
      <p>Text diff is unavailable for this file.</p>
    </div>
  )
}

function ImageSide({ label, data, mime }: { label: string; data: string; mime: string | undefined }) {
  const previewable = data !== '' && mime !== undefined && mime.startsWith('image/')
  return (
    <figure className="qgv-image-side">
      <figcaption>{label}</figcaption>
      {previewable ? <img alt={label} src={`data:${mime};base64,${data}`} /> : <span className="qgv-muted">No preview</span>}
    </figure>
  )
}

/** Both sides of an image diff, each as a pane; a side that does not exist says "No preview". */
export function ImagePanes({ diff }: { diff: GitDiff }) {
  return (
    <div className="qgv-images">
      <ImageSide label="Original" data={diff.original} mime={diff.mime} />
      <ImageSide label="Modified" data={diff.modified} mime={diff.mime} />
    </div>
  )
}
