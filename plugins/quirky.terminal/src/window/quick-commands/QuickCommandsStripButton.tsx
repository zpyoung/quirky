import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import type { UiPluginContext } from '@quirky/protocol'
import { FLOATING_WORKSPACE, type Group, type QuickCommand } from '../../layout/types'
import { isQuickCommandComplete, pickStripCommand } from '../../quick-commands/normalize'
import { QuickCommandDialog } from './QuickCommandDialog'
import { searchQuickCommands } from './search'
import { CheckIcon, ChevronDownIcon, CopyIcon, PencilIcon, PlayIcon, TrashIcon, confirmAndRemove, runCommand, summaryOf, useQuickCommands } from './shared'
import { ensureQuickCommandStyles } from './styles'

type Props = {
  context: UiPluginContext
  /** The workspace the strip belongs to: a worktree ID or `floating`. */
  workspace: string
  group: Group
  /** The workspace's repo; null where there is none. */
  repo: string | null
}

type Dialog = { command: QuickCommand | null }

function runTitle(command: QuickCommand): string {
  return command.kind === 'agent' ? `Start ${command.agent}: ${command.command}` : `Run: ${command.command}`
}

/** Repo commands first, then global ones, each kept in saved order. */
function grouped(commands: readonly QuickCommand[]): QuickCommand[] {
  return [...commands.filter((entry) => entry.scope === 'repo'), ...commands.filter((entry) => entry.scope !== 'repo')]
}

/**
 * The tab strip's quick-command button. With commands it is a split button: the left half runs the
 * group's pick in a new tab of this group, the chevron opens the searchable list with copy, edit
 * and delete per row and `+ Command`. With none it is one Command button that opens the Add dialog.
 * Not drawn in the floating workspace, which has no repo to scope commands to.
 */
export function QuickCommandsStripButton({ context, workspace, group, repo }: Props) {
  useState(ensureQuickCommandStyles)
  const floating = workspace === FLOATING_WORKSPACE
  const { commands, loaded, refresh } = useQuickCommands(context, floating ? null : workspace)
  const [menuOpen, setMenuOpen] = useState(false)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const chevron = useRef<HTMLButtonElement>(null)

  const pick = useMemo(() => pickStripCommand(commands, repo, group.lastQuickCommand), [commands, repo, group.lastQuickCommand])

  if (floating || !loaded) return null

  const run = (command: QuickCommand) => void runCommand(context, { id: command.id, workspace, group: group.id })
  const openAdd = () => setDialog({ command: null })

  const dialogView = dialog ? <QuickCommandDialog key={dialog.command?.id ?? 'new'} context={context} command={dialog.command} repo={repo} onSaved={() => void refresh()} onClose={() => setDialog(null)} /> : null

  if (commands.length === 0) {
    return (
      <div className="qc-strip">
        <button type="button" className="qc-single" aria-label="Add quick command" title="Save a quick command for this repo" onClick={openAdd}>
          <PlayIcon size={13} />
          <span className="qc-run-label">Command</span>
        </button>
        {dialogView}
      </div>
    )
  }

  return (
    <div className="qc-strip">
      <div className="qc-split">
        <button
          type="button"
          data-qc-run=""
          disabled={pick === null}
          aria-label={pick ? `Run quick command: ${pick.label}` : 'Run quick command'}
          title={pick ? runTitle(pick) : 'Run quick command'}
          onClick={() => pick && run(pick)}
        >
          <PlayIcon />
          <span className="qc-run-label">{pick?.label ?? 'Run'}</span>
        </button>
        <button ref={chevron} type="button" className="qc-more" aria-label="More quick commands" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>
          <ChevronDownIcon size={12} />
        </button>
      </div>
      {menuOpen ? (
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
      ) : null}
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

const MENU_WIDTH = 320

function QuickCommandsMenu({ context, anchor, commands, preferred, onClose, onRun, onEdit, onDelete, onAdd }: MenuProps) {
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState<string | null>(preferred?.id ?? null)
  const [copied, setCopied] = useState<string | null>(null)
  const [place, setPlace] = useState({ left: 8, top: 0 })
  const menu = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)

  const shown = useMemo(() => grouped(searchQuickCommands(commands, query)), [commands, query])
  const active = shown.find((entry) => entry.id === highlight) ?? shown[0] ?? null
  const firstGlobal = shown.findIndex((entry) => entry.scope !== 'repo')

  useLayoutEffect(() => {
    const rect = anchor.current?.getBoundingClientRect()
    if (rect) setPlace({ left: Math.max(8, rect.right - MENU_WIDTH), top: rect.bottom + 6 })
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
    if (event.key === 'Enter' && active && isQuickCommandComplete(active)) {
      event.preventDefault()
      onRun(active)
    }
  }

  return createPortal(
    <div ref={menu} className="qc-menu" role="menu" style={{ left: place.left, top: place.top }} onKeyDown={onKeyDown}>
      <input
        ref={search}
        className="qc-menu-search"
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
                <span className="qc-label" style={{ display: 'block' }}>
                  {command.label}
                </span>
                <span className="qc-body">{summaryOf(command)}</span>
              </span>
              <span className="qc-actions" role="group" aria-label="Quick command actions">
                <button
                  type="button"
                  className="qc-icon-button"
                  aria-label={`Copy ${command.label}`}
                  title={copied === command.id ? 'Copied' : `Copy ${command.label}`}
                  disabled={command.command === ''}
                  onClick={(event) => {
                    event.stopPropagation()
                    void copy(command)
                  }}
                >
                  {copied === command.id ? <CheckIcon /> : <CopyIcon />}
                </button>
                <button
                  type="button"
                  className="qc-icon-button"
                  aria-label={`Edit ${command.label}`}
                  title={`Edit ${command.label}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    onEdit(command)
                  }}
                >
                  <PencilIcon />
                </button>
                <button
                  type="button"
                  className="qc-icon-button qc-danger"
                  aria-label={`Delete ${command.label}`}
                  title={`Delete ${command.label}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    onDelete(command)
                  }}
                >
                  <TrashIcon />
                </button>
              </span>
            </div>
          </div>
        ))}
      </div>
      <div className="qc-menu-footer">
        <button type="button" onClick={onAdd}>
          + Command
        </button>
      </div>
    </div>,
    document.body
  )
}
