import React, { useEffect, useId, useState } from 'react'
import DOMPurify from 'dompurify'
import { Button, uiTokens } from '@quirky/ui'

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

function loadMermaid(): Promise<MermaidPackage> {
  // Mermaid is a large diagram parser; keep it out of the editor bundle until a Mermaid block is rendered.
  mermaidModule ??= import('mermaid') as Promise<MermaidPackage>
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
  const [svg, setSvg] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const [themeRevision, setThemeRevision] = useState(0)

  useEffect(() => {
    const root = document.documentElement
    const observer = new MutationObserver(() => setThemeRevision((revision) => revision + 1))
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme', 'style'] })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    let active = true
    setSvg('')
    setError(null)
    loadMermaid().then(async (module) => {
      module.default.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'base',
        themeVariables: mermaidThemeVariables()
      })
      const rendered = await module.default.render(id, source)
      if (active) setSvg(DOMPurify.sanitize(rendered.svg, { USE_PROFILES: { svg: true, svgFilters: true } }))
    }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : String(cause))
    })
    return () => { active = false }
  }, [id, retry, source, themeRevision])

  if (error) return <div role="status" className="markdown-mermaid-error">Mermaid preview failed. <Button type="button" onClick={() => setRetry((value) => value + 1)}>Retry</Button><details><summary>Source</summary><pre>{source}</pre></details></div>
  if (!svg) return <div role="status" className="markdown-mermaid-loading">Rendering diagram…</div>
  return <div className="markdown-mermaid" role="img" aria-label="Mermaid diagram" dangerouslySetInnerHTML={{ __html: svg }} />
}
