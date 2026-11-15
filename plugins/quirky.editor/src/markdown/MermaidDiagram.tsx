import React, { useEffect, useId, useMemo, useRef, useState } from 'react'
import DOMPurify from 'dompurify'
import { InlineError, NoticeLine, uiTokens } from '@quirky/ui'
import { useEditorUiControl, useEditorUiControlContext, type EditorUiControl } from '../window/uiControl'

type MermaidApi = {
  initialize(options: {
    startOnLoad: boolean
    securityLevel: 'strict'
    theme: 'base'
    themeVariables: Record<string, string>
  }): void
  render(id: string, source: string): Promise<{ svg: string }>
}
type MermaidPackage = { default: MermaidApi }

let mermaidModule: Promise<MermaidPackage> | null = null
let nextDiagramOrdinal = 0

function loadMermaid(): Promise<MermaidPackage> {
  // Mermaid is a large diagram parser; keep it out of the editor bundle until a Mermaid block is rendered.
  if (!mermaidModule) {
    const pending = import('mermaid') as Promise<MermaidPackage>
    mermaidModule = pending
    void pending.catch(() => { if (mermaidModule === pending) mermaidModule = null })
  }
  return mermaidModule
}

function mermaidThemeVariables(): Record<string, string> {
  const styles = getComputedStyle(document.documentElement)
  const surface = styles.getPropertyValue(uiTokens.color.surface).trim()
  const rail = styles.getPropertyValue(uiTokens.color.rail).trim()
  const selected = styles.getPropertyValue(uiTokens.color.selected).trim()
  const border = styles.getPropertyValue(uiTokens.color.border).trim()
  const text = styles.getPropertyValue(uiTokens.color.text).trim()
  const muted = styles.getPropertyValue(uiTokens.color.muted).trim()

  return {
    background: surface,
    primaryColor: selected,
    primaryTextColor: text,
    primaryBorderColor: border,
    secondaryColor: rail,
    secondaryTextColor: text,
    secondaryBorderColor: border,
    tertiaryColor: selected,
    tertiaryTextColor: text,
    tertiaryBorderColor: border,
    mainBkg: surface,
    mainTextColor: text,
    nodeBorder: border,
    lineColor: muted,
    textColor: text,
  }
}
export function MermaidDiagram({ source }: { source: string }): React.JSX.Element {
  const id = `quirky-mermaid-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const context = useEditorUiControlContext()
  const [ordinal] = useState(() => ++nextDiagramOrdinal)
  const [retry, setRetry] = useState(0)
  const [themeRevision, setThemeRevision] = useState(0)
  const session = useMemo(() => ({ generation: crypto.randomUUID() }), [source, themeRevision])
  const [result, setResult] = useState<{ session: typeof session; svg: string; error: string | null }>({ session, svg: '', error: null })
  const pendingRetry = useRef(false)
  const currentSession = useRef(session)
  currentSession.current = session
  const svg = result.session === session ? result.svg : ''
  const error = result.session === session ? result.error : null

  async function handleControl(control: EditorUiControl) {
    if (control.action !== 'retry' || (control.data !== undefined && Reflect.ownKeys(control.data).length !== 0) ||
      !error || pendingRetry.current) return { delivered: false }
    pendingRetry.current = true
    setResult({ session, svg: '', error: null })
    setRetry((value) => value + 1)
    return { delivered: true }
  }
  function onControlError(cause: Error) {
    setResult({ session, svg, error: cause.message })
  }
  const controls = useEditorUiControl({
    context,
    address: { surface: 'view:quirky.editor/document', target: `markdown-mermaid:${ordinal}`, generation: session.generation, actions: error ? ['retry'] : [] },
    handler: handleControl,
    onError: onControlError
  })
  function dispatchRetry() { void controls.run('retry') }

  useEffect(() => {
    const root = document.documentElement
    const observer = new MutationObserver(() => setThemeRevision((revision) => revision + 1))
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme', 'style'] })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    let active = true
    pendingRetry.current = false
    setResult({ session, svg: '', error: null })
    loadMermaid().then(async (module) => {
      if (!active || currentSession.current !== session) return
      module.default.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'base',
        themeVariables: mermaidThemeVariables()
      })
      const rendered = await module.default.render(id, source)
      if (active && currentSession.current === session) {
        setResult({ session, svg: DOMPurify.sanitize(rendered.svg, { USE_PROFILES: { svg: true, svgFilters: true } }), error: null })
      }
    }).catch((cause: unknown) => {
      if (active && currentSession.current === session) {
        setResult({ session, svg: '', error: cause instanceof Error ? cause.message : String(cause) })
      }
    })
    return () => { active = false }
  }, [id, retry, session, source])

  if (error) return <div className="markdown-mermaid-error"><InlineError message={`Mermaid preview failed. ${error}`} action={{ label: 'Retry', onAction: dispatchRetry }} /><details><summary>Source</summary><pre>{source}</pre></details></div>
  if (!svg) return <div className="markdown-mermaid-loading"><NoticeLine>Rendering diagram…</NoticeLine></div>
  return <div className="markdown-mermaid" role="img" aria-label="Mermaid diagram" dangerouslySetInnerHTML={{ __html: svg }} />
}
