import { useId, useState } from 'react'
import { Button, FormRow } from '@quirky/ui'
import { Dialog } from './Dialog'

type Props = {
  tabLabel: string
  onCancel: () => void
  /** `dontAskAgain` is whether the box was ticked. */
  onConfirm: (dontAskAgain: boolean) => void
}

function DontAsk({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  const id = useId()
  return (
    <div className="qt-check">
      <FormRow label={label} htmlFor={id}>
        <input id={id} type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      </FormRow>
    </div>
  )
}

/** Asks before closing a terminal that has a command or an agent still running. */
export function CloseRunningDialog({ agent, tabLabel, onCancel, onConfirm }: Props & { agent: boolean }) {
  const [dontAsk, setDontAsk] = useState(false)
  const title = agent ? 'Stop this agent?' : 'Stop running command?'
  return (
    <Dialog title={title} onClose={onCancel}>
      <p className="qt-dialog-text">{agent ? "Closing this terminal will stop the agent's current work." : 'Closing this terminal will stop the command running inside it.'}</p>
      {tabLabel ? <p className="qt-dialog-name">{tabLabel}</p> : null}
      <DontAsk label="Don't ask again for running terminals" checked={dontAsk} onChange={setDontAsk} />
      <div className="ui-dialog__actions qt-dialog-actions">
        <Button variant="secondary" autoFocus onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" variant="destructive" onClick={() => onConfirm(dontAsk)}>
          {agent ? 'Stop Agent' : 'Stop and Close'}
        </Button>
      </div>
    </Dialog>
  )
}

/** Asks before closing a pinned tab. */
export function ClosePinnedDialog({ tabLabel, onCancel, onConfirm }: Props) {
  const [dontAsk, setDontAsk] = useState(false)
  return (
    <Dialog title="Close pinned tab?" onClose={onCancel}>
      <p className="qt-dialog-text">This tab is pinned. Are you sure you want to close it?</p>
      {tabLabel ? <p className="qt-dialog-name">{tabLabel}</p> : null}
      <DontAsk label="Don't ask again for pinned tabs" checked={dontAsk} onChange={setDontAsk} />
      <div className="ui-dialog__actions qt-dialog-actions">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="destructive" autoFocus onClick={() => onConfirm(dontAsk)}>
          Close
        </Button>
      </div>
    </Dialog>
  )
}
