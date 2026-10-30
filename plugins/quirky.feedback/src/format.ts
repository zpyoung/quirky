import { codeSpan, collapse, feedbackBlock, markdownText } from '@quirky/ui/annotation-markdown'
import type { Capture, Comment } from './contract'

const NAME_LIMIT = 60

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function tagFromPath(elementPath: string): string {
  const last = elementPath.split(' > ').at(-1) ?? ''
  return /^[A-Za-z][A-Za-z0-9-]*/.exec(last)?.[0] ?? 'element'
}

function kebab(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
}

function labelFor(capture: Capture): string {
  const kindOrTag = capture.kind === 'element' ? tagFromPath(capture.elementPath) : capture.kind
  const name = Array.from(collapse(capture.accessibleName || capture.visibleText)).slice(0, NAME_LIMIT).join('')
  const component = capture.component ? `${collapse(capture.component)} ` : ''
  return markdownText(`${component}${kindOrTag}${name ? ` "${name}"` : ''}`)
}

function commentLines(comment: Comment, index: number): string[] {
  const capture = comment.capture
  const lines = [`### ${index + 1}. ${labelFor(capture)}`]
  lines.push(`**Intent:** ${markdownText(comment.intent)}`)
  if (capture.owner) lines.push(`**Plugin:** ${codeSpan(capture.owner)}`)
  const { version, commit, channel } = capture.build
  lines.push(`**App:** ${codeSpan(`Quirky ${version} (${commit}, ${channel})`)}`)
  if (capture.selector) lines.push(`**Selector:** ${codeSpan(capture.selector)}`)
  if (capture.elementPath) lines.push(`**Location:** ${codeSpan(capture.elementPath)}`)
  if (capture.source) lines.push(`**Source:** ${codeSpan(capture.source)}`)
  if (capture.sourceCaller) lines.push(`**Used by:** ${codeSpan(capture.sourceCaller)}`)
  if (capture.component) lines.push(`**React:** ${codeSpan(capture.component)}`)
  const { x, y, width, height } = capture.rect
  lines.push(`**Bounds:** x=${finiteNumber(x)}, y=${finiteNumber(y)}, ${finiteNumber(width)}x${finiteNumber(height)}`)
  const attributes = capture.attributes ?? {}
  if (attributes.class) lines.push(`**Classes:** ${codeSpan(attributes.class)}`)
  const others = Object.entries(attributes).filter(([name]) => name !== 'class')
  if (others.length > 0) lines.push('**Attributes:**', ...others.map(([name, value]) => `- ${codeSpan(`${name}="${value}"`)}`))
  if (capture.visibleText) lines.push(`**Text:** ${codeSpan(capture.visibleText)}`)
  const nearby = capture.nearbyText ?? []
  if (nearby.length > 0) lines.push('**Nearby text:**', ...nearby.map((text) => `- ${codeSpan(text)}`))
  const styles = Object.entries(capture.computedStyles).filter(([, value]) => collapse(value) !== '')
  if (styles.length > 0) lines.push('**Computed styles:**', ...styles.map(([name, value]) => `- ${markdownText(`${kebab(name)}: ${collapse(value)}`)}`))
  lines.push(...feedbackBlock(comment.comment))
  return lines
}

/**
 * Renders feedback comments as Markdown for a coding agent, in Annotate's field order plus the owning
 * plugin and app build. Every captured value is escaped, and pane captures carry no text fields.
 * Returns an empty string for no comments.
 */
export function formatCommentsAsMarkdown(comments: Comment[]): string {
  if (comments.length === 0) return ''
  const output = ['## Quirky UI Feedback']
  comments.forEach((comment, index) => output.push('', ...commentLines(comment, index)))
  return output.join('\n').trimEnd()
}
