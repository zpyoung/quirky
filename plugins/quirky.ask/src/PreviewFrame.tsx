import ReactMarkdown from 'react-markdown'
import { renderToStaticMarkup } from 'react-dom/server'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import type { AskPreview } from '@quirky/protocol'

const PREVIEW_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "connect-src 'none'",
  "font-src 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "img-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline'",
  "navigate-to 'none'"
].join('; ')

const PREVIEW_TAGS = [
  'a',
  'blockquote',
  'br',
  'caption',
  'code',
  'del',
  'div',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'li',
  'ol',
  'p',
  'pre',
  'span',
  'strong',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'ul'
]

const PREVIEW_STRIPPED_CONTENT = [
  'audio',
  'base',
  'button',
  'embed',
  'form',
  'iframe',
  'img',
  'input',
  'link',
  'math',
  'meta',
  'object',
  'script',
  'source',
  'style',
  'svg',
  'video'
]

const PREVIEW_SCHEMA = {
  ...defaultSchema,
  tagNames: PREVIEW_TAGS,
  attributes: {},
  protocols: {},
  strip: [...(defaultSchema.strip ?? []), ...PREVIEW_STRIPPED_CONTENT]
} satisfies typeof defaultSchema

const PREVIEW_STYLE = `
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 8px; color: CanvasText; background: Canvas; font: 13px/1.5 system-ui, sans-serif; overflow-wrap: anywhere; }
  pre { overflow: auto; white-space: pre-wrap; }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  table { border-collapse: collapse; }
  th, td { border: 1px solid GrayText; padding: 3px 6px; }
  blockquote { margin-inline: 0; padding-inline-start: 10px; border-inline-start: 3px solid GrayText; }
`

function previewDocument(preview: AskPreview): string {
  const content = renderToStaticMarkup(
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeRaw, [rehypeSanitize, PREVIEW_SCHEMA]]}
      components={{ a: ({ children }) => <span>{children}</span> }}
    >
      {preview.content}
    </ReactMarkdown>
  )
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}"><style>${PREVIEW_STYLE}</style></head><body>${content}</body></html>`
}

/** Renders the untrusted option preview as static, sanitized content in a networkless opaque-origin frame. */
export function PreviewFrame({ preview }: { preview: AskPreview }) {
  return (
    <iframe
      className="ask-preview"
      title="Question preview"
      sandbox=""
      referrerPolicy="no-referrer"
      loading="lazy"
      srcDoc={previewDocument(preview)}
      style={{ display: 'block', width: '100%', height: 240, border: '1px solid var(--border)', marginTop: 4 }}
    />
  )
}
