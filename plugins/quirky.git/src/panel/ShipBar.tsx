import type { ReactNode, RefObject } from 'react'
import { ControlIcon, FormRow, IconButton, InlineError, SplitButton } from '@quirky/ui'
import type { ContextMenuItem } from '@quirky/ui'
import type { UiPluginContext } from '@quirky/protocol'
import { SendMenu } from '../notes/SendMenu'
import { useNotes } from '../notes/useNotes'
import { messageRows } from './format'
import type { ShipMenuId, ShipMenuItem, ShipStep } from './ship'

/** What the error line says and the one action that goes with it. */
export type ShipErrorView = {
  message: string
  action?: { label: string; onAction(): void }
  /** More controls beside the line, such as the AI fix button. */
  extra?: ReactNode
}

type Props = {
  context: UiPluginContext
  worktree: string
  step: ShipStep
  /** A step is running: the button shows it and cannot be pressed again. */
  busy: boolean
  onStep(): void
  /** The panel owns the menu so it outlives changes of step. */
  menuOpen: boolean
  onOpenMenu(anchor: { x: number; y: number }): void
  /** The message field shows while there is something to commit. */
  showMessage: boolean
  message: string
  onMessage(text: string): void
  messageRef: RefObject<HTMLTextAreaElement | null>
  /** The message box is locked while a commit runs. */
  locked: boolean
  /** The ✦ at the right end of the message field, when Source Control AI actions are on. */
  sparkle?: ReactNode
  /** The agent that wrote the message in the box, until the message is edited. */
  writtenBy: string | null
  error: ShipErrorView | null
  onDismissError(): void
  /** Commit selected files is on, so the rows carry checkboxes. */
  selecting: boolean
  /** Status lines for the push destination and the like, just above the ship button. */
  aside?: ReactNode
}

export const CARET_LABEL = 'More commit and remote actions'

/** The caret's menu entries; choosing one passes its id to the panel. */
export const shipMenuEntries = (items: readonly ShipMenuItem[], onChoose: (id: ShipMenuId) => void): ContextMenuItem[] =>
  items.map((item) => ({
    id: item.id,
    label: item.label,
    enabled: item.enabled,
    ...(item.detail === undefined ? {} : { detail: item.detail }),
    ...(item.separatorBefore ? { separatorBefore: true } : {}),
    ...(item.danger ? { danger: true } : {}),
    onSelect: () => onChoose(item.id)
  }))

/** The quiet status line of a branch with nothing left to do, with the caret beside it. */
function QuietStep({ step, menuOpen, onOpenMenu }: Pick<Props, 'step' | 'menuOpen' | 'onOpenMenu'>) {
  return (
    <div className="ui-cluster git-ship__quiet">
      <p className="ui-text-muted" role="status" title={step.reason} data-git-up-to-date>{step.label}</p>
      <IconButton
        label={CARET_LABEL}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={(event) => {
          const box = event.currentTarget.getBoundingClientRect()
          onOpenMenu({ x: box.right, y: box.bottom })
        }}
      >
        <ControlIcon name="caret-down" />
      </IconButton>
    </div>
  )
}

/** The error line on its own, for the conflict card that takes the ship bar's place. */
export function ShipErrorLine({ error, onDismiss }: { error: ShipErrorView; onDismiss(): void }) {
  return (
    <div className="ui-stack git-ship__error" title={error.message}>
      <InlineError message={error.message} action={error.action} onDismiss={onDismiss} />
      {error.extra}
    </div>
  )
}

/**
 * The area pinned to the bottom of the panel, top to bottom: "Send N notes to agent", the
 * message field with ✦ at its right end, the error line, and the ship button with its caret.
 * The panel owns the menu and what each step does, so the menu survives a change of step.
 */
export function ShipBar(props: Props) {
  const { context, worktree, step, busy, onStep, menuOpen, onOpenMenu, showMessage, message, onMessage, messageRef, locked, sparkle, writtenBy, error, onDismissError, selecting, aside } = props
  const notes = useNotes(context, worktree)
  const noteLabel = `Send ${notes.length} ${notes.length === 1 ? 'note' : 'notes'} to agent`
  return (
    <div className="ui-stack git-ship" data-git-ship-bar>
      {notes.length > 0 && (
        <div className="ui-cluster git-ship__notes" data-git-send-notes>
          <SendMenu
            context={context}
            worktree={worktree}
            respondToRequest
            ariaLabel={noteLabel}
            scopes={[{ id: 'all', label: 'All unsent notes', notes, params: { scope: 'all' } }]}
          >
            {`${noteLabel} ▾`}
          </SendMenu>
        </div>
      )}
      {showMessage && (
        <FormRow label="Commit message" htmlFor="source-control-commit-message">
          <div className="git-ship__field">
            <textarea
              id="source-control-commit-message"
              ref={messageRef}
              className="ui-text-field__input"
              rows={messageRows(message)}
              value={message}
              placeholder="Message"
              autoCapitalize="off"
              autoCorrect="off"
              aria-label="Commit message"
              disabled={locked}
              onChange={(event) => onMessage(event.target.value)}
            />
            {sparkle}
          </div>
          {writtenBy !== null && <small className="ui-text-muted" data-git-written-by>{`Written by ${writtenBy}`}</small>}
        </FormRow>
      )}
      {selecting && <small className="ui-text-muted">Untick the files to leave out. Escape cancels.</small>}
      {error && <ShipErrorLine error={error} onDismiss={onDismissError} />}
      {aside}
      {step.kind === 'up-to-date' ? (
        <QuietStep step={step} menuOpen={menuOpen} onOpenMenu={onOpenMenu} />
      ) : (
        <SplitButton
          label={step.label}
          onClick={onStep}
          disabled={!step.enabled}
          busy={busy}
          title={step.reason}
          menuLabel={CARET_LABEL}
          menuOpen={menuOpen}
          onOpenMenu={onOpenMenu}
        />
      )}
    </div>
  )
}
