import { Dialog } from './Dialog'

/** Tells the person a workspace was cut from a local branch because its remote base couldn't be fetched. */
export function BaseFallbackDialog({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <Dialog title="Workspace created from a local base" onClose={onClose}>
      <p className="dialog-message">{message}</p>
      <div className="dialog-actions">
        <button type="button" className="primary" autoFocus onClick={onClose}>
          Got it
        </button>
      </div>
    </Dialog>
  )
}
