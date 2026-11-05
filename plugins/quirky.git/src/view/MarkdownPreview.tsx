import { useEffect, useRef, useState } from 'react'
import { EmptyState, StatusDot } from '@quirky/ui'
import type { UiPluginContext } from '@quirky/protocol'

import { messageOf } from './data'

const INVALID_REPLY = 'The Markdown preview renderer returned invalid content.'

type Rendered = { status: 'rendering' } | { status: 'ready'; html: string } | { status: 'failed'; message: string }

/** The renderer's html when `value` echoes this request and carries a string `html`, otherwise null. */
function htmlOf(value: unknown, expected: { leaseId: string; worktreeId: string; path: string }): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const reply = value as Record<string, unknown>
  const echoed = reply.leaseId === expected.leaseId && reply.worktreeId === expected.worktreeId && reply.path === expected.path
  return echoed && typeof reply.html === 'string' ? reply.html : null
}

export type MarkdownPreviewProps = {
  context: UiPluginContext
  /** The worktree's id, which the renderer resolves relative images against. */
  worktree: string
  path: string
  /** Changes when the card's diff does, which renders again. */
  revision: number
  /** The text to render, read when a render starts: the card's draft when it has one. */
  textOf(): string
}

/**
 * A Markdown file rendered by the editor plugin. Each render holds its own lease on the renderer,
 * released when the render is replaced, refused, or the preview goes away, so a reply that lands
 * after that is released too. A failed or refused render shows why in place of the page.
 */
export function MarkdownPreview({ context, worktree, path, revision, textOf }: MarkdownPreviewProps) {
  const [rendered, setRendered] = useState<Rendered>({ status: 'rendering' })
  const latest = useRef(textOf)
  latest.current = textOf

  useEffect(() => {
    const leaseId = crypto.randomUUID()
    let active = true
    let released = false
    const release = () => {
      try {
        void context.call('quirky.editor/markdownPreview', { action: 'release', leaseId }).catch(() => {})
      } catch {
        // a lease the renderer no longer knows is already gone
      }
    }
    const fail = (message: string) => {
      released = true
      release()
      setRendered({ status: 'failed', message })
    }
    context
      .call('quirky.editor/markdownPreview', { action: 'render', leaseId, worktree: `id:${worktree}`, path, text: latest.current() })
      .then(
        (value) => {
          if (!active) return release()
          const html = htmlOf(value, { leaseId, worktreeId: worktree, path })
          if (html === null) fail(INVALID_REPLY)
          else setRendered({ status: 'ready', html })
        },
        (reason: unknown) => {
          if (active) fail(messageOf(reason))
          else release()
        }
      )
    return () => {
      active = false
      if (!released) release()
    }
  }, [context, worktree, path, revision])

  if (rendered.status === 'failed') {
    return (
      <div role="alert">
        <EmptyState message={`Markdown preview unavailable: ${rendered.message}`} icon={<StatusDot status="failing" />} />
      </div>
    )
  }
  if (rendered.status === 'rendering') return <p className="ui-text-muted git-review__notice">Rendering Markdown...</p>
  return (
    <div
      data-markdown-preview
      className="markdown-preview-body markdown-body--editor git-review__preview"
      dangerouslySetInnerHTML={{ __html: rendered.html }}
    />
  )
}
