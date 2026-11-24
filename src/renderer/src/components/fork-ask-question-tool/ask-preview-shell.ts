/**
 * Host-generated shell for model-authored ask previews (logic.md § Question
 * schema, "Previews"). Prepended CSP applies from the moment it parses and
 * cannot be loosened by later markup, so it stands ahead of the sanitized
 * body regardless of what DOMPurify missed.
 */
export const ASK_PREVIEW_CSP =
  "default-src 'none'; connect-src 'none'; script-src 'none'; " +
  "style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"

/** Curated design-token subset for preview documents; grow additively. */
export const ASK_PREVIEW_DESIGN_TOKEN_ALLOWLIST = [
  '--background',
  '--foreground',
  '--card',
  '--card-foreground',
  '--muted',
  '--muted-foreground',
  '--border',
  '--primary',
  '--primary-foreground',
  '--radius'
] as const

export function buildAskPreviewThemeTokenCss(styles: {
  getPropertyValue(name: string): string
}): string {
  const declarations: string[] = []
  for (const token of ASK_PREVIEW_DESIGN_TOKEN_ALLOWLIST) {
    const value = styles.getPropertyValue(token).trim()
    if (value.length > 0) {
      declarations.push(`${token}:${value.replaceAll(/[{}<>;]/g, '')}`)
    }
  }
  return declarations.join(';')
}

const REMOVED_TAGS_SELECTOR = 'script, iframe, object, embed, link, base, meta'
const URL_ATTRIBUTES = new Set(['href', 'src', 'action', 'formaction'])
const DANGEROUS_URL_RE = /^\s*javascript:/i
// `<script>` cannot legally nest another `<script>` open tag, so a non-greedy
// match of the first close tag always spans exactly one element.
const SCRIPT_BLOCK_RE = /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi

/** Removes whole `<script>…</script>` blocks, content included, before any
 *  DOM-based pass runs — a sanitizer that only detaches the element can still
 *  leave its inert text content behind in the body. */
export function stripAskPreviewScriptBlocks(html: string): string {
  return html.replaceAll(SCRIPT_BLOCK_RE, '')
}

/**
 * Removes executable and navigating content via plain DOM traversal, run
 * after DOMPurify rather than instead of it: DOMPurify covers markup this
 * pass doesn't reason about (malformed tag soup, encoding tricks), while
 * this pass is independent of any one sanitizer's tag classification.
 */
export function stripAskPreviewExecutableContent(html: string): string {
  const scratch = document.implementation.createHTMLDocument('')
  scratch.body.innerHTML = html
  for (const node of scratch.body.querySelectorAll(REMOVED_TAGS_SELECTOR)) {
    node.remove()
  }
  for (const element of scratch.body.querySelectorAll('*')) {
    const toRemove: string[] = []
    for (const attribute of element.attributes) {
      const name = attribute.name.toLowerCase()
      const isEventHandler = name.startsWith('on')
      const isDangerousUrl = URL_ATTRIBUTES.has(name) && DANGEROUS_URL_RE.test(attribute.value)
      if (isEventHandler || isDangerousUrl) {
        toRemove.push(attribute.name)
      }
    }
    for (const name of toRemove) {
      element.removeAttribute(name)
    }
  }
  return scratch.body.innerHTML
}

export function buildAskPreviewShellHtml(sanitizedBodyHtml: string, themeTokenCss: string): string {
  return (
    '<!doctype html>\n' +
    '<html>\n' +
    '<head>\n' +
    '<meta charset="utf-8">\n' +
    `<meta http-equiv="Content-Security-Policy" content="${ASK_PREVIEW_CSP}">\n` +
    `<style>:root{${themeTokenCss}}` +
    'body{margin:0;padding:.75rem;font:13px/1.5 system-ui,sans-serif;' +
    'background:var(--background);color:var(--foreground);word-wrap:break-word}' +
    'img{max-width:100%}' +
    '</style>\n' +
    '</head>\n' +
    `<body>${sanitizedBodyHtml}</body>\n` +
    '</html>'
  )
}
