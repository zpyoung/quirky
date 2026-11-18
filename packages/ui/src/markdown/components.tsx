import { Children, Fragment, cloneElement, createContext, isValidElement, useContext } from 'react'
import type { ComponentProps, MouseEvent, ReactElement, ReactNode } from 'react'
import type { Components, CustomRenderer, ExtraProps } from 'streamdown'
import { useIsCodeFenceIncomplete } from 'streamdown'
import { Blockquote } from './blocks/Alert'
import { CodeBlock } from './blocks/CodeBlock'
import { ChartFence, JsonFence, TableFence } from './blocks/DataBlocks'
import { MermaidFence } from './blocks/MermaidBlock'
import { PathChip } from './blocks/PathChip'
import { RemoteImageChip } from './blocks/RemoteImageChip'
import { RenderError } from './blocks/RenderError'
import { explainMath, readMathFailure } from './math-errors'
import { isPathCandidate } from './remark-path-candidates'
import { FilesContext, ImagesContext, RuntimeContext } from './runtime'

export const BUILT_IN_RENDERERS: CustomRenderer[] = [
  { language: 'mermaid', component: MermaidFence },
  { language: ['csv', 'tsv'], component: TableFence },
  { language: 'json', component: JsonFence },
  { language: 'chart', component: ChartFence }
]

/** The fence renderers in priority order: the caller's first, then the built-ins. */
export const RenderersContext = createContext<CustomRenderer[]>(BUILT_IN_RENDERERS)

/** True while the message is still arriving, when a block that cannot render yet shows as source instead of an error. */
export const StreamingContext = createContext(false)

/** The code block still being written at the end of a streaming message, which streamdown cannot see inside a blockquote. */
export const OpenFenceContext = createContext<{ language: string; code: string } | null>(null)

export function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (isValidElement(node)) return textOf((node as ReactElement<{ children?: ReactNode }>).props.children)
  return ''
}

function jumpToFragment(event: MouseEvent<HTMLAnchorElement>, href: string) {
  event.preventDefault()
  let id = href.slice(1)
  try {
    id = decodeURIComponent(id)
  } catch {
    // keep the raw fragment
  }
  const root = event.currentTarget.closest('.qmd')
  const target = Array.from(root?.querySelectorAll('[id]') ?? []).find((element) => element.id === id)
  target?.scrollIntoView?.({ block: 'nearest' })
}

/** The id and aria attributes a footnote reference or backref needs to be reachable from the other end. */
function anchorAttributes(props: Record<string, unknown>): Record<string, unknown> {
  const kept: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(props)) {
    if (name === 'id' || name.startsWith('aria-')) kept[name] = value
  }
  return kept
}

/** True inside a link label, where inline code is ordinary code and never a path chip. */
const InsideLinkContext = createContext(false)

/** Only http and https become links, and a click goes to the caller instead of navigating. */
function Link({ href, children, node: _node, ...rest }: ComponentProps<'a'> & ExtraProps) {
  const runtime = useContext(RuntimeContext)
  const label = <InsideLinkContext.Provider value={true}>{children}</InsideLinkContext.Provider>
  if (typeof href === 'string' && /^https?:\/\//i.test(href)) {
    const open = (event: MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault()
      runtime.current.onOpenLink(href)
    }
    return <a data-streamdown="link" href={href} rel="noreferrer" onClick={open} onAuxClick={open}>{label}</a>
  }
  if (typeof href === 'string' && href.length > 1 && href.startsWith('#')) {
    return <a data-streamdown="link" href={href} {...anchorAttributes(rest)} onClick={(event) => jumpToFragment(event, href)}>{label}</a>
  }
  return label
}

const REMOTE_SRC = /^(?:https?:)?\/\//i
const OTHER_SCHEME = /^[a-z][a-z0-9+.-]*:/i

function decodedPath(src: string): string {
  try {
    return decodeURIComponent(src)
  } catch {
    return src
  }
}

function Image({ src, alt }: ComponentProps<'img'> & ExtraProps) {
  const images = useContext(ImagesContext)
  if (typeof src !== 'string' || src === '') return <>{alt ?? ''}</>
  if (REMOTE_SRC.test(src)) return <RemoteImageChip src={src} alt={alt} />
  if (OTHER_SCHEME.test(src)) return <>{alt ?? ''}</>
  // the parser percent-encodes the destination, while the lookup keys are the path as written
  const written = images[src] ? src : decodedPath(src)
  const url = images[written]
  if (!url) return <>{alt ?? ''}</>
  return (
    <figure className="qmd-figure" data-streamdown="image-wrapper">
      <img src={url} alt={alt ?? ''} loading="lazy" />
      <figcaption>{written}</figcaption>
    </figure>
  )
}

/** A paragraph holding an image is a div, because a local image renders as a figure and a figure cannot sit in a p. */
function Paragraph({ children, node, ...rest }: ComponentProps<'p'> & ExtraProps) {
  const holdsImage = node?.children?.some((child) => child.type === 'element' && child.tagName === 'img') ?? false
  if (!holdsImage) return <p {...rest}>{children}</p>
  const meaningful = Children.toArray(children).filter((child) => !(typeof child === 'string' && child.trim() === ''))
  if (meaningful.length === 1 && Object.keys(rest).length === 0) return <Fragment>{children}</Fragment>
  return <div className="qmd-p" {...(rest as ComponentProps<'div'>)}>{children}</div>
}

function katexMessage(title: string | undefined): string {
  const message = (title ?? 'invalid math').replace(/^ParseError:\s*/, '').replace(/^KaTeX parse error:\s*/, '')
  return message.replace(/\s+at position \d+:[\s\S]*$/, '').replace(/\s+/g, ' ').trim()
}

/**
 * KaTeX never throws here: a bad formula comes out as red text inside `.katex`, or as a `katex-error`
 * span. Both become the shared error note with the source underneath.
 */
function Span({ children, node, ...rest }: ComponentProps<'span'> & ExtraProps) {
  const streaming = useContext(StreamingContext)
  const classes = typeof rest.className === 'string' ? rest.className.split(/\s+/) : []
  if (classes.includes('katex-error')) {
    if (streaming) return <span className="qmd-source">{textOf(children)}</span>
    return (
      <RenderError inline message={`Couldn't typeset: ${katexMessage(rest.title)}`}>
        <span className="qmd-source">{textOf(children)}</span>
      </RenderError>
    )
  }
  const failure = classes.includes('katex') ? readMathFailure(node as never) : null
  if (failure) {
    if (streaming) return <span className="qmd-source">{failure.tex}</span>
    return (
      <RenderError inline message={`Couldn't typeset: ${explainMath(failure.tex)}`}>
        <span className="qmd-source">{failure.tex}</span>
      </RenderError>
    )
  }
  return <span {...rest}>{children}</span>
}

function InlineCode({ children, ...rest }: ComponentProps<'code'> & ExtraProps) {
  const files = useContext(FilesContext)
  const insideLink = useContext(InsideLinkContext)
  const text = textOf(children)
  const marked = (rest as Record<string, unknown>)['data-path-candidate']
  const candidate = typeof marked === 'string' ? marked : isPathCandidate(text) && !insideLink ? text : undefined
  const resolved = candidate ? files[candidate] : undefined
  if (candidate && resolved) return <PathChip candidate={candidate} line={resolved.line} />
  // a candidate split out of prose that did not resolve is prose again; only written inline code stays code
  if (typeof marked === 'string') return <>{children}</>
  return <code data-streamdown="inline-code">{children}</code>
}

function hasElement(node: ReactNode): boolean {
  if (Array.isArray(node)) return node.some(hasElement)
  return isValidElement(node)
}

/** Splits rendered code children at newlines, repeating an element that spans a break on each line it covers. */
function splitLines(node: ReactNode): ReactNode[][] {
  if (node === null || node === undefined || typeof node === 'boolean') return [[]]
  if (typeof node === 'string' || typeof node === 'number') return String(node).split('\n').map((part) => [part])
  if (Array.isArray(node)) {
    const lines: ReactNode[][] = [[]]
    for (const child of node) {
      const [first = [], ...rest] = splitLines(child)
      lines[lines.length - 1]!.push(...first)
      lines.push(...rest)
    }
    return lines
  }
  if (isValidElement(node)) {
    const element = node as ReactElement<{ children?: ReactNode }>
    return splitLines(element.props.children).map((line, index) => [cloneElement(element, { key: index }, ...line)])
  }
  return [[]]
}

/**
 * The per-line markup of a fence whose children a plugin marked up (an element among the text), or
 * undefined for plain text. The hast text of a fence ends in the newline markdown adds, which is dropped.
 */
function markedLines(children: ReactNode): ReactNode[] | undefined {
  if (!hasElement(children)) return undefined
  const lines = splitLines(children)
  if (textOf(lines[lines.length - 1]) === '') lines.pop()
  return lines.map((line, index) => <Fragment key={index}>{line}</Fragment>)
}

function FenceCode({ node, className, children }: ComponentProps<'code'> & ExtraProps) {
  const renderers = useContext(RenderersContext)
  const openFence = useContext(OpenFenceContext)
  const streamdownIncomplete = useIsCodeFenceIncomplete()
  const language = /language-([^\s]+)/.exec(className ?? '')?.[1]?.toLowerCase() ?? ''
  const metaValue = node?.properties?.metastring
  const meta = typeof metaValue === 'string' ? metaValue : undefined
  const code = textOf(children).replace(/\n$/, '')
  const isIncomplete = streamdownIncomplete || (openFence !== null && openFence.language === language && openFence.code.trimEnd() === code.trimEnd())
  const renderer = language === '' ? undefined : renderers.find((entry) => (Array.isArray(entry.language) ? entry.language.includes(language) : entry.language === language))
  if (renderer) {
    const Component = renderer.component
    return <Component code={code} isIncomplete={isIncomplete} language={language} meta={meta} />
  }
  return <CodeBlock code={code} language={language} meta={meta} isIncomplete={isIncomplete} lineNodes={markedLines(children)} />
}

function Code(props: ComponentProps<'code'> & ExtraProps) {
  return 'data-block' in (props as object) ? <FenceCode {...props} /> : <InlineCode {...props} />
}

/** The Streamdown component overrides that carry quirky's rules. Module-level so the map keeps one identity. */
export const QUIRKY_COMPONENTS = {
  a: Link,
  img: Image,
  p: Paragraph,
  blockquote: Blockquote,
  span: Span,
  code: Code
  // streamdown types its props against a second copy of @types/react, so the map crosses that boundary here
} as unknown as Partial<Components>
