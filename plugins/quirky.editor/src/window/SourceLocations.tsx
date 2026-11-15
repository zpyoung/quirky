import { useEffect, useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { ControlIcon, EmptyState, IconButton, InlineError, ListRow, NoticeLine, SectionHeader } from '@quirky/ui'
import type { UiPluginContext } from '@quirky/protocol'
import type { EditorUiControl, EditorUiControlAddress, EditorUiControlResult } from './uiControl'
import { useEditorUiControl, useEditorUiControlReport } from './uiControl'
import type { NavigationPosition, SourceLocationsPanel as PanelState, SourceSymbolsController, SourceSymbolsKind, SourceSymbolsReport } from './sourceNavigation'

const SOURCE_CONTROL_SURFACE = 'view:quirky.editor/document'
type SourceControlRunner = (action: string, data?: Record<string, unknown>) => Promise<EditorUiControlResult>
type Props = {
  context: UiPluginContext
  bufferId: string
  tabId: string | null
  sourceGeneration: string | null
  enabled: boolean
  controller: SourceSymbolsController
  isValidPosition(position: NavigationPosition): boolean
  focusEditor(): void
  onSourceControlRunner(runner: SourceControlRunner | null): void
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Reflect.ownKeys(value).every((key) => typeof key === 'string' && allowed.includes(key))
}
function positionFromData(data: Record<string, unknown>, isValid: (position: NavigationPosition) => boolean): NavigationPosition | null | false {
  const hasLine = Object.hasOwn(data, 'line')
  const hasColumn = Object.hasOwn(data, 'column')
  if (!hasLine && !hasColumn) return null
  if (!hasLine || !hasColumn || !Number.isSafeInteger(data.line) || (data.line as number) < 1 ||
      !Number.isSafeInteger(data.column) || (data.column as number) < 1) return false
  const position = { line: data.line as number, column: data.column as number }
  return isValid(position) ? position : false
}
function titleOf(panel: PanelState): string {
  const relation = panel.kind === 'definition' ? ' of ' : ' to '
  const subject = panel.label ? `${relation}${panel.label}` : ''
  return panel.kind === 'definition' ? `Definitions${subject}` : `References${subject}`
}
function resultCount(panel: PanelState): number | null {
  return panel.status === 'list' || panel.status === 'empty' ? panel.locations.length : null
}
function listButtons(root: HTMLElement | null): HTMLButtonElement[] {
  return root ? Array.from(root.querySelectorAll<HTMLButtonElement>('.qe-source-locations__rows .ui-list-row__main:not(:disabled)')) : []
}

export function SourceLocations({
  context,
  bufferId,
  tabId,
  sourceGeneration,
  enabled,
  controller,
  isValidPosition,
  focusEditor,
  onSourceControlRunner
}: Props) {
  const report = useEditorUiControlReport()
  const identity = JSON.stringify([bufferId, tabId])
  const sourceAddress: EditorUiControlAddress | null = enabled && sourceGeneration !== null
    ? {
        surface: SOURCE_CONTROL_SURFACE,
        target: `source-symbols:${identity}`,
        generation: sourceGeneration,
        actions: ['definition', 'references']
      }
    : null
  const panel = controller.panel
  const openable = panel?.locations.some((location) => location.relativePath !== null) ?? false
  const locationActions = panel === null
    ? []
    : [
        'close',
        ...(openable ? ['open'] : []),
        ...(panel.status === 'error' && panel.retryable ? ['retry'] : [])
      ]
  const locationsAddress: EditorUiControlAddress | null = panel === null
    ? null
    : {
        surface: SOURCE_CONTROL_SURFACE,
        target: `source-locations:${identity}`,
        generation: panel.generation,
        actions: locationActions
      }

  const sourceHandler = async (control: EditorUiControl): Promise<EditorUiControlResult> => {
    if (!enabled || sourceGeneration === null || control.generation !== sourceGeneration) return { delivered: false }
    const data = control.data ?? {}
    if (!onlyKeys(data, ['line', 'column'])) return { delivered: false }
    const position = positionFromData(data, isValidPosition)
    if (position === false) return { delivered: false }
    const kind = control.action as SourceSymbolsKind
    if (kind !== 'definition' && kind !== 'references') return { delivered: false }
    return { delivered: controller.control(kind, position ?? undefined) }
  }
  const locationHandler = async (control: EditorUiControl): Promise<EditorUiControlResult> => {
    if (!panel || control.generation !== panel.generation) return { delivered: false }
    const data = control.data ?? {}
    if (control.action === 'close') {
      if (!onlyKeys(data, [])) return { delivered: false }
      return { delivered: controller.close(panel.generation) }
    }
    if (control.action === 'open') {
      if (!onlyKeys(data, ['index']) || !Number.isSafeInteger(data.index) || (data.index as number) < 0) return { delivered: false }
      return { delivered: controller.open(data.index as number, panel.generation) }
    }
    if (control.action === 'retry') {
      if (!onlyKeys(data, [])) return { delivered: false }
      return { delivered: controller.retry(panel.generation) }
    }
    return { delivered: false }
  }
  const sourceControls = useEditorUiControl({ context, address: sourceAddress, handler: sourceHandler })
  const locationControls = useEditorUiControl({ context, address: locationsAddress, handler: locationHandler })

  useEffect(() => {
    onSourceControlRunner(sourceControls.run)
    return () => onSourceControlRunner(null)
  }, [onSourceControlRunner, sourceControls.run])

  const summary: SourceSymbolsReport = controller.report
  useEffect(() => {
    report({ sourceSymbols: summary })
  }, [report, summary.status, summary.kind, summary.count, summary.truncated, summary.error])

  const panelRoot = useRef<HTMLElement>(null)
  useEffect(() => {
    if (!panel || panel.status !== 'list' || !panel.focusResults) return
    listButtons(panelRoot.current)[0]?.focus()
  }, [panel?.generation, panel?.status, panel?.focusResults])

  if (!panel) return null
  const count = resultCount(panel)
  const close = () => { void locationControls.run('close') }
  const onEscape = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    void locationControls.run('close').then((result) => { if (result.delivered) focusEditor() })
  }
  const onRowsKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const keys: Record<string, number> = { ArrowDown: 1, ArrowUp: -1, Home: -2, End: 2 }
    const direction = keys[event.key]
    if (direction === undefined) return
    const buttons = listButtons(panelRoot.current)
    if (buttons.length === 0) return
    event.preventDefault()
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next = direction === -2 ? 0
      : direction === 2 ? buttons.length - 1
        : index < 0 ? 0
          : Math.max(0, Math.min(buttons.length - 1, index + direction))
    buttons[next]?.focus()
  }

  return (
    <section className="qe-source-locations" aria-label={titleOf(panel)} ref={panelRoot} onKeyDown={onEscape}>
      <SectionHeader
        title={titleOf(panel)}
        actions={<>
          {count !== null && <span className="qe-source-locations__count">{count} results</span>}
          <IconButton label="Close results" onClick={close}><ControlIcon name="x" /></IconButton>
        </>}
      />
      {panel.status === 'pending' && (
        <div className="qe-source-locations__message" role="status" aria-live="polite">
          <NoticeLine>{panel.kind === 'definition' ? 'Finding definitions…' : 'Finding references…'}</NoticeLine>
        </div>
      )}
      {panel.status === 'empty' && (
        <EmptyState message={`No ${panel.kind === 'definition' ? 'definition' : 'references'} found at line ${panel.position?.line ?? 1}, column ${panel.position?.column ?? 1}.`} />
      )}
      {panel.status === 'error' && panel.error && (
        <div className="qe-source-locations__message">
          <InlineError
            message={panel.error}
            action={panel.retryable ? { label: 'Retry', onAction: () => { void locationControls.run('retry') } } : undefined}
          />
        </div>
      )}
      {panel.status === 'list' && (
        <div className="qe-source-locations__rows" aria-label={`${count ?? 0} source locations`} onKeyDown={onRowsKeyDown}>
          {panel.locations.map((location, index) => {
            const title = `${location.relativePath ?? location.path}:${location.line}:${location.column}`
            const description = location.relativePath === null
              ? `${location.preview} · Outside this worktree`
              : location.preview
            return (
              <ListRow
                key={`${location.path}:${location.line}:${location.column}:${index}`}
                title={title}
                description={description}
                disabled={location.relativePath === null}
                onClick={location.relativePath === null ? undefined : () => { void locationControls.run('open', { index }) }}
              />
            )
          })}
          {panel.truncated && (
            <div className="qe-source-locations__message">
              <NoticeLine>Showing the first 1,000 results. Navigation found more.</NoticeLine>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
