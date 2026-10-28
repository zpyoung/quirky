import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import DOMPurify from 'isomorphic-dompurify'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { isSafeMarkdownLink } from './operations'
import { MARKDOWN_MAX_NOTE_SELECTION_BYTES, MARKDOWN_PREVIEW_MAX_BYTES, utf8Bytes } from './source'
import { MARKDOWN_PREVIEW_REHYPE_PLUGINS, previewAnchorHref } from './previewPipeline'

const MAX_PREVIEW_BLOCKS = 16_384
const MAX_PREVIEW_LINE_BYTES = 16 * 1024
const SANITIZE_OPTIONS = {
  USE_PROFILES: { html: true, mathMl: true },
  FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'base', 'meta', 'style', 'link']
}

type PreviewOptions = { imageUrls?: ReadonlyMap<string, string> }

function SafePreview({ markdown, imageUrls }: { markdown: string } & PreviewOptions): React.JSX.Element {
  return (
    <article className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={MARKDOWN_PREVIEW_REHYPE_PLUGINS}
        components={{
          a({ href, children }) {
            if (!href || !isSafeMarkdownLink(href)) return <span>{children}</span>
            return <a href={previewAnchorHref(markdown, href)} rel="noopener noreferrer">{children}</a>
          },
          img({ src, alt }) {
            const authorized = src ? imageUrls?.get(src) : undefined
            if (!authorized) return alt ? <span>{alt}</span> : null
            return <img src={authorized} alt={alt ?? ''} loading="lazy" />
          },
          code({ className, children, ...props }) {
            if (className?.includes('language-mermaid')) {
              return <code className="language-mermaid" {...props}>{children}</code>
            }
            return <code className={className} {...props}>{children}</code>
          }
        }}
      >
        {markdown}
      </ReactMarkdown>
    </article>
  )
}

export async function renderSafeMarkdownHtml(markdown: string, options: PreviewOptions = {}): Promise<string> {
  assertPreviewBounds(markdown)
  const markup = renderToStaticMarkup(<SafePreview markdown={markdown} imageUrls={options.imageUrls} />)
  return DOMPurify.sanitize(markup, SANITIZE_OPTIONS)
}

export function isSelectionWithinPreviewLimit(text: string): boolean {
  return utf8Bytes(text) <= MARKDOWN_MAX_NOTE_SELECTION_BYTES
}

function assertPreviewBounds(markdown: string): void {
  if (utf8Bytes(markdown) > MARKDOWN_PREVIEW_MAX_BYTES) throw new Error('This document is larger than the 8 MiB preview limit. Open source view to read it.')
  const lines = markdown.split(/\r?\n/)
  if (lines.length > MAX_PREVIEW_BLOCKS) throw new Error('This document cannot be rendered within the preview limits. Open source view to read it.')
  for (const line of lines) {
    if (utf8Bytes(line) > MAX_PREVIEW_LINE_BYTES) throw new Error('This document contains a line that exceeds the preview limit. Open source view to read it.')
  }
}



