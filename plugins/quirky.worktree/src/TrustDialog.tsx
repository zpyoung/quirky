import { Dialog } from './Dialog'
import type { TrustChoice, TrustRequest } from './actions'

type Props = {
  request: TrustRequest
  /** The project's label, for the title. */
  project: string
  onChoose(choice: TrustChoice): void
}

/** Asks whether a shared setup script that is not trusted yet (or changed since it was) may run. */
export function TrustDialog({ request, project, onChoose }: Props) {
  const title = request.changed ? `${project}'s setup changed — run the new version?` : `Run setup from ${project}?`
  return (
    <Dialog title={title} onClose={() => onChoose('cancel')}>
      <p className="dialog-message">
        {request.changed
          ? 'The shared setup script changed since you last trusted it. It will run in the new workspace.'
          : 'This project shares a setup script. It will run in the new workspace.'}
      </p>
      <pre className="script-preview">{request.script}</pre>
      <div className="dialog-actions">
        <button type="button" onClick={() => onChoose('skip')}>
          Don't run
        </button>
        <button type="button" onClick={() => onChoose('always')}>
          Always trust
        </button>
        <button type="button" className="primary" onClick={() => onChoose('run')}>
          Run hooks
        </button>
      </div>
    </Dialog>
  )
}
