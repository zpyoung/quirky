import React, { useEffect, useId, useState } from 'react'
import DOMPurify from 'dompurify'

type MermaidApi = {
  initialize(options: { startOnLoad: boolean; securityLevel: 'strict' }): void
  render(id: string, source: string): Promise<{ svg: string }>
}
type MermaidPackage = { default: MermaidApi }

let mermaidModule: Promise<MermaidPackage> | null = null

function loadMermaid(): Promise<MermaidPackage> {
  // Mermaid is a large diagram parser; keep it out of the editor bundle until a Mermaid block is rendered.
  mermaidModule ??= import('mermaid') as Promise<MermaidPackage>
  return mermaidModule
}

export function MermaidDiagram({ source }: { source: string }): React.JSX.Element {
  const id = `quirky-mermaid-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const [svg, setSvg] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let active = true
    setSvg('')
    setError(null)
    loadMermaid().then(async (module) => {
      module.default.initialize({ startOnLoad: false, securityLevel: 'strict' })
      const rendered = await module.default.render(id, source)
      if (active) setSvg(DOMPurify.sanitize(rendered.svg, { USE_PROFILES: { svg: true, svgFilters: true } }))
    }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : String(cause))
    })
    return () => { active = false }
  }, [id, retry, source])

  if (error) return <div role="status" className="markdown-mermaid-error">Mermaid preview failed. <button type="button" onClick={() => setRetry((value) => value + 1)}>Retry</button><details><summary>Source</summary><pre>{source}</pre></details></div>
  if (!svg) return <div role="status" className="markdown-mermaid-loading">Rendering diagram…</div>
  return <div className="markdown-mermaid" role="img" aria-label="Mermaid diagram" dangerouslySetInnerHTML={{ __html: svg }} />
}
