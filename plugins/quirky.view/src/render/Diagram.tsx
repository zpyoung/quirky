import { useEffect, useRef } from 'react'
import { QuirkyMarkdown } from '@quirky/ui/markdown'
import { asString, type Props } from './props'
import { clampLabel, keyPart, pointKey } from './point'
import { useRuntime } from './runtime'
import { MUTED } from './styles'
import { when } from './when'

/** A fence long enough that nothing inside the Mermaid source can close it early. */
export function fenceFor(source: string): string {
  const longest = Math.max(2, ...(source.match(/`+/g) ?? []).map((run) => run.length))
  return '`'.repeat(longest + 1)
}

const FAILURE = /^Couldn't draw this diagram: ([\s\S]*?)\. Showing the source\.$/

/** The reason MermaidFence gave for not drawing, from its note, or the whole note when its wording changes. */
export function failureReason(note: string): string {
  const match = FAILURE.exec(note.trim())
  return match === null ? note.trim() : match[1]!
}

/**
 * The id the author gave a node in the Mermaid source, read from the node group mermaid draws it in.
 * Mermaid names the group `<svg id>-<diagram type>-<node id>-<n>`, so the svg id and type are stripped.
 */
export function nodeId(group: Element): string | undefined {
  const direct = group.getAttribute('data-id')
  if (direct !== null && direct !== '') return direct
  const svgId = group.closest('svg')?.id ?? ''
  const drawn = svgId !== '' && group.id.startsWith(`${svgId}-`) ? group.id.slice(svgId.length + 1) : group.id
  const match = /^[A-Za-z]+-(.+)-\d+$/.exec(drawn)
  return match === null ? undefined : match[1]
}

/**
 * A Mermaid diagram drawn by the same MermaidFence that draws chat fences, so it gets the same
 * strict security level, remote image blocking and svg sanitising. Each drawn node becomes
 * pointable by its Mermaid id, and a diagram mermaid cannot draw is reported to the card.
 */
export function Diagram({ props }: { props: Props }) {
  const source = asString(props.source)
  const caption = asString(props.caption)
  const { renderFailed, openLink: onLink } = useRuntime()
  const host = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const root = host.current
    if (root === null) return
    let reported: string | null = null
    const inspect = () => {
      const note = root.querySelector('[data-qmd-error] .qmd-error-message')
      const reason = note === null ? null : failureReason(note.textContent ?? '')
      if (reason !== null && reason !== reported) renderFailed(reason)
      reported = reason
      for (const group of root.querySelectorAll('svg g.node')) {
        const id = nodeId(group)
        if (id === undefined) continue
        group.setAttribute('data-point-key', pointKey('dg', keyPart(id, 'node')))
        group.setAttribute('data-point-label', clampLabel(group.textContent ?? id))
      }
    }
    inspect()
    const observer = new MutationObserver(inspect)
    observer.observe(root, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [source, renderFailed])

  const fence = fenceFor(source)
  return (
    <figure data-view-node="diagram" style={{ margin: 0, display: 'flex', flexDirection: 'column', gap: 'var(--ui-space-4)', minWidth: 0 }}>
      <div ref={host}>
        <QuirkyMarkdown text={`${fence}mermaid\n${source}\n${fence}`} profile="untrusted" onOpenLink={onLink} />
      </div>
      {when(caption !== '', () => <figcaption style={MUTED}>{caption}</figcaption>)}
    </figure>
  )
}
