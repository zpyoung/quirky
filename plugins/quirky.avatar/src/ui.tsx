import { useEffect, useState, type ComponentType } from 'react'
import { createRoot } from 'react-dom/client'
import type { MountFunction, UiPluginContext } from '@quirky/protocol'
import type { AvatarUiProps } from './contracts'
import AvatarView from './ui/AvatarView'
import Panel from './ui/Panel'
import Pill from './ui/Pill'
import SettingsSection from './ui/SettingsSection'
import Sheet from './ui/Sheet'

const PILL = 'window-bar-item:quirky.avatar/pill'
const PANEL = 'panel:quirky.avatar/panel'
const VIEW = 'view:quirky.avatar/avatar'
const SHEET = 'overlay:quirky.avatar/sheet'
const SETTINGS = 'settings-section:quirky.avatar/avatar'
const HANDOFF_COMMAND = 'command:quirky.avatar/handoff'
const OPEN_REPORT_COMMAND = 'command:quirky.avatar/open-report'

type SheetInput = { worktreeIds?: string[] }

let sheetInput: SheetInput | null = null
const sheetListeners = new Set<() => void>()

function setSheet(next: SheetInput | null): void {
  sheetInput = next
  for (const listener of [...sheetListeners]) listener()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sheetInputOf(raw: unknown): SheetInput {
  if (!isRecord(raw) || !Array.isArray(raw.worktreeIds)) return {}
  return { worktreeIds: raw.worktreeIds.filter((id): id is string => typeof id === 'string') }
}

function SheetHost({ context }: { context: UiPluginContext }) {
  const [input, setInput] = useState(sheetInput)
  useEffect(() => {
    const listener = () => setInput(sheetInput)
    sheetListeners.add(listener)
    listener()
    return () => void sheetListeners.delete(listener)
  }, [])
  return input === null ? null : <Sheet context={context} input={input} onClose={() => setSheet(null)} />
}

function mounted(context: UiPluginContext, Component: ComponentType<AvatarUiProps>): MountFunction {
  return (element, props) => {
    const root = createRoot(element)
    root.render(<Component context={context} input={props.input} />)
    return () => root.unmount()
  }
}

/** Provides the pill, panel, view, hand-off sheet, settings section and the two commands. */
export function activate(context: UiPluginContext): void {
  setSheet(null)
  context.provide(PILL, mounted(context, Pill))
  context.provide(PANEL, mounted(context, Panel))
  context.provide(VIEW, mounted(context, AvatarView))
  context.provide(SETTINGS, mounted(context, SettingsSection))
  context.provide(SHEET, ((element: HTMLElement) => {
    element.style.display = 'contents'
    const root = createRoot(element)
    root.render(<SheetHost context={context} />)
    return () => root.unmount()
  }) satisfies MountFunction)
  context.provide(HANDOFF_COMMAND, (raw?: unknown) => {
    setSheet(sheetInputOf(raw))
  })
  context.provide(OPEN_REPORT_COMMAND, () => {
    context.openView(VIEW, { tab: 'report' })
  })
}

export function deactivate(): void {
  setSheet(null)
}
