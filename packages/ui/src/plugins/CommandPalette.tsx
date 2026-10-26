import { useState } from 'react'
import { Dialog } from '../components/Dialog'
import { useConnection, usePluginHost, usePluginState } from '../context'
import { paletteKey } from './palette'

/** Filterable list of the commands in effect; Enter runs the highlighted one and closes. */
export function CommandPalette({ onClose }: { onClose: () => void }) {
  const host = usePluginHost()
  const connection = useConnection()
  usePluginState()
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState(0)
  const commands = host.paletteCommands(filter)
  const current = Math.min(selected, Math.max(commands.length - 1, 0))

  const run = (id: string) => {
    onClose()
    host.runCommand(id).catch((error) => connection.toastError('Command failed', error))
  }

  return (
    <Dialog title="Command palette" onClose={onClose}>
      <input
        autoFocus
        aria-label="Filter commands"
        placeholder="Type a command"
        value={filter}
        onChange={(event) => {
          setFilter(event.target.value)
          setSelected(0)
        }}
        onKeyDown={(event) => {
          const next = paletteKey(event.key, current, commands.length)
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') event.preventDefault()
          setSelected(next.selected)
          if (next.run) {
            event.preventDefault()
            run(commands[next.selected]!.id)
          }
        }}
      />
      {commands.length === 0 ? (
        <p className="muted pad">No matching commands.</p>
      ) : (
        <ul className="palette-list" role="listbox">
          {commands.map((command, index) => (
            <li key={command.id} role="option" aria-selected={index === current}>
              <button
                className={`palette-item${index === current ? ' selected' : ''}`}
                onMouseEnter={() => setSelected(index)}
                onClick={() => run(command.id)}
              >
                <span>{command.title}</span>
                {command.description && <span className="muted">{command.description}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  )
}
