import { useEffect, useId, useState } from 'react'
import DOMPurify from 'dompurify'
import { Button } from '@/components/ui/button'
import type { FenceProps } from '../types'
import { BlockFrame, CodeBlock, CopyButton } from './CodeBlock'
import { loadsImages, NO_HTML_LABELS, withRemoteImagesBlocked } from './mermaid-safety'
import { RenderError } from './RenderError'

type Outcome =
  | { kind: 'pending' }
  | { kind: 'ready'; svg: string }
  | { kind: 'failed'; message: string }

const THEME_TOKENS: Record<string, string> = {
  background: '--background',
  primaryColor: '--muted',
  primaryTextColor: '--foreground',
  primaryBorderColor: '--muted-foreground',
  secondaryColor: '--accent',
  tertiaryColor: '--background',
  lineColor: '--muted-foreground',
  textColor: '--foreground',
  noteBkgColor: '--muted',
  noteTextColor: '--foreground'
}

/** Mermaid takes concrete colours, so the tokens are read as the page computes them right now. */
function themeVariables(): Record<string, string> {
  const style = getComputedStyle(document.documentElement)
  const variables: Record<string, string> = { fontFamily: 'inherit' }
  for (const [name, token] of Object.entries(THEME_TOKENS)) {
    const value = style.getPropertyValue(token).trim()
    if (value) {
      variables[name] = value
    }
  }
  return variables
}

const FETCHING_TAGS = 'input,video,audio,img,source,picture,object,embed,iframe,link'

/** Any attribute that points off-page: a remote url, a `url()` that is not a fragment, or an `@import`. */
const REMOTE_VALUE = /^\s*(?:https?:)?\/\/|url\(\s*["']?(?!#)|@import/i

/**
 * Sanitises the drawn svg, then removes whatever could still fetch a remote resource once inserted
 * into the page. The second pass walks the result itself so it does not depend on the sanitiser
 * visiting every node.
 */
export function sanitizeSvg(svg: string): string {
  const clean = DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: FETCHING_TAGS.split(',')
  })
  const holder = document.createElement('div')
  holder.innerHTML = clean
  for (const node of holder.querySelectorAll('*')) {
    if (node.matches(FETCHING_TAGS)) {
      node.remove()
      continue
    }
    for (const { name, value } of Array.from(node.attributes)) {
      if (!name.toLowerCase().startsWith('xmlns') && REMOTE_VALUE.test(value)) {
        node.removeAttribute(name)
      }
    }
  }
  return holder.innerHTML
}

/** The first and last lines of a mermaid error, which carry the position and the expectation without the echoed source. */
function summarize(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const kept = lines.length > 2 ? [lines[0], lines.at(-1)] : lines
  return kept.join(': ').replace(/:\s*:/g, ':')
}

const REFUSED = 'it loads remote images'

const SVG_CACHE_LIMIT = 50
const svgCache = new Map<string, string>()

/** Identifies the colours mermaid would be given right now, so a cached drawing is only reused under the theme it was drawn for. */
const themeSignature = () => JSON.stringify(themeVariables())

const cacheKey = (signature: string, code: string) => `${signature}\u0000${code}`

/** The current theme signature, updated when the root element's theme attributes change. */
function useThemeSignature(): string {
  const [signature, setSignature] = useState(themeSignature)
  useEffect(() => {
    const root = document.documentElement
    const update = () => setSignature(themeSignature())
    update()
    const observer = new MutationObserver(update)
    observer.observe(root, { attributes: true, attributeFilter: ['style', 'class'] })
    return () => observer.disconnect()
  }, [])
  return signature
}

function remember(key: string, svg: string) {
  svgCache.delete(key)
  svgCache.set(key, svg)
  if (svgCache.size > SVG_CACHE_LIMIT) {
    const oldest = svgCache.keys().next()
    if (!oldest.done) {
      svgCache.delete(oldest.value)
    }
  }
}

/** A `mermaid` fence: plain source while open, then a diagram drawn with strict security and a Source toggle. */
export function MermaidFence({ code, isIncomplete, language, meta }: FenceProps) {
  const id = `qmd-mermaid-${useId().replace(/[^\w-]/g, '')}`
  const signature = useThemeSignature()
  const refused = loadsImages(code)
  // a remount, such as the one when streaming ends, reuses the drawing instead of flashing the source
  const [outcome, setOutcome] = useState<Outcome>(() => {
    if (refused) {
      return { kind: 'failed', message: REFUSED }
    }
    const cached = isIncomplete ? undefined : svgCache.get(cacheKey(signature, code))
    return cached === undefined ? { kind: 'pending' } : { kind: 'ready', svg: cached }
  })
  const [showSource, setShowSource] = useState(false)

  useEffect(() => {
    if (isIncomplete) {
      return
    }
    if (refused) {
      setOutcome({ kind: 'failed', message: REFUSED })
      return
    }
    const key = cacheKey(signature, code)
    const cached = svgCache.get(key)
    if (cached !== undefined) {
      setOutcome({ kind: 'ready', svg: cached })
      return
    }
    let live = true
    setOutcome({ kind: 'pending' })
    void (async () => {
      try {
        const { default: mermaid } = await import('mermaid')
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          ...NO_HTML_LABELS,
          theme: 'base',
          themeVariables: themeVariables(),
          suppressErrorRendering: true
        })
        const { svg } = await withRemoteImagesBlocked(() => mermaid.render(id, code))
        const clean = sanitizeSvg(svg)
        remember(key, clean)
        if (live) {
          setOutcome({ kind: 'ready', svg: clean })
        }
      } catch (error) {
        if (live) {
          setOutcome({ kind: 'failed', message: summarize(error) })
        }
      }
    })()
    return () => {
      live = false
    }
  }, [code, isIncomplete, id, signature, refused])

  if (isIncomplete || outcome.kind === 'pending') {
    return <CodeBlock code={code} language={language} meta={meta} isIncomplete={isIncomplete} />
  }
  if (outcome.kind === 'failed') {
    return (
      <>
        <RenderError
          message={`Couldn't draw this diagram: ${outcome.message}. Showing the source.`}
        />
        <CodeBlock code={code} language={language} meta={meta} isIncomplete={false} />
      </>
    )
  }
  return (
    <BlockFrame
      label="mermaid"
      language="mermaid"
      actions={
        <>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            data-qmd-button=""
            aria-pressed={showSource}
            onClick={() => setShowSource((value) => !value)}
          >
            {showSource ? 'Diagram' : 'Source'}
          </Button>
          <CopyButton code={code} />
        </>
      }
      state={{ 'data-qmd-data': 'mermaid' }}
    >
      {showSource ? (
        <pre className="qmd-source">{code}</pre>
      ) : (
        <div
          className="qmd-figure-body"
          dangerouslySetInnerHTML={{ __html: outcome.kind === 'ready' ? outcome.svg : '' }}
        />
      )}
    </BlockFrame>
  )
}
