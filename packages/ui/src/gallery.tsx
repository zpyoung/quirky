import { useRef, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { UiToolHue } from '@quirky/protocol'
import {
  Badge,
  Button,
  ControlIcon,
  Dialog,
  EmptyState,
  FileIcon,
  FormRow,
  IconButton,
  InlineAgentCard,
  ListRow,
  Menu,
  PopupMenu,
  ProjectTile,
  SectionHeader,
  StatusDot,
  Tabs,
  TextField,
  Toast,
  ToolIcon,
  ToolPanelFrame
} from '@quirky/ui'
import '@quirky/ui/styles.css'

type Theme = 'dark' | 'light'
type CategoryName =
  | 'Button'
  | 'IconButton'
  | 'TextField'
  | 'ListRow'
  | 'SectionHeader'
  | 'Tabs'
  | 'Badge'
  | 'StatusDot'
  | 'Menu'
  | 'Toast'
  | 'Dialog'
  | 'EmptyState'
  | 'FormRow'
  | 'ToolPanelFrame'
  | 'InlineAgentCard'
  | 'ToolIcon'
  | 'ControlIcon'
  | 'FileIcon'
  | 'ProjectTile'
  | 'PopupMenu'

type CategoryProps = { name: CategoryName; theme: Theme; children: ReactNode }

function Category({ name, theme, children }: CategoryProps) {
  return (
    <section className="ui-gallery-demo" data-category={name} aria-label={`${name} examples in ${theme} theme`}>
      <h3>{name}</h3>
      <div className="ui-stack">{children}</div>
    </section>
  )
}

function Status({ name, children }: { name: string; children: ReactNode }) {
  return <output className="ui-text-muted" data-demo-status={name} aria-live="polite">{children}</output>
}

function ButtonDemo({ theme }: { theme: Theme }) {
  const [actions, setActions] = useState(0)
  const countAction = () => setActions((count) => count + 1)
  return (
    <Category name="Button" theme={theme}>
      <div className="ui-cluster">
        <Button type="button" variant="primary" onClick={countAction}>Primary action</Button>
        <Button type="button" variant="secondary" onClick={countAction}>Save this exceptionally long workspace label</Button>
        <Button type="button" variant="destructive" onClick={countAction}>Delete sample</Button>
        <Button type="button" variant="primary" disabled onClick={countAction}>Unavailable primary action</Button>
      </div>
      <Status name="button">Button actions: {actions}</Status>
    </Category>
  )
}

function IconButtonDemo({ theme }: { theme: Theme }) {
  const [refreshes, setRefreshes] = useState(0)
  return (
    <Category name="IconButton" theme={theme}>
      <div className="ui-cluster">
        <IconButton label="Refresh gallery activity" type="button" onClick={() => setRefreshes((count) => count + 1)}>
          <span aria-hidden="true">↻</span>
        </IconButton>
        <span>Refresh activity without leaving the gallery.</span>
      </div>
      <Status name="icon-button">Refreshes: {refreshes}</Status>
    </Category>
  )
}

function TextFieldDemo({ theme }: { theme: Theme }) {
  const [draft, setDraft] = useState('sample-workspace')
  return (
    <Category name="TextField" theme={theme}>
      <TextField
        id={`gallery-workspace-${theme}`}
        label="Workspace name"
        help="Changes stay in this local gallery demo."
        value={draft}
        onChange={(event) => setDraft(event.currentTarget.value)}
      />
      <TextField label="Long locked workspace name for a narrow project panel" value="read-only-example" disabled />
      <TextField
        label="Project key with a validation error"
        defaultValue="Invalid Project Key"
        error="Use lowercase letters, digits, and dashes in this project key."
      />
      <Status name="text-field">Workspace draft: {draft}</Status>
    </Category>
  )
}

function ListRowDemo({ theme }: { theme: Theme }) {
  const [selected, setSelected] = useState(true)
  return (
    <Category name="ListRow" theme={theme}>
      <ListRow title="Single-line task" status="working" count={3} trailing="Now" />
      <ListRow
        title="A deliberately long project row that wraps without losing its status"
        description="Two-line example description: this local row can be selected and keeps its count visible."
        status="needs-you"
        count={12}
        selected={selected}
        onClick={() => setSelected((value) => !value)}
      />
      <Status name="list-row">Selected row: {selected ? 'yes' : 'no'}</Status>
    </Category>
  )
}

function SectionHeaderDemo({ theme }: { theme: Theme }) {
  const [created, setCreated] = useState(false)
  return (
    <Category name="SectionHeader" theme={theme}>
      <SectionHeader
        title="Recent workspaces"
        actions={<Button type="button" variant="secondary" onClick={() => setCreated(true)}>Add workspace</Button>}
      />
      <Status name="section-header">{created ? 'Workspace added locally' : 'No section action yet'}</Status>
    </Category>
  )
}

const galleryTabs = [
  { id: 'overview', label: 'Overview' },
  { id: 'activity', label: 'Activity' },
  { id: 'archived', label: 'Archived', disabled: true }
] as const

function TabsDemo({ theme }: { theme: Theme }) {
  const [activeTab, setActiveTab] = useState('overview')
  const activeLabel = galleryTabs.find((tab) => tab.id === activeTab)?.label ?? 'Overview'
  return (
    <Category name="Tabs" theme={theme}>
      <Tabs label="Gallery views" items={galleryTabs} value={activeTab} onChange={setActiveTab} />
      <Status name="tabs">Active tab: {activeLabel}</Status>
    </Category>
  )
}

function BadgeDemo({ theme }: { theme: Theme }) {
  return (
    <Category name="Badge" theme={theme}>
      <div className="ui-cluster">
        <Badge tone="neutral" label="No unread notifications">0</Badge>
        <Badge tone="accent" label="Twelve unread notifications">12</Badge>
        <Badge tone="working" label="Four active tasks">4</Badge>
        <Badge tone="needs-you" label="One task needs attention">1</Badge>
        <Badge tone="failing" label="Two failed tasks">2</Badge>
      </div>
    </Category>
  )
}

function StatusDotDemo({ theme }: { theme: Theme }) {
  return (
    <Category name="StatusDot" theme={theme}>
      <div className="ui-cluster">
        <StatusDot status="working" label="Working" />
        <StatusDot status="needs-you" label="Needs your attention" />
        <StatusDot status="failing" label="Failing" />
        <StatusDot status="done" label="Done" />
        <StatusDot status="idle" label="Idle" />
        <StatusDot status="queued" label="Queued" />
      </div>
    </Category>
  )
}

function MenuDemo({ theme }: { theme: Theme }) {
  const [lastAction, setLastAction] = useState('No menu action yet')
  const action = (label: string) => () => setLastAction(`Menu action: ${label}`)
  return (
    <Category name="Menu" theme={theme}>
      <Menu
        label="Open menu"
        items={[
          { id: 'mark-active', label: 'Mark active', onAction: action('Mark active') },
          { id: 'disabled-action', label: 'Unavailable menu action', disabled: true, onAction: action('Unavailable menu action') },
          { id: 'archive', label: 'Archive this exceptionally long-named workspace', destructive: true, onAction: action('Archive this exceptionally long-named workspace') }
        ]}
      />
      <Status name="menu">{lastAction}</Status>
    </Category>
  )
}

function ToastDemo({ theme }: { theme: Theme }) {
  const [visible, setVisible] = useState(true)
  const [message, setMessage] = useState('Toast is visible')
  const actionDismissMessage = useRef<string | null>(null)
  const dismiss = () => {
    setVisible(false)
    setMessage(actionDismissMessage.current ?? 'Toast dismissed')
    actionDismissMessage.current = null
  }
  const reviewUpdate = () => {
    const result = 'Toast action: Review update'
    actionDismissMessage.current = result
    setMessage(result)
  }
  const showAgain = () => {
    actionDismissMessage.current = null
    setVisible(true)
    setMessage('Toast is visible')
  }
  return (
    <Category name="Toast" theme={theme}>
      {visible ? (
        <>
          <Toast
            title="Gallery update ready"
            description="This notification is local to the current theme panel."
            status="done"
            durationMs={15_000}
            action={{ label: 'Review update', onAction: reviewUpdate }}
            onDismiss={dismiss}
          />
          <Button type="button" variant="secondary" onClick={dismiss}>Dismiss toast</Button>
        </>
      ) : (
        <Button type="button" variant="secondary" onClick={showAgain}>Show toast again</Button>
      )}
      <Status name="toast">{message}</Status>
    </Category>
  )
}

function DialogDemo({ theme }: { theme: Theme }) {
  const [open, setOpen] = useState<'dialog' | 'sheet' | null>(null)
  const [message, setMessage] = useState('Dialog status: Closed')
  const close = () => {
    setOpen(null)
    setMessage('Dialog status: Closed')
  }
  const show = (variant: 'dialog' | 'sheet') => {
    setOpen(variant)
    setMessage(variant === 'dialog' ? 'Dialog status: Open' : 'Sheet status: Open')
  }
  return (
    <Category name="Dialog" theme={theme}>
      <div className="ui-cluster">
        <Button type="button" onClick={() => show('dialog')}>Open dialog</Button>
        <Button type="button" variant="secondary" onClick={() => show('sheet')}>Open sheet</Button>
      </div>
      <Dialog
        open={open === 'dialog'}
        title="Gallery dialog"
        onClose={close}
        actions={<Button type="button" variant="secondary" onClick={close}>Close dialog</Button>}
      >
        <p>Gallery dialog is open.</p>
      </Dialog>
      <Dialog
        open={open === 'sheet'}
        title="Gallery sheet"
        variant="sheet"
        onClose={close}
        actions={<Button type="button" variant="secondary" onClick={close}>Close sheet</Button>}
      >
        <p>Gallery sheet is open.</p>
      </Dialog>
      <Status name="dialog">{message}</Status>
    </Category>
  )
}

function EmptyStateDemo({ theme }: { theme: Theme }) {
  const [created, setCreated] = useState(false)
  return (
    <Category name="EmptyState" theme={theme}>
      <EmptyState
        message="No sample agents are waiting in this local view."
        icon={<span aria-hidden="true">◇</span>}
        action={{ label: 'Create a sample agent', onAction: () => setCreated(true) }}
      />
      <Status name="empty-state">{created ? 'Sample agent created locally' : 'Empty state ready'}</Status>
    </Category>
  )
}

function FormRowDemo({ theme }: { theme: Theme }) {
  const inputId = `gallery-project-path-${theme}`
  return (
    <Category name="FormRow" theme={theme}>
      <FormRow
        label="Project directory"
        htmlFor={inputId}
        help="Use a local path; this example does not connect to a project."
        error="This example path is intentionally marked for review."
      >
        <input id={inputId} type="text" defaultValue="/workspace/example" aria-invalid="true" />
      </FormRow>
      <p>A long form label remains associated with its control in either theme.</p>
    </Category>
  )
}

function ToolPanelFrameDemo({ theme }: { theme: Theme }) {
  const [minimized, setMinimized] = useState(false)
  const minimize = () => setMinimized(true)
  return (
    <Category name="ToolPanelFrame" theme={theme}>
      <ToolPanelFrame
        title="Local task details"
        onMinimize={minimize}
        actions={<Button type="button" variant="secondary" onClick={minimize}>Minimize panel</Button>}
      >
        {minimized ? <p>Panel minimized locally.</p> : <p>Panel content remains local; no daemon session is used.</p>}
      </ToolPanelFrame>
      {minimized && <Button type="button" variant="secondary" onClick={() => setMinimized(false)}>Restore panel</Button>}
      <Status name="tool-panel">{minimized ? 'Tool panel minimized' : 'Tool panel open'}</Status>
    </Category>
  )
}

function InlineAgentCardDemo({ theme }: { theme: Theme }) {
  const [message, setMessage] = useState('No agent action yet')
  return (
    <Category name="InlineAgentCard" theme={theme}>
      <InlineAgentCard
        title="Drafting a component gallery"
        description="The agent is working locally. Its extended summary stays readable when it wraps across the card."
        status="working"
        action={{ label: 'Open agent details', onAction: () => setMessage('Agent action: Open agent details') }}
      />
      <Status name="agent-card">{message}</Status>
    </Category>
  )
}

const TOOL_ICON_SAMPLES: readonly [name: string, hue: UiToolHue][] = [
  ['git-branch', 'blue'], ['tray', 'violet'], ['list-checks', 'teal'], ['robot', 'coral'], ['flow-arrow', 'magenta'],
  ['device-mobile', 'slate'], ['git-diff', 'azure'], ['folders', 'sand'], ['check-circle', 'mint'],
  ['chat-circle-dots', 'lilac'], ['git-pull-request', 'rose'], ['book-open-text', 'tan'], ['terminal-window', 'cyan'], ['command', 'plum']
]
const CONTROL_ICON_SAMPLES = ['plus', 'magnifying-glass', 'dots-three', 'minus', 'caret-down', 'arrows-clockwise', 'funnel', 'export', 'x', 'gear', 'globe']
const FILE_SAMPLES = ['App.tsx', 'server.ts', 'main.py', 'lib.rs', 'main.go', 'README.md', 'package.json', 'Dockerfile', '.gitignore', 'styles.css', 'bun.lock', 'logo.png', 'unknown.xyz', 'Makefile']
const PROJECT_SAMPLES: readonly [name: string, color: string | null][] = [
  ['quirky', null], ['orca-fork', null], ['web_app', null], ['api', null], ['docs site', null], ['mobile', null], ['brand', '#c0408a'], ['status-clash', '#4cc38a']
]

function ToolIconDemo({ theme }: { theme: Theme }) {
  return (
    <Category name="ToolIcon" theme={theme}>
      <div className="ui-cluster">
        {TOOL_ICON_SAMPLES.map(([name, hue]) => <ToolIcon key={name} name={name} hue={hue} size={20} label={`${name} in ${hue}`} />)}
        <ToolIcon name="not-an-icon" hue="slate" size={20} label="Unknown icon" />
      </div>
    </Category>
  )
}

function ControlIconDemo({ theme }: { theme: Theme }) {
  return (
    <Category name="ControlIcon" theme={theme}>
      <div className="ui-cluster">
        {CONTROL_ICON_SAMPLES.map((name) => <ControlIcon key={name} name={name} size={20} label={name} />)}
      </div>
    </Category>
  )
}

function FileIconDemo({ theme }: { theme: Theme }) {
  return (
    <Category name="FileIcon" theme={theme}>
      <div className="ui-cluster">
        {FILE_SAMPLES.map((path) => <FileIcon key={path} path={path} size={20} label={path} />)}
      </div>
    </Category>
  )
}

function ProjectTileDemo({ theme }: { theme: Theme }) {
  return (
    <Category name="ProjectTile" theme={theme}>
      <div className="ui-cluster">
        {PROJECT_SAMPLES.map(([name, color]) => <ProjectTile key={name} name={name} color={color} size={24} label={`${name} project`} />)}
      </div>
    </Category>
  )
}

function PopupMenuDemo({ theme }: { theme: Theme }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [choice, setChoice] = useState('No popup choice yet')
  const choose = (label: string) => () => setChoice(`Popup choice: ${label}`)
  return (
    <Category name="PopupMenu" theme={theme}>
      <Button onClick={(event) => setAnchor(event.currentTarget)}>Open popup</Button>
      <Status name="popup">{choice}</Status>
      {anchor ? (
        <PopupMenu
          anchor={anchor}
          title="Projects"
          searchPlaceholder="Search projects"
          onClose={() => setAnchor(null)}
          items={[
            { label: 'All projects', onSelect: choose('All projects'), lead: <ControlIcon name="globe" /> },
            { label: 'Recent', heading: true },
            { label: 'quirky', subtitle: '4 worktrees', selected: true, lead: <ProjectTile name="quirky" />, trailing: <Badge tone="working" label="2 working">2</Badge>, onSelect: choose('quirky') },
            { label: 'orca-fork', subtitle: '1 worktree', lead: <ProjectTile name="orca-fork" />, key: '⌘2', onSelect: choose('orca-fork') },
            { label: 'web_app', subtitle: '3 worktrees', lead: <ProjectTile name="web_app" />, trailing: <Badge tone="needs-you" label="1 needs you">1</Badge>, onSelect: choose('web_app') },
            { label: 'Add project', separatorBefore: true, lead: <ControlIcon name="plus" />, onSelect: choose('Add project') }
          ]}
        />
      ) : null}
    </Category>
  )
}

function ThemeGallery({ theme, label }: { theme: Theme; label: string }) {
  return (
    <section className="ui-gallery-theme" data-theme={theme} aria-label={`${label} theme component examples`}>
      <h2>{label}</h2>
      <div className="ui-stack">
        <ButtonDemo theme={theme} />
        <IconButtonDemo theme={theme} />
        <TextFieldDemo theme={theme} />
        <ListRowDemo theme={theme} />
        <SectionHeaderDemo theme={theme} />
        <TabsDemo theme={theme} />
        <BadgeDemo theme={theme} />
        <StatusDotDemo theme={theme} />
        <MenuDemo theme={theme} />
        <ToastDemo theme={theme} />
        <DialogDemo theme={theme} />
        <EmptyStateDemo theme={theme} />
        <FormRowDemo theme={theme} />
        <ToolPanelFrameDemo theme={theme} />
        <InlineAgentCardDemo theme={theme} />
        <ToolIconDemo theme={theme} />
        <ControlIconDemo theme={theme} />
        <FileIconDemo theme={theme} />
        <ProjectTileDemo theme={theme} />
        <PopupMenuDemo theme={theme} />
      </div>
    </section>
  )
}

export function Gallery() {
  return (
    <main className="ui-gallery">
      <header className="ui-stack">
        <h1>Quirky UI gallery</h1>
        <p>Explore the shared components side by side. These demos use local state only and do not connect to a daemon.</p>
      </header>
      <div className="ui-gallery-grid">
        <ThemeGallery theme="dark" label="Dark theme" />
        <ThemeGallery theme="light" label="Light theme" />
      </div>
    </main>
  )
}

const galleryRoot = document.getElementById('root')
if (galleryRoot) createRoot(galleryRoot).render(<Gallery />)
