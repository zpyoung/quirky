import { useState } from 'react'
import { Dialog } from './Dialog'

type Props = {
  tabLabel: string
  onCancel: () => void
  /** `dontAskAgain` is whether the box was ticked. */
  onConfirm: (dontAskAgain: boolean) => void
}

function DontAsk({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="qt-check">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>{label}</span>
    </label>
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
      <div className="qt-dialog-actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="qt-primary qt-danger" autoFocus onClick={() => onConfirm(dontAsk)}>
          {agent ? 'Stop Agent' : 'Stop and Close'}
        </button>
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
      <div className="qt-dialog-actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="qt-primary qt-danger" autoFocus onClick={() => onConfirm(dontAsk)}>
          Close
        </button>
      </div>
    </Dialog>
  )
}
