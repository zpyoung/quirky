import { useEffect, useRef, useState } from 'react'
import type { UiToolResize } from '@quirky/protocol'
import { useShortcuts } from './components/useShortcuts'
import { ConfirmHost } from './components/ConfirmHost'
import { ConnectionBanner } from './components/ConnectionBanner'
import { MainArea } from './components/MainArea'
import { SettingsDialog } from './components/SettingsDialog'
import { Toasts } from './components/Toasts'
import { useAppState, usePluginHost, usePluginState } from './context'
import { CommandPalette } from './plugins/CommandPalette'
import { OverlayLayer } from './plugins/OverlayLayer'
import { useThemeVariables } from './plugins/useThemeVariables'
import { ShellStatusBar, ShellTitleBar } from './shell/ShellChrome'
import {
  fitToolShellGeometry,
  getToolShellOpenSlots,
  readToolShellChrome,
  ToolShell,
  toolShellCssVariables,
  type ToolShellChrome
} from './shell/ToolShell'

function NoToken() {
  return (
    <div className="fullscreen-message">
      <h1>Not connected</h1>
      <p>
        This page needs an access token. Open Quirky from the desktop app, or use the URL the daemon
        prints, which ends in <code>#token=…</code>.
      </p>
    </div>
  )
}

const EMPTY_TOOL_SIZES = {
  left: 0,
  right: 0,
  bottom: 0,
  leftSplit: 0.5,
  rightSplit: 0.5,
  bottomSplit: 0.5
} as const

const EMPTY_CHROME: ToolShellChrome = { rail: 0, splitter: 0, centerMinWidth: 0, centerMinHeight: 0 }

type WorkspaceMeasurement = { width: number; height: number; chrome: ToolShellChrome }

export function App() {
  const state = useAppState()
  const { model, layout, windowRoute } = usePluginState()
  const host = usePluginHost()
  const workspace = useRef<HTMLDivElement>(null)
  const [measurement, setMeasurement] = useState<WorkspaceMeasurement>({ width: 0, height: 0, chrome: EMPTY_CHROME })
  const [resizePreview, setResizePreview] = useState<Partial<UiToolResize>>({})
  const [settingsOpen, setSettingsOpen] = useState(false)
  const auxiliary = windowRoute !== null
  useShortcuts()
  useThemeVariables()

  useEffect(() => {
    if (auxiliary || state.connection === 'no-token') return
    const element = workspace.current
    if (!element) return
    const update = () => {
      const rect = element.getBoundingClientRect()
      const chrome = readToolShellChrome(element)
      setMeasurement((current) =>
        current.width === rect.width &&
        current.height === rect.height &&
        current.chrome.rail === chrome.rail &&
        current.chrome.splitter === chrome.splitter &&
        current.chrome.centerMinWidth === chrome.centerMinWidth &&
        current.chrome.centerMinHeight === chrome.centerMinHeight
          ? current
          : { width: rect.width, height: rect.height, chrome }
      )
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [auxiliary, state.connection])

  if (state.connection === 'no-token') return <NoToken />

  const baseSizes = layout.tools?.sizes ?? EMPTY_TOOL_SIZES
  const sizes = { ...baseSizes, ...resizePreview }
  const openSlots = getToolShellOpenSlots(model?.tools ?? [], layout.tools)
  const geometry = fitToolShellGeometry(
    sizes,
    { width: measurement.width, height: measurement.height },
    openSlots,
    measurement.chrome
  )
  const shellStyle = toolShellCssVariables(geometry)
  const onResizePreview = (key: keyof UiToolResize, value: number | null) => {
    setResizePreview((current) => {
      const next = { ...current }
      if (value === null) delete next[key]
      else next[key] = value
      return next
    })
  }
  const onResizeCommit = (patch: UiToolResize) => {
    host.resizeTools(patch)
    setResizePreview({})
  }

  return (
    <div className="app">
      <ConnectionBanner />
      {auxiliary ? (
        <div className="shell-workspace shell-workspace--auxiliary">
          <MainArea />
        </div>
      ) : (
        <>
          <ShellTitleBar onSettings={() => setSettingsOpen(true)} />
          <div ref={workspace} className="shell-workspace" style={shellStyle}>
            <ToolShell
              geometry={geometry}
              sizes={sizes}
              onResizePreview={onResizePreview}
              onResizeCommit={onResizeCommit}
            />
            <div className="shell-main-region">
              <MainArea />
            </div>
          </div>
          <ShellStatusBar />
        </>
      )}
      <OverlayLayer />
      {layout.palette === true && <CommandPalette onClose={() => host.setPalette(false)} />}
      <Toasts />
      <ConfirmHost />
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
    </div>
  )
}
