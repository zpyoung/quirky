const ASSET_KEY = /@\{[^}]*?["']?\b(?:img|image|icon)["']?\s*:/i
const MARKUP_OPEN = '(?:<|&lt;|&#0*60;|&#x0*3c;|#60;|#lt;)'
const IMAGE_MARKUP = new RegExp(`${MARKUP_OPEN}\\s*/?\\s*(?:img|image|picture|source|video|audio|svg|object|embed|iframe|link|style|use|foreignobject)\\b`, 'i')
const CSS_FETCH = /url\s*\(|image-set\s*\(|@import|themeCSS|\bsrc\s*=/i

/**
 * True when mermaid source can make mermaid fetch something: `img:`/`icon:` node shapes, image markup in
 * labels, or CSS that loads a URL. Mermaid assigns such URLs to an `Image` before the svg can be
 * sanitised, so the source has to be refused before it is handed over.
 */
export function loadsImages(source: string): boolean {
  return ASSET_KEY.test(source) || IMAGE_MARKUP.test(source) || CSS_FETCH.test(source)
}
