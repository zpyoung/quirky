import { Dialog } from './Dialog'
import type { TrustChoice, TrustRequest } from './actions'

type Props = {
  request: TrustRequest
  /** The project's label, for the title. */
  project: string
  onChoose(choice: TrustChoice): void
}

/** Asks whether an untrusted or changed shared setup/issue command may run. */
export function TrustDialog({ request, project, onChoose }: Props) {
  const issueCommand = request.kind === 'issue'
  const title = issueCommand
    ? request.changed ? `${project}'s issue command changed — run the new version?` : `Run issue command from ${project}?`
    : request.changed ? `${project}'s setup changed — run the new version?` : `Run setup from ${project}?`
  const description = issueCommand
    ? request.changed
      ? 'The shared issue command changed since you last trusted it. It will run in the new workspace.'
      : 'This project shares an issue command. It will run in the new workspace.'
    : request.changed
      ? 'The shared setup script changed since you last trusted it. It will run in the new workspace.'
      : 'This project shares a setup script. It will run in the new workspace.'
  return (
    <Dialog title={title} onClose={() => onChoose('cancel')}>
      <p className="dialog-message">{description}</p>
      <pre className="script-preview">{request.script}</pre>
      <div className="dialog-actions">
        <button type="button" onClick={() => onChoose('skip')}>
          {issueCommand ? 'Don’t run issue command' : "Don't run"}
        </button>
        <button type="button" onClick={() => onChoose('always')}>
          Always trust
        </button>
        <button type="button" className="primary" onClick={() => onChoose('run')}>
          {issueCommand ? 'Run issue command' : 'Run hooks'}
        </button>
      </div>
    </Dialog>
  )
}
