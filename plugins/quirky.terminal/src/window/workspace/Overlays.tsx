import { useEffect } from 'react'
import { ContextMenu } from '@quirky/ui'
import { displayTitle } from '../../layout/titles'
import { ClosePinnedDialog, CloseRunningDialog } from './CloseDialogs'
import type { ControllerState, DialogState, WorkspaceController } from './controller'
import { PromptDialog } from './PromptDialog'
import { locateTab } from './model'

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
  return (
    <ContextMenu
      key={`${menu.kind}:${menu.target}`}
      items={controller.menuItems()}
      label={menu.kind === 'plus' ? 'New tab' : `${menu.kind} menu`}
      x={menu.x}
      y={menu.y}
      onClose={() => controller.closeMenu()}
      header={plus ? <PlusSearch controller={controller} query={menu.query} /> : undefined}
      highlightFirst={plus}
    />
  )
}

/** The Ctrl+Tab list: Tab or the arrow keys move, releasing Ctrl activates, Escape cancels. */
function Switcher({ controller, dialog }: { controller: WorkspaceController; dialog: Extract<DialogState, { kind: 'switch-tabs' }> }) {
  const ws = controller.getSnapshot().workspace
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Tab' && !event.ctrlKey) {
        event.preventDefault()
        controller.stepSwitcher(event.shiftKey ? -1 : 1)
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        controller.stepSwitcher(event.key === 'ArrowDown' ? 1 : -1)
      } else if (event.key === 'Enter') {
        event.preventDefault()
        void controller.endSwitcher(true)
      } else if (event.key === 'Escape') {
        event.preventDefault()
        void controller.endSwitcher(false)
      }
    }
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Control') void controller.endSwitcher(true)
    }
    const onBlur = () => void controller.endSwitcher(false)
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [controller])

  return (
    <div className="qt-overlay" onMouseDown={() => void controller.endSwitcher(false)}>
      <div className="qt-dialog qt-switcher" role="dialog" aria-label={dialog.title} onMouseDown={(event) => event.stopPropagation()}>
        <h2>{dialog.title}</h2>
        <ul role="listbox" aria-label="Tabs">
          {dialog.order.map((id, position) => {
            const loc = ws ? locateTab(ws, id) : null
            return (
              <li key={id} role="option" aria-selected={position === dialog.index} data-tab-option={id} className={position === dialog.index ? 'qt-highlight' : undefined} onMouseEnter={() => controller.setSwitcherIndex(position)} onClick={() => void controller.endSwitcher(true)}>
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
  switch (dialog.kind) {
    case 'close-running':
      return <CloseRunningDialog key="running" agent={dialog.agent} tabLabel={dialog.tabLabel} onCancel={() => void controller.answerCloseDialog(false)} onConfirm={(dontAsk) => void controller.answerCloseDialog(true, dontAsk)} />
    case 'close-pinned':
      return <ClosePinnedDialog key="pinned" tabLabel={dialog.tabLabel} onCancel={() => void controller.answerCloseDialog(false)} onConfirm={(dontAsk) => void controller.answerCloseDialog(true, dontAsk)} />
    case 'switch-tabs':
      return <Switcher controller={controller} dialog={dialog} />
    case 'new-session':
      return <PromptDialog request={dialog.request} pending={dialog.pending === true} started={dialog.startedSession !== undefined} error={dialog.error ?? null} onClose={() => void controller.submitNewSession(null)} onSubmit={(prompt) => void controller.submitNewSession(prompt)} />
  }
}

