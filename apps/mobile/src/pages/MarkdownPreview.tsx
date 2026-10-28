import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

const plugins = [remarkGfm]
const components: Components = {
  // Phone pages have no permission to fetch document-supplied resources or navigate themselves.
  img: ({ alt }) => <span>{alt ? `[Image: ${alt}]` : '[Image]'}</span>,
  a: ({ children }) => <span>{children}</span>
}

export function MarkdownPreview({ text }: { text: string }) {
  return <article className="qp-markdown-preview">
    <ReactMarkdown remarkPlugins={plugins} components={components}>{text}</ReactMarkdown>
  </article>
}
