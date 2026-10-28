import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import rehypeStringify from 'rehype-stringify'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import type { AskPreview } from '@quirky/protocol'
import { ReadOnlyPreview } from '@quirky/ui'

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

const PREVIEW_PROCESSOR = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw)
  .use(rehypeSanitize, PREVIEW_SCHEMA)
  .use(rehypeStringify)

/** Renders sanitized option preview content in the shared networkless, opaque-origin frame. */
export function PreviewFrame({ preview }: { preview: AskPreview }) {
  const sanitizedHtml = String(PREVIEW_PROCESSOR.processSync(preview.content))
  return <ReadOnlyPreview sanitizedHtml={sanitizedHtml} title="Question preview" />
}
