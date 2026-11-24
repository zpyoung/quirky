import { useMemo } from 'react'
import DOMPurify from 'dompurify'
import { renderToStaticMarkup } from 'react-dom/server'
import Markdown from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { AskPreview } from '../../../../shared/fork-ask-question-tool/ask-question-schema'
import {
  buildAskPreviewShellHtml,
  buildAskPreviewThemeTokenCss,
  stripAskPreviewExecutableContent,
  stripAskPreviewScriptBlocks
} from './ask-preview-shell'

const SANITIZE_CONFIG = { USE_PROFILES: { html: true } }

/** Model-authored preview content, sanitized and wrapped in the theme-token CSP shell
 *  that `AskPreviewFrame` mounts as `srcDoc` (logic.md § Question schema, "Previews"). */
export function buildAskPreviewSrcDoc(preview: AskPreview): string {
  const rawHtml =
    preview.format === 'html'
      ? preview.content
      : renderToStaticMarkup(
          <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw, rehypeSanitize]}>
            {preview.content}
          </Markdown>
        )
  const withoutScripts = stripAskPreviewScriptBlocks(rawHtml)
  const sanitized = stripAskPreviewExecutableContent(
    DOMPurify.sanitize(withoutScripts, SANITIZE_CONFIG)
  )
  const themeTokenCss = buildAskPreviewThemeTokenCss(getComputedStyle(document.documentElement))
  return buildAskPreviewShellHtml(sanitized, themeTokenCss)
}

export function AskPreviewFrame({
  preview,
  className
}: {
  preview: AskPreview
  className?: string
}): React.JSX.Element {
  const srcDoc = useMemo(() => buildAskPreviewSrcDoc(preview), [preview])
  return (
    <iframe
      // Model HTML is untrusted: sandbox="" (no allow-scripts, never
      // allow-same-origin) keeps it an opaque, script-free origin so it can
      // never reach the app DOM or preload bridge even if DOMPurify misses
      // something the sandbox alone would have blocked anyway.
      sandbox=""
      referrerPolicy="no-referrer"
      loading="lazy"
      title={translate(
        'components.fork-ask-question-tool.askPreview.frameTitle',
        'Question preview'
      )}
      srcDoc={srcDoc}
      className={cn('block border-0 bg-background', className)}
    />
  )
}
