import { Button, Dialog } from '@quirky/ui'

/** Tells the person a workspace was cut from a local branch because its remote base couldn't be fetched. */
export function BaseFallbackDialog({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <Dialog open title="Workspace created from a local base" onClose={onClose}>
      <p className="ui-text-muted">{message}</p>
      <div className="ui-actions">
        <Button type="button" variant="primary" autoFocus onClick={onClose}>
          Got it
        </Button>
      </div>
    </Dialog>
  )
}
