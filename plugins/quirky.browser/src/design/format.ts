import type { DesignAnnotation, DesignPayload } from '../design-contract'
import { codeSpan, collapse, feedbackBlock, htmlFence, markdownText } from '@quirky/ui/annotation-markdown'
import { clampAnnotations, clampPayload } from './payload'

const STYLE_ORDER: readonly [keyof DesignPayload['target']['computedStyles'], string][] = [
  ['display', 'display'], ['position', 'position'], ['width', 'width'], ['height', 'height'], ['margin', 'margin'], ['padding', 'padding'],
  ['color', 'color'], ['backgroundColor', 'background'], ['border', 'border'], ['borderRadius', 'border-radius'],
  ['fontFamily', 'font-family'], ['fontSize', 'font-size'], ['fontWeight', 'font-weight'], ['lineHeight', 'line-height'],
  ['textAlign', 'text-align'], ['zIndex', 'z-index']
]

function isDefaultStyle(name: string, value: string): boolean {
  const normalized = value.trim().toLowerCase()
  if (normalized === '' || normalized === 'auto' || normalized === 'normal') return true
  if (name === 'display' && normalized === 'inline') return true
  if (name === 'position' && normalized === 'static') return true
  if (name === 'backgroundColor' && (normalized === 'transparent' || /^rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0(?:\.0+)?\s*\)$/.test(normalized))) return true
  return false
}

function styleLines(payload: DesignPayload): string[] {
  const lines: string[] = []
  for (const [key, label] of STYLE_ORDER) {
    const value = payload.target.computedStyles[key]
    if (typeof value !== 'string' || isDefaultStyle(key, value)) continue
    lines.push(`${label}: ${collapse(value)}`)
  }
  return lines
}

function textStyleSection(payload: DesignPayload, indent: string): string[] {
  const lines = styleLines(payload)
  if (lines.length === 0) return []
  return ['Computed styles:', ...lines.map((line) => `${indent}${line}`)]
}

export function formatGrabPayloadAsText(input: DesignPayload): string {
  const payload = clampPayload(input)
  const target = payload.target
  const lines = [`Attached browser context from ${payload.page.sanitizedUrl}`, '', 'Selected element:', target.tagName]
  if (target.accessibility.accessibleName) lines.push(`Accessible name: ${JSON.stringify(collapse(target.accessibility.accessibleName))}`)
  if (target.accessibility.role) lines.push(`Role: ${collapse(target.accessibility.role)}`)
  if (target.selector) lines.push(`Selector: ${target.selector}`)
  if (target.sourceFile) lines.push(`Source: ${target.sourceFile}`)
  if (target.reactComponents) lines.push(`React: ${target.reactComponents}`)
  lines.push(`Dimensions: ${Math.round(target.rectViewport.width)}x${Math.round(target.rectViewport.height)}`)
  if (target.textSnippet) lines.push('', 'Text content:', target.textSnippet)
  if (payload.nearbyText.length > 0) lines.push('', 'Nearby context:', ...payload.nearbyText.map((text) => `- ${text}`))
  const styles = textStyleSection(payload, '  ')
  if (styles.length > 0) lines.push('', ...styles)
  if (target.htmlSnippet) lines.push('', 'HTML:', target.htmlSnippet)
  if (payload.ancestorPath.length > 0) lines.push('', `Ancestor path: ${payload.ancestorPath.join(' > ')}`)
  if (target.fullPath) {
    if (lines.at(-1) !== '') lines.push('')
    lines.push(`Full DOM path: ${target.fullPath}`)
  }
  return lines.join('\n').trimEnd()
}

function pagePath(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.pathname || '/'}${parsed.search}`
  } catch { return url }
}

function labelFor(annotation: DesignAnnotation): string {
  const target = annotation.payload.target
  const name = collapse(target.accessibility.accessibleName || target.textSnippet).slice(0, 60)
  return markdownText(`${target.reactComponents ? `${collapse(target.reactComponents)} ` : ''}${target.tagName}${name ? ` "${name}"` : ''}`)
}

function annotationLines(annotation: DesignAnnotation, index: number, multiPage: boolean): string[] {
  const payload = annotation.payload
  const target = payload.target
  const lines = [`### ${index + 1}. ${labelFor(annotation)}`]
  if (multiPage) {
    lines.push(`**Browser tab id:** ${codeSpan(annotation.browserPageId)}`)
    lines.push(`**Viewport:** ${payload.page.viewportWidth}x${payload.page.viewportHeight}`)
  }
  lines.push(`**Intent:** ${annotation.intent}`)
  if (target.selector) lines.push(`**Selector:** ${codeSpan(target.selector)}`)
  if (target.elementPath) lines.push(`**Location:** ${codeSpan(target.elementPath)}`)
  if (target.sourceFile) lines.push(`**Source:** ${codeSpan(target.sourceFile)}`)
  if (target.reactComponents) lines.push(`**React:** ${codeSpan(target.reactComponents)}`)
  lines.push(`**Bounds:** x=${target.rectViewport.x}, y=${target.rectViewport.y}, ${target.rectViewport.width}x${target.rectViewport.height}`)
  if (target.cssClasses) lines.push(`**Classes:** ${codeSpan(target.cssClasses)}`)
  if (target.selectedText) lines.push(`**Selected text:** ${codeSpan(target.selectedText)}`)
  else if (target.textSnippet) lines.push(`**Text:** ${codeSpan(target.textSnippet)}`)
  if (payload.nearbyText.length > 0) lines.push('**Nearby text:**', ...payload.nearbyText.map((text) => `- ${codeSpan(text)}`))
  if (target.nearbyElements.length > 0) lines.push('**Nearby elements:**', ...target.nearbyElements.map((text) => `- ${codeSpan(text)}`))
  const styles = styleLines(payload)
  if (styles.length > 0) lines.push('**Computed styles:**', ...styles.map((line) => `- ${markdownText(line)}`))
  if (target.fullPath) lines.push(`**Full DOM path:** ${codeSpan(target.fullPath)}`)
  if (target.htmlSnippet) {
    const fence = htmlFence(target.htmlSnippet)
    lines.push(`**HTML:**\n${fence}html\n${target.htmlSnippet}\n${fence}`)
  }
  lines.push(...feedbackBlock(annotation.comment))
  return lines
}

export function formatBrowserAnnotationsAsMarkdown(input: DesignAnnotation[]): string {
  const annotations = clampAnnotations(input)
  if (annotations.length === 0) return ''
  const groups = new Map<string, DesignAnnotation[]>()
  for (const annotation of annotations) {
    const url = annotation.payload.page.sanitizedUrl
    const group = groups.get(url) ?? []
    group.push(annotation)
    groups.set(url, group)
  }
  const multiPage = groups.size > 1
  const output = [multiPage ? '## Design Feedback across pages' : `## Design Feedback: ${pagePath(annotations[0]!.payload.page.sanitizedUrl)}`]
  for (const [url, group] of groups) {
    if (multiPage) output.push('', `## Design Feedback: ${pagePath(url)}`)
    const first = group[0]!
    output.push('', `**URL:** ${url}`)
    if (!multiPage) output.push(`**Browser tab id:** ${codeSpan(first.browserPageId)}`)
    if (!multiPage) output.push(`**Viewport:** ${first.payload.page.viewportWidth}x${first.payload.page.viewportHeight}`)
    group.forEach((annotation, index) => output.push('', ...annotationLines(annotation, index, multiPage)))
  }
  return output.join('\n').trimEnd()
}
