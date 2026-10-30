import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement as h, createRef, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ToolPanelActions } from '@quirky/ui'
import {
  Badge,
  Button,
  ContextMenu,
  Dialog,
  EmptyState,
  FormRow,
  IconButton,
  InlineAgentCard,
  ListRow,
  Menu,
  Popover,
  SectionHeader,
  StatusDot,
  Tabs,
  TextField,
  TextArea,
  SelectField,
  Toast,
  ToolPanelFrame,
} from '../src/design-system'

let root: Root | null = null
let container: HTMLDivElement
const independentRoots = new Set<Root>()

beforeAll(() => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  for (const extra of [...independentRoots].reverse()) {
    await act(async () => extra.unmount())
    independentRoots.delete(extra)
  }
  await act(async () => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

async function render(node: ReactNode) {
  await act(async () => root!.render(node))
}
function mountIndependentRoot(target: HTMLElement): Root {
  const next = createRoot(target)
  independentRoots.add(next)
  return next
}

async function unmountIndependentRoot(target: Root): Promise<void> {
  await act(async () => target.unmount())
  independentRoots.delete(target)
}

const click = async (element: Element) => act(async () => {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
})
const key = async (element: Element, value: string, options: KeyboardEventInit = {}) => act(async () => {
  element.dispatchEvent(new KeyboardEvent('keydown', { ...options, key: value, bubbles: true, cancelable: true }))
})

let fakeNowMs = 0
let timers: { fn: () => void; id: number; ms: number | undefined; deadline: number }[] = []
const nativeSetTimeout = globalThis.setTimeout
const nativeClearTimeout = globalThis.clearTimeout

beforeEach(() => {
  timers = []
  fakeNowMs = 0
  let nextId = 1
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    const id = nextId++
    timers.push({ fn: fn as () => void, id, ms, deadline: fakeNowMs + (ms ?? 0) })
    return id
  }) as unknown as typeof setTimeout
  globalThis.clearTimeout = ((id: number) => {
    timers = timers.filter((timer) => timer.id !== id)
  }) as unknown as typeof clearTimeout
})

async function advanceTimersByTime(durationMs: number): Promise<void> {
  const deadline = fakeNowMs + durationMs
  while (true) {
    const timer = timers.filter((entry) => entry.deadline <= deadline).sort((left, right) => left.deadline - right.deadline)[0]
    if (!timer) break
    timers = timers.filter((entry) => entry.id !== timer.id)
    fakeNowMs = timer.deadline
    await act(async () => timer.fn())
  }
  fakeNowMs = deadline
}

afterEach(() => {
  globalThis.setTimeout = nativeSetTimeout
  globalThis.clearTimeout = nativeClearTimeout
})

describe('shared graphite components', () => {
  test('buttons honor disabled state and icon buttons have accessible names', async () => {
    const calls: string[] = []
    const onClick = () => calls.push('clicked')
    await render(h('div', null,
      <Button onClick={onClick}>Enabled</Button>,
      <Button disabled onClick={onClick}>Disabled</Button>,
      <IconButton label="Close panel" onClick={onClick}><span aria-hidden="true">×</span></IconButton>,
    ))

    expect(container.querySelectorAll('button')).toHaveLength(3)
    expect(container.querySelector('button[aria-label="Close panel"]')).not.toBeNull()
    await click(container.querySelector('button:disabled')!)
    expect(calls).toEqual([])
    await click(container.querySelector('button:not(:disabled)')!)
    expect(calls).toEqual(['clicked'])
    await click(container.querySelector('button[aria-label="Close panel"]')!)
    expect(calls).toEqual(['clicked', 'clicked'])
  })

  test('text fields expose their label, disabled state, help and error descriptions', async () => {
    await render(<TextField label="Commit message" help="Shown in history" error="Message is required" disabled />)
    const input = container.querySelector('input')!
    expect(container.querySelector('label')?.htmlFor).toBe(input.id)
    expect(input.disabled).toBe(true)
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(input.getAttribute('aria-describedby')?.split(' ')).toHaveLength(2)
    expect(container.textContent).toContain('Shown in history')
    expect(container.textContent).toContain('Message is required')
  })

  test('text fields hold names and paths, so the OS does not capitalize or correct them unless asked', async () => {
    await render(<><TextField label="Name" /><TextField label="Title" autoCapitalize="sentences" spellCheck /></>)
    const [name, title] = [...container.querySelectorAll('input')]
    expect(name!.getAttribute('autocapitalize')).toBe('off')
    expect(name!.getAttribute('autocorrect')).toBe('off')
    expect(name!.getAttribute('spellcheck')).toBe('false')
    expect(title!.getAttribute('autocapitalize')).toBe('sentences')
    expect(title!.getAttribute('spellcheck')).toBe('true')
  })

  test('multiline and selection fields preserve native form values and accessible error ownership', async () => {
    await render(<form>
      <span id="existing-help">Inherited description</span>
      <TextArea label="Instructions" name="instructions" defaultValue={'first line\nsecond line'} help="Keep line breaks" error="Review instructions" aria-describedby="existing-help" />
      <SelectField label="Agent" name="agent" defaultValue="codex">
        <option value="claude">Claude</option>
        <option value="codex">Codex</option>
      </SelectField>
    </form>)
    const form = container.querySelector('form')!
    const instructions = form.querySelector<HTMLTextAreaElement>('textarea[name="instructions"]')!
    const agent = form.querySelector('select')!
    expect(Object.fromEntries(new FormData(form))).toEqual({ instructions: 'first line\nsecond line', agent: 'codex' })
    expect([...form.querySelectorAll('label')].map((label) => label.control)).toEqual([instructions, agent])
    expect(instructions.getAttribute('aria-invalid')).toBe('true')
    const describedIds = instructions.getAttribute('aria-describedby')!.split(' ')
    expect(describedIds.map((id) => document.getElementById(id)?.textContent)).toEqual([
      'Inherited description', 'Keep line breaks', 'Review instructions',
    ])
    expect(instructions.id).not.toBe(agent.id)
  })

  test('list rows announce selection and disabled rows ignore activation', async () => {
    const calls: number[] = []
    await render(<ListRow title="provider-host" description="codex · editing host.ts" status="working" count={2} selected disabled onClick={() => calls.push(1)} />)
    const action = container.querySelector('button[aria-pressed="true"]')!
    expect(container.textContent).toContain('provider-host')
    expect(container.textContent).toContain('2')
    expect(container.querySelector('[role="img"][aria-label]')).not.toBeNull()
    await click(action)
    expect(calls).toEqual([])
  })

  test('trailing row actions do not trigger the row action', async () => {
    const calls: string[] = []
    await render(<ListRow title="provider-host" onClick={() => calls.push('row')} trailing={<Button onClick={() => calls.push('trailing')}>Open</Button>} />)
    await click(container.querySelector('button:not([aria-pressed])')!)
    expect(calls).toEqual(['trailing'])
    await click(container.querySelector('button[aria-pressed]')!)
    expect(calls).toEqual(['trailing', 'row'])
  })

  test('section headers, badges and status dots expose their semantic content', async () => {
    await render(<>
      <SectionHeader title="CHECKS" actions={<Button>Refresh</Button>} />
      <Badge tone="needs-you" label="2 waiting">2</Badge>
      <StatusDot status="working" label="Agent working" />
    </>)
    expect(container.querySelector('h2')?.textContent).toBe('CHECKS')
    expect(container.querySelector('button')?.textContent).toBe('Refresh')
    expect(container.querySelector('[aria-label="2 waiting"]')?.textContent).toBe('2')
    expect(container.querySelector('[role="img"][aria-label="Agent working"]')).not.toBeNull()
  })

  test('tabs navigate with arrows, skip disabled tabs and activate the intended tab', async () => {
    const changes: string[] = []
    await render(<Tabs label="Terminal sessions" value="claude" items={[
      { id: 'claude', label: 'claude' },
      { id: 'disabled', label: 'disabled', disabled: true },
      { id: 'zsh', label: 'zsh' },
    ]} onChange={(id) => changes.push(id)} />)
    const tabs = [...container.querySelectorAll('[role="tab"]')]
    expect(tabs[0].getAttribute('aria-selected')).toBe('true')
    await key(tabs[0], 'ArrowRight')
    expect(changes).toEqual(['zsh'])
    expect(document.activeElement).toBe(tabs[2])
    expect(tabs[2].getAttribute('aria-selected')).toBe('false')
    await key(tabs[2], 'Home')
    expect(changes).toEqual(['zsh', 'claude'])
  })

  test('menus open, skip disabled items, activate actions and restore trigger focus on Escape', async () => {
    const actions: string[] = []
    await render(<Menu label="Worktree actions" items={[
      { id: 'rename', label: 'Rename', onAction: () => actions.push('rename') },
      { id: 'disabled', label: 'Disabled', disabled: true, onAction: () => actions.push('disabled') },
      { id: 'delete', label: 'Delete worktree', destructive: true, onAction: () => actions.push('delete') },
    ]} />)
    const trigger = container.querySelector('button[aria-haspopup="menu"]')!
    await click(trigger)
    let items = [...container.querySelectorAll('[role="menuitem"]')]
    expect(items).toHaveLength(3)
    expect(document.activeElement).toBe(items[0])
    await key(items[0], 'ArrowDown')
    expect(document.activeElement).toBe(items[2])
    await click(items[2])
    expect(actions).toEqual(['delete'])
    expect(container.querySelector('[role="menu"]')).toBeNull()

    await click(trigger)
    items = [...container.querySelectorAll('[role="menuitem"]')]
    await key(items[0], 'Escape')
    expect(container.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  test('menus keep keyboard activation on the focused action when items rerender', async () => {
    const actions: string[] = []
    const items = () => [
      { id: 'new-file', label: 'New File', onAction: () => actions.push('new-file') },
      { id: 'rename', label: 'Rename', onAction: () => actions.push('rename') }
    ]
    const menu = () => <Menu label="File actions" items={items()} />
    await render(menu())
    await click(container.querySelector('button[aria-haspopup="menu"]')!)
    const initialItems = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    await key(initialItems[0]!, 'ArrowDown')
    expect(document.activeElement).toBe(initialItems[1])

    await render(menu())
    const focusedItem = document.activeElement
    if (!(focusedItem instanceof HTMLButtonElement)) throw new Error('Expected focus to remain on a menu action')
    await key(focusedItem, 'Enter')
    await click(focusedItem)

    expect(actions).toEqual(['rename'])
  })

  test('menus dismiss after an outside interaction without running an item action', async () => {
    const onAction = () => { throw new Error('unexpected action') }
    await render(<><Menu label="Actions" items={[{ id: 'rename', label: 'Rename', onAction }]} /><button>Outside</button></>)
    await click(container.querySelector('[aria-haspopup="menu"]')!)
    const outside = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Outside')!
    await act(async () => {
      outside.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    })
    expect(container.querySelector('[role="menu"]')).toBeNull()
  })

  test('only the top stacked dialog traps focus and handles Escape', async () => {
    const calls: string[] = []
    const tree = (inner: boolean) => <>
      <Dialog open title="Project settings" onClose={() => calls.push('outer')}>
        <button id="outer-action">Edit setup</button>
      </Dialog>
      <Dialog open={inner} title="Trust setup" onClose={() => calls.push('inner')}>
        <button id="inner-action">Run once</button>
      </Dialog>
    </>
    await render(tree(false))
    const outerAction = container.querySelector<HTMLButtonElement>('#outer-action')!
    outerAction.focus()
    await render(tree(true))
    const innerDialog = [...container.querySelectorAll<HTMLElement>('[role="dialog"]')][1]
    const innerAction = container.querySelector<HTMLButtonElement>('#inner-action')!
    innerAction.focus()
    expect(document.activeElement).toBe(innerAction)
    outerAction.focus()
    expect(innerDialog.contains(document.activeElement)).toBe(true)
    await key(innerAction, 'Escape')
    expect(calls).toEqual(['inner'])
    await render(tree(false))
    expect(document.activeElement).toBe(outerAction)
    await key(outerAction, 'Escape')
    expect(calls).toEqual(['inner', 'outer'])
  })

  test('closing a stacked dialog keeps keyboard focus in a busy parent', async () => {
    const calls: string[] = []
    const tree = (inner: boolean, busy: boolean) => <>
      <Dialog open title="New workspace" onClose={() => calls.push('outer')}>
        <button id="submit-create" disabled={busy}>Create</button>
      </Dialog>
      <Dialog open={inner} title="Trust setup" onClose={() => calls.push('inner')}>
        <button>Cancel trust</button>
      </Dialog>
    </>
    await render(tree(false, false))
    container.querySelector<HTMLButtonElement>('#submit-create')!.focus()
    await render(tree(true, true))
    await render(tree(false, true))
    const parent = container.querySelector<HTMLElement>('[role="dialog"]')!
    expect(parent.contains(document.activeElement)).toBe(true)
    expect(document.activeElement).not.toBe(container.querySelector('#submit-create'))
    await key(document.activeElement!, 'Escape')
    expect(calls).toEqual(['outer'])
  })

  test('context menus skip headings and disabled rows before selecting an enabled nested item', async () => {
    const actions: string[] = []
    function Example() {
      const [open, setOpen] = useState(true)
      return open ? <ContextMenu x={0} y={0} label="File actions" onClose={() => setOpen(false)} items={[
        { label: 'Destinations', heading: true },
        { label: 'Unavailable', enabled: false, onSelect: () => actions.push('disabled') },
        { label: 'Send to', submenu: [
          { label: 'Unavailable target', enabled: false, onSelect: () => actions.push('disabled target') },
          { label: 'Agent', onSelect: () => actions.push('agent') },
        ] },
      ]} /> : null
    }
    await render(<Example />)
    const parent = document.querySelector<HTMLElement>('[role="menu"][aria-label="File actions"]')!
    expect(parent.querySelector('[role="presentation"]')).not.toBeNull()
    expect(parent.querySelector('[role="menuitem"][aria-disabled="true"]')).not.toBeNull()

    await key(parent, 'ArrowDown')
    await key(parent, 'ArrowRight')
    const child = document.querySelector<HTMLElement>('[role="menu"][aria-label="Send to"]')!
    expect(child.querySelector('[role="menuitem"][aria-disabled="true"]')).not.toBeNull()
    await key(child, 'ArrowDown')
    await key(child, 'Enter')
    expect(actions).toEqual(['agent'])
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })

  test('menu checkbox actions expose current state and restore trigger focus', async () => {
    function Example() {
      const [checked, setChecked] = useState(false)
      return <Menu label="Diff options" items={[
        { id: 'wrap', label: 'Word Wrap', checked, onAction: () => setChecked((value) => !value) },
        { id: 'copy', label: 'Copy', onAction: () => {} },
      ]} />
    }
    await render(<Example />)
    const trigger = container.querySelector('button[aria-haspopup="menu"]')!
    await click(trigger)
    expect(container.querySelector('[role="menuitemcheckbox"]')?.getAttribute('aria-checked')).toBe('false')
    expect(container.querySelector('[role="menuitem"]')).not.toBeNull()
    await click(container.querySelector('[role="menuitemcheckbox"]')!)
    expect(document.activeElement).toBe(trigger)
    await click(trigger)
    expect(container.querySelector('[role="menuitemcheckbox"]')?.getAttribute('aria-checked')).toBe('true')
  })

  test('popover interaction stays nonmodal and outside interaction dismisses it', async () => {
    const anchor = createRef<HTMLButtonElement>()
    const calls: string[] = []
    function Example() {
      const [open, setOpen] = useState(true)
      return <><button ref={anchor}>Notes</button><button>Outside</button>
        <Popover open={open} label="AI notes" anchor={anchor} onClose={() => { calls.push('close'); setOpen(false) }}>
          <Button onClick={() => calls.push('copy')}>Copy</Button>
        </Popover></>
    }
    await render(<Example />)
    const dialog = document.querySelector('[role="dialog"][aria-label="AI notes"]')!
    expect(dialog.hasAttribute('aria-modal')).toBe(false)
    await act(async () => { dialog.dispatchEvent(new Event('pointerdown', { bubbles: true })) })
    await click(dialog.querySelector('button')!)
    expect(calls).toEqual(['copy'])
    const outside = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Outside')!
    await act(async () => { outside.dispatchEvent(new Event('pointerdown', { bubbles: true })) })
    expect(calls).toEqual(['copy', 'close'])
    expect(document.querySelector('[role="dialog"][aria-label="AI notes"]')).toBeNull()
  })

  test('toasts dismiss on expiration and expiration never invokes the action', async () => {
    const calls: string[] = []
    await render(<Toast title="Approve merge?" status="needs-you" durationMs={1200} onDismiss={() => calls.push('dismiss')} action={{ label: 'Approve', onAction: () => calls.push('action') }} />)
    expect(timers.map((timer) => timer.ms)).toContain(1200)
    const expirationTimer = timers.find((timer) => timer.ms === 1200)!
    await act(async () => expirationTimer.fn())
    expect(calls).toEqual(['dismiss'])
  })

  test('toast callback updates do not reset the expiration deadline and invoke the latest callback once', async () => {
    const calls: string[] = []
    await render(<Toast title="Temporary notice" durationMs={1200} onDismiss={() => calls.push('old')} />)
    const originalTimer = timers.find((timer) => timer.ms === 1200)!

    await advanceTimersByTime(600)
    await render(<Toast title="Temporary notice" durationMs={1200} onDismiss={() => calls.push('latest')} />)
    expect(timers.some((timer) => timer.id === originalTimer.id)).toBe(true)

    await advanceTimersByTime(599)
    expect(calls).toEqual([])
    await advanceTimersByTime(1)
    expect(calls).toEqual(['latest'])
    await advanceTimersByTime(1000)
    expect(calls).toEqual(['latest'])
  })

  test('toast actions invoke their action and dismiss callbacks once', async () => {
    const calls: string[] = []
    await render(<Toast title="Approve merge?" onDismiss={() => calls.push('dismiss')} action={{ label: 'Approve', onAction: () => calls.push('action') }} />)
    await click([...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === 'Approve')!)
    expect(calls).toEqual(['action', 'dismiss'])
  })

  test('toast dismiss button invokes its dismissal callback', async () => {
    const calls: string[] = []
    await render(<Toast title="Temporary notice" durationMs={0} onDismiss={() => calls.push('dismiss')} />)
    await click(container.querySelector('button[aria-label="Dismiss notification"]')!)
    expect(calls).toEqual(['dismiss'])
  })

  test('disabled toast actions do not invoke callbacks', async () => {
    const calls: string[] = []
    await render(<Toast title="Approve merge?" durationMs={0} onDismiss={() => calls.push('dismiss')} action={{ label: 'Approve', disabled: true, onAction: () => calls.push('action') }} />)
    await click([...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === 'Approve')!)
    expect(calls).toEqual([])
  })

  test('toast expiration timers are cleared when the toast unmounts', async () => {
    await render(<Toast title="Temporary notice" onDismiss={() => undefined} />)
    const timer = timers.find((item) => item.ms === 8000)!
    await act(async () => root!.unmount())
    root = null
    expect(timers.some((item) => item.id === timer.id)).toBe(false)
  })

  test('dialogs label themselves, trap focus, close on Escape and restore the opener', async () => {
    const calls: string[] = []
    const onClose = () => calls.push('close')
    const dialogTree = (open: boolean) => (
      <>
        <button id="opener">Open</button>
        <Dialog open={open} title="Rename worktree" onClose={onClose}>
          <input aria-label="New name" />
          <button>Save</button>
        </Dialog>
      </>
    )
    await render(dialogTree(false))
    const opener = container.querySelector('#opener') as HTMLButtonElement
    opener.focus()
    await render(dialogTree(true))
    const panel = container.querySelector('[role="dialog"]')!
    expect(panel.getAttribute('aria-modal')).toBe('true')
    expect(panel.getAttribute('aria-labelledby')).toBeTruthy()
    const closeButton = panel.querySelector('button[aria-label="Close dialog"]')!
    const saveButton = [...panel.querySelectorAll('button')].find((button) => button.textContent === 'Save')!
    expect(document.activeElement).toBe(closeButton)
    saveButton.focus()
    await key(saveButton, 'Tab')
    expect(document.activeElement).toBe(closeButton)
    await key(closeButton, 'Tab', { shiftKey: true })
    expect(document.activeElement).toBe(saveButton)
    await key(panel, 'Escape')
    expect(calls).toEqual(['close'])
    await render(dialogTree(false))
    expect(document.activeElement).toBe(opener)
  })

  test('required-choice dialogs stay open until an explicit enabled action is selected', async () => {
    const choices: string[] = []
    const RequiredChoice = () => {
      const [open, setOpen] = useState(false)
      return <>
        <button id="opener" onClick={() => setOpen(true)}>Choose account</button>
        <Dialog
          open={open}
          title="Choose how to continue"
          actions={<>
            <Button disabled>Unavailable choice</Button>
            <Button onClick={() => { choices.push('keep'); setOpen(false) }}>Keep current account</Button>
            <Button onClick={() => { choices.push('restart'); setOpen(false) }}>Restart on selected account</Button>
          </>}
        >
          <p>Choose an explicit action to continue.</p>
        </Dialog>
      </>
    }
    await render(<RequiredChoice />)
    const opener = container.querySelector<HTMLButtonElement>('#opener')!
    opener.focus()
    await click(opener)

    const panel = container.querySelector<HTMLElement>('[role="dialog"]')!
    expect(panel.getAttribute('aria-modal')).toBe('true')
    const titleId = panel.getAttribute('aria-labelledby')
    expect(titleId).toBeTruthy()
    expect(document.getElementById(titleId!)?.textContent).toBe('Choose how to continue')
    expect(panel.querySelector('button[aria-label="Close dialog"]')).toBeNull()
    const [unavailable, keep, restart] = [...panel.querySelectorAll<HTMLButtonElement>('button')]
    expect(unavailable?.disabled).toBe(true)
    expect(document.activeElement).toBe(keep)

    await key(panel, 'Escape')
    expect(container.querySelector('[role="dialog"]')).toBe(panel)
    await click(panel.parentElement!)
    expect(container.querySelector('[role="dialog"]')).toBe(panel)
    expect(choices).toEqual([])

    restart!.focus()
    await key(restart!, 'Tab')
    expect(document.activeElement).toBe(keep)
    keep!.focus()
    await key(keep!, 'Tab', { shiftKey: true })
    expect(document.activeElement).toBe(restart)

    await click(restart!)
    expect(choices).toEqual(['restart'])
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(opener)
  })

  test('dialog content clicks do not dismiss and a disabled backdrop does not close', async () => {
    const calls: string[] = []
    await render(<Dialog open title="Panel" closeOnBackdrop={false} onClose={() => calls.push('close')}>
      <button>Inside action</button>
    </Dialog>)
    const backdrop = container.querySelector('[role="dialog"]')!.parentElement!
    const inside = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Inside action')!
    await click(inside)
    await click(backdrop)
    expect(calls).toEqual([])
  })

  test('dialog backdrop closes only when the backdrop itself is activated', async () => {
    const calls: string[] = []
    await render(<Dialog open title="Panel" onClose={() => calls.push('close')}>
      <button>Inside action</button>
    </Dialog>)
    const backdrop = container.querySelector('[role="dialog"]')!.parentElement!
    const inside = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Inside action')!
    await click(inside)
    expect(calls).toEqual([])
    await click(backdrop)
    expect(calls).toEqual(['close'])
  })

  test('empty states render one optional action and honor disabled', async () => {
    const calls: number[] = []
    await render(<EmptyState message="No changes" icon={<span aria-hidden="true">∅</span>} action={{ label: 'Open terminal', disabled: true, onAction: () => calls.push(1) }} />)
    expect(container.textContent).toContain('No changes')
    expect(container.querySelectorAll('button')).toHaveLength(1)
    await click(container.querySelector('button')!)
    expect(calls).toEqual([])
  })

  test('form rows associate label, help and error text with the control', async () => {
    await render(<FormRow label="Workspace name" htmlFor="workspace-name" help="Visible to you" error="Name is required">
      <input />
    </FormRow>)
    const input = container.querySelector('input')!
    expect(input.id).toBe('workspace-name')
    expect(container.querySelector('label')?.htmlFor).toBe(input.id)
    expect(input.getAttribute('aria-describedby')?.split(' ')).toEqual(['workspace-name-help', 'workspace-name-error'])
    expect(input.getAttribute('aria-invalid')).toBe('true')
  })

  test('tool panels expose a heading and a functioning minimize action', async () => {
    const calls: number[] = []
    await render(<ToolPanelFrame title="Changes" actions={<Button>Commit</Button>} onMinimize={() => calls.push(1)}>
      <p>Working tree</p>
    </ToolPanelFrame>)
    expect(container.querySelector('h2')?.textContent).toBe('Changes')
    expect(container.textContent).toContain('Working tree')
    await click(container.querySelector('button[aria-label="Minimize Changes"]')!)
    expect(calls).toEqual([1])
  })

  test('tool panel actions stay in their nearest frame across independent roots and unmount cleanly', async () => {
    const secondFrameContainer = document.createElement('div')
    document.body.append(secondFrameContainer)
    const secondFrameRoot = mountIndependentRoot(secondFrameContainer)

    await act(async () => {
      root!.render(<ToolPanelFrame title="First Worktrees"><div data-plugin-root="first" /></ToolPanelFrame>)
      secondFrameRoot.render(<ToolPanelFrame title="Second Worktrees"><div data-plugin-root="second" /></ToolPanelFrame>)
    })

    const firstPluginRoot = mountIndependentRoot(container.querySelector<HTMLElement>('[data-plugin-root="first"]')!)
    const secondPluginRoot = mountIndependentRoot(secondFrameContainer.querySelector<HTMLElement>('[data-plugin-root="second"]')!)
    const orphanContainer = document.createElement('div')
    document.body.append(orphanContainer)
    const orphanRoot = mountIndependentRoot(orphanContainer)
    await act(async () => {
      firstPluginRoot.render(<ToolPanelActions><button aria-label="First action">First action</button></ToolPanelActions>)
      secondPluginRoot.render(<ToolPanelActions><button aria-label="Second action">Second action</button></ToolPanelActions>)
      orphanRoot.render(<ToolPanelActions><button aria-label="Orphan action">Orphan action</button></ToolPanelActions>)
    })

    const firstAction = document.querySelector<HTMLButtonElement>('button[aria-label="First action"]')
    const secondAction = document.querySelector<HTMLButtonElement>('button[aria-label="Second action"]')
    expect(firstAction?.closest('header')).toBe(container.querySelector('header'))
    expect(secondAction?.closest('header')).toBe(secondFrameContainer.querySelector('header'))
    expect(document.querySelectorAll('button[aria-label="First action"]')).toHaveLength(1)
    expect(document.querySelectorAll('button[aria-label="Second action"]')).toHaveLength(1)
    expect(document.querySelector('button[aria-label="Orphan action"]')).toBeNull()

    await unmountIndependentRoot(firstPluginRoot)
    expect(document.querySelector('button[aria-label="First action"]')).toBeNull()
    expect(document.querySelector('button[aria-label="Second action"]')).toBe(secondAction)

    await unmountIndependentRoot(secondPluginRoot)
    expect(document.querySelector('button[aria-label="Second action"]')).toBeNull()
    await unmountIndependentRoot(orphanRoot)
  })

  test('a plugin frame inside the host frame adds no second header and moves its actions up', async () => {
    await act(async () => {
      root!.render(<ToolPanelFrame title="Tasks" onMinimize={() => {}}><div data-plugin-root="tasks" /></ToolPanelFrame>)
    })
    const pluginRoot = mountIndependentRoot(container.querySelector<HTMLElement>('[data-plugin-root="tasks"]')!)
    await act(async () => {
      pluginRoot.render(<ToolPanelFrame title="Tasks" actions={<button aria-label="Task settings">Task settings</button>} onMinimize={() => {}}><p>Issues</p></ToolPanelFrame>)
    })
    expect(container.querySelectorAll('h2')).toHaveLength(1)
    expect(container.querySelectorAll('button[aria-label="Minimize Tasks"]')).toHaveLength(1)
    expect(document.querySelector('button[aria-label="Task settings"]')?.closest('header')).toBe(container.querySelector('header'))
    expect(container.textContent).toContain('Issues')
    await unmountIndependentRoot(pluginRoot)
  })

  test('inline agent cards show status and suppress disabled actions', async () => {
    const calls: number[] = []
    await render(<InlineAgentCard title="provider-host" description="codex · editing host.ts" status="working" action={{ label: 'Approve merge', disabled: true, onAction: () => calls.push(1) }} />)
    expect(container.textContent).toContain('provider-host')
    expect(container.querySelector('[role="img"][aria-label]')).not.toBeNull()
    await click(container.querySelector('button')!)
    expect(calls).toEqual([])
  })

})
