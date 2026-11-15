import { useEffect } from 'react'
import { ContextMenu } from '@quirky/ui'
import { displayTitle } from '../../layout/titles'
import { ClosePinnedDialog, CloseRunningDialog } from './CloseDialogs'
import type { ControllerState, DialogState, WorkspaceController } from './controller'
import { PromptDialog } from './PromptDialog'
import { locateTab } from './model'
import { runWorkspaceViewAction } from './view-actions'

function PlusSearch({ controller, query }: { controller: WorkspaceController; query: string }) {
  return (
    <input
      className="ui-text-field__input qt-menu-search"
      autoFocus
      autoCapitalize="off"
      autoCorrect="off"
      spellCheck={false}
      aria-label="Search open tabs and agents…"
      placeholder="Search open tabs and agents…"
      value={query}
      onChange={(event) => controller.setMenuQuery(event.target.value)}
    />
  )
}

/** The open menu, placed where it was opened. */
export function MenuLayer({ controller, state }: { controller: WorkspaceController; state: ControllerState }) {
  const menu = state.menu
  if (!menu) return null
  const plus = menu.kind === 'plus'
  const onClose = () => void runWorkspaceViewAction(controller.context, { workspace: controller.workspaceId, action: 'close-menu' })
  return (
    <ContextMenu
      key={`${menu.kind}:${menu.target}`}
      items={controller.menuItems()}
      label={menu.kind === 'plus' ? 'New tab' : `${menu.kind} menu`}
      x={menu.x}
      y={menu.y}
      onClose={onClose}
      header={plus ? <PlusSearch controller={controller} query={menu.query} /> : undefined}
      highlightFirst={plus}
    />
  )
}

/** The Ctrl+Tab list: Tab or the arrow keys move, releasing Ctrl activates, Escape cancels. */
function Switcher({ controller, dialog }: { controller: WorkspaceController; dialog: Extract<DialogState, { kind: 'switch-tabs' }> }) {
  const ws = controller.getSnapshot().workspace
  const { generation } = dialog
  const workspace = controller.workspaceId
  const onCancel = () => void runWorkspaceViewAction(controller.context, { workspace, action: 'cancel-dialog', kind: 'switch-tabs', generation })
  const onActivate = (tab?: string) => void runWorkspaceViewAction(controller.context, { workspace, action: 'activate-switcher', kind: 'switch-tabs', generation, ...(tab === undefined ? {} : { tab }) })
  const preview = (index: number) => {
    if (controller.getSnapshot().dialog?.generation === generation) controller.setSwitcherIndex(index)
  }
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (controller.getSnapshot().dialog?.generation !== generation) return
      if (event.key === 'Tab' && !event.ctrlKey) {
        event.preventDefault()
        controller.stepSwitcher(event.shiftKey ? -1 : 1)
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        controller.stepSwitcher(event.key === 'ArrowDown' ? 1 : -1)
      } else if (event.key === 'Enter') {
        event.preventDefault()
        onActivate()
      } else if (event.key === 'Escape') {
        event.preventDefault()
        onCancel()
      }
    }
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Control') onActivate()
    }
    const onBlur = onCancel
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [controller, generation])

  return (
    <div className="qt-overlay" onMouseDown={onCancel}>
      <div className="qt-dialog qt-switcher" role="dialog" aria-label={dialog.title} onMouseDown={(event) => event.stopPropagation()}>
        <h2>{dialog.title}</h2>
        <ul role="listbox" aria-label="Tabs">
          {dialog.order.map((id, position) => {
            const loc = ws ? locateTab(ws, id) : null
            return (
              <li key={id} role="option" aria-selected={position === dialog.index} data-tab-option={id} className={position === dialog.index ? 'qt-highlight' : undefined} onMouseEnter={() => preview(position)} onClick={() => onActivate(id)}>
                {loc ? displayTitle(loc.tab) : id}
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}

/** The dialog the controller has open, if any. */
export function DialogLayer({ controller, state }: { controller: WorkspaceController; state: ControllerState }) {
  const dialog = state.dialog
  if (!dialog) return null
  const { generation, kind } = dialog
  const workspace = controller.workspaceId
  const cancelDialog = () => void runWorkspaceViewAction(controller.context, { workspace, action: 'cancel-dialog', kind, generation })
  const confirmClose = (dontAskAgain: boolean) => {
    if (kind !== 'close-running' && kind !== 'close-pinned') return
    void runWorkspaceViewAction(controller.context, { workspace, action: 'confirm-close', kind, generation, dontAskAgain })
  }
  const onSubmit = (prompt: string) => void runWorkspaceViewAction(controller.context, { workspace, action: 'submit-session', kind: 'new-session', generation, prompt })
  switch (dialog.kind) {
    case 'close-running':
      return <CloseRunningDialog key={generation} agent={dialog.agent} tabLabel={dialog.tabLabel} onCancel={cancelDialog} onConfirm={confirmClose} />
    case 'close-pinned':
      return <ClosePinnedDialog key={generation} tabLabel={dialog.tabLabel} onCancel={cancelDialog} onConfirm={confirmClose} />
    case 'switch-tabs':
      return <Switcher key={generation} controller={controller} dialog={dialog} />
    case 'new-session':
      return <PromptDialog key={generation} request={dialog.request} pending={dialog.pending === true} started={dialog.startedSession !== undefined} error={dialog.error ?? null} onClose={cancelDialog} onSubmit={onSubmit} />
  }
}

