import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Button, IconButton } from '@quirky/ui'
import type { UiPluginContext } from '@quirky/protocol'
import { FLOATING_WORKSPACE, type Group, type QuickCommand } from '../../layout/types'
import { isQuickCommandComplete, pickStripCommand } from '../../quick-commands/normalize'
import { QuickCommandDialog } from './QuickCommandDialog'
import { repoFirst, searchQuickCommands } from './search'
import { CheckIcon, ChevronDownIcon, CopyIcon, PencilIcon, PlayIcon, TrashIcon, confirmAndRemove, runCommand, summaryOf, useQuickCommands } from './shared'

type Props = {
  context: UiPluginContext
  /** The workspace the strip belongs to: a worktree ID or `floating`. */
  workspace: string
  group: Group
  /** The workspace's repo; null where there is none. */
  repo: string | null
  /** Whether the menu is open, when the owner keeps that state (so a window command can open it); the button keeps it itself when omitted. */
  menuOpen?: boolean
  onMenuOpenChange?(open: boolean): void
}

type Dialog = { command: QuickCommand | null }

function runTitle(command: QuickCommand): string {
  return command.kind === 'agent' ? `Start ${command.agent}: ${command.command}` : `Run: ${command.command}`
}

/**
 * The tab strip's quick-command button. With commands it is a split button: the left half runs the
 * group's pick in a new tab of this group, the chevron opens the searchable list with copy, edit
 * and delete per row and `+ Command`. With none it is one Command button that opens the Add dialog
 * (a window command can still open the menu there, anchored to that button).
 * Not drawn in the floating workspace, which has no repo to scope commands to.
 */
export function QuickCommandsStripButton({ context, workspace, group, repo, menuOpen: controlledOpen, onMenuOpenChange }: Props) {
  const floating = workspace === FLOATING_WORKSPACE
  const { commands, loaded, refresh } = useQuickCommands(context, floating ? null : workspace)
  const [ownOpen, setOwnOpen] = useState(false)
  const menuOpen = controlledOpen ?? ownOpen
  const setMenuOpen = onMenuOpenChange ?? setOwnOpen
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const chevron = useRef<HTMLButtonElement>(null)

  // a strip that goes away (its group closed) must not leave the owner believing its menu is open
  const latest = useRef({ menuOpen, setMenuOpen })
  latest.current = { menuOpen, setMenuOpen }
  useEffect(() => () => {
    if (latest.current.menuOpen) latest.current.setMenuOpen(false)
  }, [])

  const pick = useMemo(() => pickStripCommand(commands, repo, group.lastQuickCommand), [commands, repo, group.lastQuickCommand])

  if (floating || !loaded) return null

  const run = (command: QuickCommand) => void runCommand(context, { id: command.id, workspace, group: group.id })
  const openAdd = () => setDialog({ command: null })

  const dialogView = dialog ? <QuickCommandDialog key={dialog.command?.id ?? 'new'} context={context} command={dialog.command} repo={repo} onSaved={() => void refresh()} onClose={() => setDialog(null)} /> : null

  const menuView = menuOpen ? (
    <QuickCommandsMenu
      context={context}
      anchor={chevron}
      commands={commands}
      preferred={pick}
      onClose={() => setMenuOpen(false)}
      onRun={(command) => {
        setMenuOpen(false)
        run(command)
      }}
      onEdit={(command) => {
        setMenuOpen(false)
        setDialog({ command })
      }}
      onDelete={(command) => {
        setMenuOpen(false)
        void confirmAndRemove(context, command).then(refresh)
      }}
      onAdd={() => {
        setMenuOpen(false)
        openAdd()
      }}
    />
  ) : null

  if (commands.length === 0) {
    return (
      <div className="qc-strip">
        <button ref={chevron} type="button" className="ui-button ui-button--secondary qc-single" aria-label="Add quick command" title="Save a quick command for this repo"
          onClick={() => {
            setMenuOpen(false)
            openAdd()
          }}
        >
          <span className="ui-icon-button__icon"><PlayIcon size={13} /></span>
          <span className="qc-run-label">Command</span>
        </button>
        {menuView}
        {dialogView}
      </div>
    )
  }

  return (
    <div className="qc-strip">
      <div className="qc-split">
        <Button
          type="button"
          className="qc-run"
          data-qc-run=""
          disabled={pick === null}
          aria-label={pick ? `Run quick command: ${pick.label}` : 'Run quick command'}
          title={pick ? runTitle(pick) : 'Run quick command'}
          onClick={() => pick && run(pick)}
        >
          <PlayIcon />
          <span className="qc-run-label">{pick?.label ?? 'Run'}</span>
        </Button>
        <button
          ref={chevron}
          type="button"
          className="ui-button ui-button--secondary ui-icon-button qc-more"
          aria-label="More quick commands"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen(!menuOpen)}
        >
          <span className="ui-icon-button__icon"><ChevronDownIcon size={12} /></span>
        </button>
      </div>
      {menuView}
      {dialogView}
    </div>
  )
}

type MenuProps = {
  context: UiPluginContext
  anchor: React.RefObject<HTMLButtonElement | null>
  commands: QuickCommand[]
  preferred: QuickCommand | null
  onClose(): void
  onRun(command: QuickCommand): void
  onEdit(command: QuickCommand): void
  onDelete(command: QuickCommand): void
  onAdd(): void
}


function QuickCommandsMenu({ context, anchor, commands, preferred, onClose, onRun, onEdit, onDelete, onAdd }: MenuProps) {
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState<string | null>(preferred?.id ?? null)
  const [copied, setCopied] = useState<string | null>(null)
  const [place, setPlace] = useState({ left: 8, top: 0 })
  const menu = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)

  const shown = useMemo(() => repoFirst(searchQuickCommands(commands, query)), [commands, query])
  const active = shown.find((entry) => entry.id === highlight) ?? shown[0] ?? null
  const firstGlobal = shown.findIndex((entry) => entry.scope !== 'repo')

  useLayoutEffect(() => {
    const rect = anchor.current?.getBoundingClientRect()
    if (rect) {
      const width = menu.current?.getBoundingClientRect().width ?? 0
      setPlace({ left: Math.max(8, rect.right - width), top: rect.bottom + 6 })
    }
  }, [anchor])

  useEffect(() => {
    search.current?.focus()
    const outside = (event: MouseEvent) => {
      const target = event.target as Node
      if (!menu.current?.contains(target) && !anchor.current?.contains(target)) onClose()
    }
    document.addEventListener('mousedown', outside, true)
    return () => document.removeEventListener('mousedown', outside, true)
  }, [anchor, onClose])

  useEffect(() => {
    if (copied === null) return
    const timer = setTimeout(() => setCopied(null), 1500)
    return () => clearTimeout(timer)
  }, [copied])

  const copy = async (command: QuickCommand) => {
    try {
      await navigator.clipboard.writeText(command.command)
      setCopied(command.id)
    } catch {
      context.toast("Couldn't copy", command.label)
    }
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (shown.length === 0) return
      const at = Math.max(0, shown.findIndex((entry) => entry.id === active?.id))
      const next = (at + (event.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length
      setHighlight(shown[next]!.id)
      return
    }
    // enter on a row action or the footer button must activate that button, not run the highlighted row
    if (event.key === 'Enter' && event.target === search.current && active && isQuickCommandComplete(active)) {
      event.preventDefault()
      onRun(active)
    }
  }

  return createPortal(
    <div ref={menu} className="qc-menu" role="menu" style={{ left: place.left, top: place.top }} onKeyDown={onKeyDown}>
      <input
        ref={search}
        className="ui-text-field__input qc-menu-search"
        type="search"
        placeholder="Search quick commands..."
        aria-label="Search quick commands"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value)
          setHighlight(null)
        }}
      />
      <div className="qc-menu-list">
        {shown.length === 0 ? <div className="qc-menu-empty">{query.trim() ? 'No commands match' : 'No commands'}</div> : null}
        {shown.map((command, index) => (
          <div key={command.id}>
            {index === firstGlobal && index > 0 ? <div className="qc-menu-separator" /> : null}
            <div
              className="qc-menu-item"
              role="menuitem"
              data-command={command.id}
              aria-selected={command.id === active?.id}
              aria-disabled={!isQuickCommandComplete(command)}
              onMouseMove={() => setHighlight(command.id)}
              onClick={() => isQuickCommandComplete(command) && onRun(command)}
            >
              <PlayIcon />
              <span className="qc-row-main">
                <span className="qc-label">{command.label}</span>
                <span className="qc-body">{summaryOf(command)}</span>
              </span>
              <span className="qc-actions" role="group" aria-label="Quick command actions">
                <IconButton
                  label={`Copy ${command.label}`}
                  title={copied === command.id ? 'Copied' : `Copy ${command.label}`}
                  disabled={command.command === ''}
                  onClick={(event) => {
                    event.stopPropagation()
                    void copy(command)
                  }}
                >
                  {copied === command.id ? <CheckIcon /> : <CopyIcon />}
                </IconButton>
                <IconButton
                  label={`Edit ${command.label}`}
                  title={`Edit ${command.label}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    onEdit(command)
                  }}
                >
                  <PencilIcon />
                </IconButton>
                <IconButton
                  label={`Delete ${command.label}`}
                  title={`Delete ${command.label}`}
                  variant="destructive"
                  onClick={(event) => {
                    event.stopPropagation()
                    onDelete(command)
                  }}
                >
                  <TrashIcon />
                </IconButton>
              </span>
            </div>
          </div>
        ))}
      </div>
      <div className="qc-menu-footer">
        <Button type="button" onClick={onAdd}>
          + Command
        </Button>
      </div>
    </div>,
    document.body
  )
}
