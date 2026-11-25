/** Checks that `html` nodes load nothing remote and `live-preview` targets stay on this machine. */

const LOCAL_PREVIEW_HOSTS = ['localhost', '127.0.0.1'] as const
// eslint-disable-next-line no-control-regex -- browsers drop control characters inside a URL scheme
const CONTROL_AND_SPACE = /[\u0000- ]+/g
const REMOTE_URL = /^(?:https?:|\/\/)/i
const URL_ATTRIBUTE =
  /\b(?:src|href|action|srcset|poster|formaction|data|xlink:href|ping)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*))/gi
const NAMED_ENTITIES: Record<string, string> = { colon: ':', sol: '/', tab: '', newline: '' }

function decodeEntities(text: string): string {
  const fromCode = (code: number): string =>
    Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
  return text
    .replace(/&#x([0-9a-f]{1,6});?/gi, (_match, hex: string) => fromCode(Number.parseInt(hex, 16)))
    .replace(/&#(\d{1,7});?/g, (_match, digits: string) => fromCode(Number(digits)))
    .replace(
      /&(colon|sol|tab|newline);/gi,
      (_match, name: string) => NAMED_ENTITIES[name.toLowerCase()]
    )
}

function isRemoteAttribute(name: string, value: string): boolean {
  const decoded = decodeEntities(value)
  // srcset lists several urls; every other attribute holds one, and browsers ignore control characters and spaces inside its scheme
  if (name.toLowerCase() === 'srcset') {
    return decoded.split(/[\s,]+/).some((candidate) => REMOTE_URL.test(candidate))
  }
  return REMOTE_URL.test(decoded.replace(CONTROL_AND_SPACE, ''))
}

const CSS_ESCAPE = /\\(?:([0-9a-f]{1,6})(?:\r\n|[ \t\n\r\f])?|(\r\n|[\n\r\f])|([^\n\r\f]))/gi

/** The text with CSS escapes resolved the way a stylesheet reads them: `\68 ttps` is `https`. */
function decodeCssEscapes(text: string): string {
  return text.replace(
    CSS_ESCAPE,
    (
      _match,
      hex: string | undefined,
      _newline: string | undefined,
      literal: string | undefined
    ) => {
      if (hex !== undefined) {
        const code = Number.parseInt(hex, 16)
        return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)
          ? '\ufffd'
          : String.fromCodePoint(code)
      }
      return literal ?? ''
    }
  )
}

function stripCssComments(text: string): string {
  let out = ''
  let from = 0
  for (let open = text.indexOf('/*'); open >= 0; open = text.indexOf('/*', from)) {
    out += `${text.slice(from, open)} `
    const close = text.indexOf('*/', open + 2)
    if (close === -1) {
      return out
    }
    from = close + 2
  }
  return out + text.slice(from)
}

function startsRemoteCss(lower: string, from: number): boolean {
  let at = from
  while (at < lower.length && /[\s"']/.test(lower[at])) {
    at++
  }
  return (
    lower.startsWith('http:', at) || lower.startsWith('https:', at) || lower.startsWith('//', at)
  )
}

function scansRemoteCss(lower: string): boolean {
  for (let at = lower.indexOf('url'); at >= 0; at = lower.indexOf('url', at + 3)) {
    let open = at + 3
    while (open < lower.length && /\s/.test(lower[open])) {
      open++
    }
    if (lower[open] === '(' && startsRemoteCss(lower, open + 1)) {
      return true
    }
  }
  for (let at = lower.indexOf('@import'); at >= 0; at = lower.indexOf('@import', at + 7)) {
    if (startsRemoteCss(lower, at + 7)) {
      return true
    }
  }
  return false
}

/**
 * True for a CSS `url(` or `@import` that points at http:, https: or //, also when the text is
 * spelled with CSS escapes or comments; scans without regex backtracking.
 */
function loadsRemoteCss(text: string): boolean {
  const decoded = decodeCssEscapes(text)
  return [text, decoded, stripCssComments(decoded)].some((variant) =>
    scansRemoteCss(variant.toLowerCase())
  )
}

/** True when the page references an http(s) or protocol-relative URL, in attributes or CSS. */
export function loadsRemoteHtml(html: string): boolean {
  for (const match of html.matchAll(URL_ATTRIBUTE)) {
    const name = match[0].slice(0, match[0].indexOf('=')).trim()
    if (isRemoteAttribute(name, match[1] ?? match[2] ?? match[3] ?? '')) {
      return true
    }
  }
  return loadsRemoteCss(decodeEntities(html))
}

/** True for `http://` on localhost, 127.0.0.1 or a `*.quirky.localhost` host, with no credentials. */
export function isLocalPreviewUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' || url.username !== '' || url.password !== '') {
    return false
  }
  const suffix = '.quirky.localhost'
  return (
    LOCAL_PREVIEW_HOSTS.some((host) => host === url.hostname) ||
    (url.hostname.endsWith(suffix) && url.hostname.length > suffix.length)
  )
}
