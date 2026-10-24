import { useState, type FormEvent } from 'react'
import { useAppState, useConnection, useDispatch } from '../context'
import {
  SCROLLBACK_MAX,
  SCROLLBACK_MIN,
  toSettingsPatch,
  type SettingsDraft
} from '../lib/settingsForm'
import { Dialog } from './Dialog'

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const { settings } = useAppState()
  const connection = useConnection()
  const dispatch = useDispatch()
  const [draft, setDraft] = useState<SettingsDraft>({
    worktreesRoot: settings?.worktreesRoot ?? '',
    terminalScrollback: String(settings?.terminalScrollback ?? 2000),
    notifications: settings?.notifications ?? true
  })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const result = toSettingsPatch(draft)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setError(null)
    setBusy(true)
    const saved = await connection.attempt('settings.set', result.patch, 'Could not save settings')
    setBusy(false)
    if (!saved) return
    dispatch({ type: 'settings', settings: saved })
    onClose()
  }

  return (
    <Dialog title="Settings" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>
          Worktrees folder
          <input
            autoFocus
            value={draft.worktreesRoot}
            onChange={(event) => setDraft({ ...draft, worktreesRoot: event.target.value })}
          />
        </label>
        <label>
          Terminal scrollback (lines)
          <input
            type="number"
            min={SCROLLBACK_MIN}
            max={SCROLLBACK_MAX}
            value={draft.terminalScrollback}
            onChange={(event) => setDraft({ ...draft, terminalScrollback: event.target.value })}
          />
        </label>
        <label className="check-row">
          <input
            type="checkbox"
            checked={draft.notifications}
            onChange={(event) => setDraft({ ...draft, notifications: event.target.checked })}
          />
          Notifications
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy}>
            Save
          </button>
        </div>
      </form>
    </Dialog>
  )
}
