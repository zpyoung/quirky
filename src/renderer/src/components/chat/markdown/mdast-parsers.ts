import type { Root } from 'mdast'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

const COMMONMARK = unified().use(remarkParse)
const GFM = unified().use(remarkParse).use(remarkGfm)

/** The mdast tree of `source` with the same syntax extensions the renderer's remark-gfm adds, and no math. */
export function parseGfm(source: string): Root {
  return GFM.parse(source)
}

/** The mdast tree of `source` as plain CommonMark. */
export function parseCommonMark(source: string): Root {
  return COMMONMARK.parse(source)
}
