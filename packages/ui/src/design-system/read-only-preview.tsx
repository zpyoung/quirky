import { useEffect, useState } from 'react'
import tokenStyles from './tokens.css' with { type: 'text' }

/** Callers sanitize HTML before this boundary; the frame never grants scripts, navigation or network. */
export type ReadOnlyPreviewProps = { sanitizedHtml: string; title: string }

const previewCsp = [
  "default-src 'none'", "base-uri 'none'", "connect-src 'none'", "font-src 'none'",
  "form-action 'none'", "frame-src 'none'", "img-src 'none'", "media-src 'none'",
  "object-src 'none'", "script-src 'none'", "style-src 'unsafe-inline'", "navigate-to 'none'",
].join('; ')

const previewStyles = `${tokenStyles}
body { margin: 0; padding: var(--ui-space-8); color: var(--ui-text); background: var(--ui-surface); font: var(--ui-font-body)/1.5 system-ui, sans-serif; overflow-wrap: anywhere; }
pre { overflow: auto; white-space: pre-wrap; }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--ui-font-mono); }
table { border-collapse: collapse; }
th, td { border: var(--ui-border-width) solid var(--ui-border); padding: var(--ui-space-4) var(--ui-space-6); }
blockquote { margin-inline: 0; padding-inline-start: var(--ui-space-12); border-inline-start: var(--ui-focus-width) solid var(--ui-border); }
a { color: var(--ui-accent); }
`

function currentAppearance(): 'dark' | 'light' {
  if (typeof document === 'undefined') return 'dark'
  const theme = document.documentElement.getAttribute('data-theme')
  if (theme === 'light' || theme === 'dark') return theme
  return globalThis.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

export function ReadOnlyPreview({ sanitizedHtml, title }: ReadOnlyPreviewProps) {
  const [appearance, setAppearance] = useState(currentAppearance)
  useEffect(() => {
    const update = () => setAppearance(currentAppearance())
    const observer = new MutationObserver(update)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    const media = globalThis.matchMedia?.('(prefers-color-scheme: light)')
    media?.addEventListener('change', update)
    update()
    return () => { observer.disconnect(); media?.removeEventListener('change', update) }
  }, [])
  return <iframe
    title={title}
    sandbox=""
    referrerPolicy="no-referrer"
    loading="lazy"
    srcDoc={`<!doctype html><html data-theme="${appearance}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${previewCsp}"><style>${previewStyles}</style></head><body>${sanitizedHtml}</body></html>`}
    style={{ display: 'block', width: '100%', height: 'calc(var(--ui-row-double) * 7)', border: 'var(--ui-border-width) solid var(--ui-border)', borderRadius: 'var(--ui-radius-control)', marginTop: 'var(--ui-space-4)' }}
  />
}
