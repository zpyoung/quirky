import katex from 'katex'

/** The colour KaTeX paints a failed formula with, so a failure can be told from good math in the rendered tree. */
export const MATH_ERROR_COLOR = 'var(--destructive)'

type HastNode = {
  type: string
  value?: string
  tagName?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}

// rehype-katex's own default error colour
const ERROR_COLOR = /(?:^|;)\s*color:\s*(?:var\(--destructive\)|#cc0000)\s*(?:;|$)/i

function failed(node: HastNode): boolean {
  const style = node.properties?.style
  if (typeof style === 'string' && ERROR_COLOR.test(style)) {
    return true
  }
  const mathColor = node.properties?.mathcolor ?? node.properties?.mathColor
  if (mathColor === MATH_ERROR_COLOR || mathColor === '#cc0000') {
    return true
  }
  return (node.children ?? []).some(failed)
}

function texOf(node: HastNode): string | null {
  if (node.tagName === 'annotation') {
    return (node.children ?? []).map((child) => child.value ?? '').join('')
  }
  for (const child of node.children ?? []) {
    const found = texOf(child)
    if (found !== null) {
      return found
    }
  }
  return null
}

/** Whether a rendered `.katex` tree holds a formula KaTeX could not typeset, and the TeX it was given. */
export function readMathFailure(node: HastNode | undefined): { tex: string } | null {
  if (!node || !failed(node)) {
    return null
  }
  return { tex: texOf(node) ?? '' }
}

/** KaTeX's own words for what is wrong with `tex`, without its position tail. */
export function explainMath(tex: string): string {
  try {
    katex.renderToString(tex, { throwOnError: true, strict: 'ignore', trust: false })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return message
      .replace(/^KaTeX parse error:\s*/, '')
      .replace(/\s+at position \d+:[\s\S]*$/, '')
      .replace(/\s+/g, ' ')
      .trim()
  }
  return 'invalid math'
}
