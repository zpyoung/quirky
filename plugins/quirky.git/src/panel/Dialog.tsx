import { Button, Dialog } from '@quirky/ui'

type ConfirmProps = {
  title: string
  body: string
  confirm: string
  /** Styles the confirm button as destructive. */
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/** A question with Cancel and a focused shared modal dialog. */
export function ConfirmDialog({ title, body, confirm, danger, onConfirm, onCancel }: ConfirmProps) {
  return (
    <Dialog
      open
      title={title}
      onClose={onCancel}
      actions={
        <div className="ui-cluster" style={{ justifyContent: 'flex-end' }}>
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant={danger ? 'destructive' : 'primary'} onClick={onConfirm}>{confirm}</Button>
        </div>
      }
    >
      {body !== '' && <p>{body}</p>}
    </Dialog>
  )
}
