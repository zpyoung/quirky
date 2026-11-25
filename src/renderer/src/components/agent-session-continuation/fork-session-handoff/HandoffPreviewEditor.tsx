import React, { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import { LockKeyhole, RefreshCw } from 'lucide-react'
import { installMonacoEditorFindShortcut } from '@/components/editor/editor-shortcuts'
import { isMonacoFindWidgetOpen } from '@/components/editor/monaco-find-widget'
import { syncContentOnMount, syncContentUpdate } from '@/components/editor/monaco-content-sync'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { computeEditorFontSize, resolveEditorFontFamily } from '@/lib/editor-font-zoom'
import { useDocumentDarkTheme } from '@/hooks/use-document-dark-theme'
import '@/lib/monaco-setup'
import { useAppStore } from '@/store'
import type { SecretScanHit } from '@/lib/fork-session-handoff/handoff-secret-scan'
import { HANDOFF_PREVIEW_EDITOR_SLOT } from './handoff-preview-editor-slot'
import { monacoThemeFor } from '@/lib/monaco-graphite-theme'

type HandoffPreviewEditorProps = {
  value: string
  safetyBlock: string
  charCount: number
  tokenEstimate: number
  secretHits: SecretScanHit[]
  detached: boolean
  onChange: (value: string) => void
  onRegenerate: () => void
  onDismiss?: () => void
}

export function HandoffPreviewEditor({
  value,
  safetyBlock,
  charCount,
  tokenEstimate,
  secretHits,
  detached,
  onChange,
  onRegenerate,
  onDismiss
}: HandoffPreviewEditorProps): React.JSX.Element {
  const settings = useAppStore((state) => state.settings)
  const editorFontZoomLevel = useAppStore((state) => state.editorFontZoomLevel)
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const decorationsRef = useRef<editor.IEditorDecorationsCollection | null>(null)
  const valueRef = useRef(value)
  const lastSyncedValueRef = useRef(value)
  const programmaticChangeRef = useRef(false)
  const dismissRef = useRef(onDismiss)

  useLayoutEffect(() => {
    dismissRef.current = onDismiss
  }, [onDismiss])

  const fontSize = computeEditorFontSize(settings?.terminalFontSize ?? 13, editorFontZoomLevel)
  const fontFamily = resolveEditorFontFamily(settings)
  const isDark = useDocumentDarkTheme()
  const options = useMemo<editor.IStandaloneEditorConstructionOptions>(
    () => ({
      ariaLabel: translate(
        'components.agentSessionContinuation.forkSessionHandoff.previewAriaLabel',
        'Editable session handoff brief'
      ),
      automaticLayout: true,
      contextmenu: true,
      fontFamily,
      fontSize,
      folding: false,
      glyphMargin: false,
      lineDecorationsWidth: 8,
      lineNumbers: 'on',
      lineNumbersMinChars: 3,
      minimap: { enabled: false },
      padding: { top: 12, bottom: 12 },
      renderLineHighlight: 'line',
      scrollBeyondLastLine: false,
      stickyScroll: { enabled: false },
      wordWrap: 'on',
      wrappingIndent: 'same'
    }),
    [fontFamily, fontSize]
  )

  const handleChange = useCallback(
    (nextValue: string | undefined) => {
      if (programmaticChangeRef.current) {
        return
      }
      const next = nextValue ?? ''
      lastSyncedValueRef.current = next
      onChange(next)
    },
    [onChange]
  )

  const handleMount = useCallback<OnMount>((editorInstance) => {
    editorRef.current = editorInstance
    const cleanupFind = installMonacoEditorFindShortcut(editorInstance)
    const cleanupEscape = installEscapeDismiss(editorInstance.getContainerDomNode(), dismissRef)
    programmaticChangeRef.current = true
    try {
      if (syncContentOnMount(editorInstance, valueRef.current)) {
        lastSyncedValueRef.current = valueRef.current
      }
    } finally {
      programmaticChangeRef.current = false
    }
    decorationsRef.current = editorInstance.createDecorationsCollection()
    editorInstance.onDidDispose(() => {
      cleanupFind()
      cleanupEscape()
      decorationsRef.current = null
      if (editorRef.current === editorInstance) {
        editorRef.current = null
      }
    })
  }, [])

  useLayoutEffect(() => {
    valueRef.current = value
    const mountedEditor = editorRef.current
    if (!mountedEditor || lastSyncedValueRef.current === value) {
      return
    }
    programmaticChangeRef.current = true
    try {
      syncContentUpdate(mountedEditor, value)
      lastSyncedValueRef.current = value
    } finally {
      programmaticChangeRef.current = false
    }
  }, [value])

  useLayoutEffect(() => {
    const mountedEditor = editorRef.current
    const model = mountedEditor?.getModel()
    if (!model || !decorationsRef.current) {
      return
    }
    decorationsRef.current.set(
      secretHits.flatMap((hit) => {
        if (hit.start < 0 || hit.end <= hit.start || hit.end > model.getValueLength()) {
          return []
        }
        const start = model.getPositionAt(hit.start)
        const end = model.getPositionAt(hit.end)
        return [
          {
            range: {
              startLineNumber: start.lineNumber,
              startColumn: start.column,
              endLineNumber: end.lineNumber,
              endColumn: end.column
            },
            options: {
              inlineClassName: 'bg-destructive/20 border-b border-destructive',
              hoverMessage: {
                value: translate(
                  'components.agentSessionContinuation.forkSessionHandoff.secretMarkerHover',
                  'Potential secret: {{excerpt}}',
                  { excerpt: hit.redactedExcerpt }
                )
              },
              stickiness: 1
            }
          }
        ]
      })
    )
  }, [secretHits, value])

  return (
    <section
      className="flex min-h-0 min-w-0 flex-col gap-2"
      aria-labelledby="handoff-preview-title"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 id="handoff-preview-title" className="text-xs font-medium">
            {translate(
              'components.agentSessionContinuation.forkSessionHandoff.preview',
              'Brief preview'
            )}
          </h3>
          <p className="text-[11px] text-muted-foreground">
            {translate(
              'components.agentSessionContinuation.forkSessionHandoff.costReadout',
              '{{characters}} characters · about {{tokens}} tokens',
              { characters: charCount.toLocaleString(), tokens: tokenEstimate.toLocaleString() }
            )}
          </p>
        </div>
        {detached ? (
          <Button type="button" variant="outline" size="sm" onClick={onRegenerate}>
            <RefreshCw className="size-4" aria-hidden="true" />
            {translate(
              'components.agentSessionContinuation.forkSessionHandoff.regenerate',
              'Regenerate from controls'
            )}
          </Button>
        ) : null}
      </div>

      {detached ? (
        <p className="rounded-md border border-border bg-muted/40 px-2 py-1.5 text-[11px] text-muted-foreground">
          {translate(
            'components.agentSessionContinuation.forkSessionHandoff.detachedNotice',
            'The preview is no longer auto-updating. Regenerating discards your edits.'
          )}
        </p>
      ) : null}

      <div
        data-slot={HANDOFF_PREVIEW_EDITOR_SLOT}
        className="relative h-[min(48vh,34rem)] min-h-72 overflow-hidden rounded-md border border-border bg-editor-surface focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50"
      >
        <Editor
          height="100%"
          defaultLanguage="plaintext"
          defaultValue={value}
          theme={monacoThemeFor(isDark)}
          onChange={handleChange}
          onMount={handleMount}
          options={options}
          loading={<div className="h-full w-full bg-editor-surface" aria-hidden="true" />}
        />
      </div>

      {secretHits.length > 0 ? (
        <p className="text-[11px] text-destructive">
          {translate(
            'components.agentSessionContinuation.forkSessionHandoff.secretMarkersShown',
            '{{count}} potential secret markers are highlighted in the preview.',
            { count: secretHits.length }
          )}
        </p>
      ) : null}

      <div className="rounded-md border border-border bg-muted/40 p-3">
        <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
          <LockKeyhole className="size-3.5" aria-hidden="true" />
          {translate(
            'components.agentSessionContinuation.forkSessionHandoff.lockedSafetyBlock',
            'Locked safety note · always appended last'
          )}
        </div>
        <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-4 text-foreground/80">
          {safetyBlock}
        </pre>
      </div>
    </section>
  )
}

function installEscapeDismiss(
  target: HTMLElement,
  onDismissRef: { current?: () => void }
): () => void {
  const handleEscape = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || event.repeat || isMonacoFindWidgetOpen(target)) {
      return
    }
    if (!onDismissRef.current) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    onDismissRef.current()
  }
  target.addEventListener('keydown', handleEscape, true)
  return () => target.removeEventListener('keydown', handleEscape, true)
}
