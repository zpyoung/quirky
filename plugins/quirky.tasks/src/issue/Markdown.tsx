import { useRef, useState, type ClipboardEvent, type CSSProperties, type DragEvent, type ReactNode } from 'react'

export type MarkdownProps = { source: string }
export type MarkdownComposerProps = {
  value: string
  onChange(value: string): void
  label: string
  placeholder?: string
  disabled?: boolean
  minRows?: number
  onSubmit?(): void
}


const blockStart = /^(?:#{1,6}\s|```|>\s?|[-*+]\s+|\d+\.\s+|(?:---+|___+|\*\*\*+)\s*$)/
const INLINE_TOKEN = /!\[([^\]]*)\]\(([^)\s]+)\)|\[([^\]]+)\]\(([^)\s]+)\)|`([^`\n]+)`|\*\*(.+?)\*\*|__(.+?)__|~~(.+?)~~|\*([^*\n]+)\*|_([^_\n]+)_/g

export function safeHttpUrl(value: string, maxBytes = Number.POSITIVE_INFINITY): string | null {
  const trimmed = value.trim()
  if (trimmed.length === 0 || new TextEncoder().encode(trimmed).byteLength > maxBytes) return null
  try {
    const url = new URL(trimmed)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username.length > 0 || url.password.length > 0) return null
    return url.href
  } catch {
    return null
  }
}

function renderInline(source: string, keyBase = 0): ReactNode[] {
  const output: ReactNode[] = []
  let cursor = 0
  let key = keyBase
  for (const match of source.matchAll(INLINE_TOKEN)) {
    const start = match.index ?? cursor
    if (start > cursor) output.push(source.slice(cursor, start))
    const token = match[0]
    if (token.startsWith('![')) {
      const url = safeHttpUrl(match[2] ?? '')
      if (url) output.push(<img key={key} src={url} alt={match[1] ?? ''} loading="lazy" style={{ maxWidth: '100%', height: 'auto' }} />)
      else output.push(token)
    } else if (token.startsWith('[')) {
      const url = safeHttpUrl(match[4] ?? '')
      if (url) output.push(<a key={key} href={url} target="_blank" rel="noreferrer">{renderInline(match[3] ?? '', key + 100_000)}</a>)
      else output.push(token)
    } else if (token.startsWith('`')) {
      output.push(<code key={key}>{match[5]}</code>)
    } else if (token.startsWith('**') || token.startsWith('__')) {
      output.push(<strong key={key}>{renderInline(match[6] ?? match[7] ?? '', key + 100_000)}</strong>)
    } else if (token.startsWith('~~')) {
      output.push(<del key={key}>{renderInline(match[8] ?? '', key + 100_000)}</del>)
    } else {
      output.push(<em key={key}>{renderInline(match[9] ?? match[10] ?? '', key + 100_000)}</em>)
    }
    cursor = start + token.length
    key += 1
  }
  if (cursor < source.length) output.push(source.slice(cursor))
  return output
}

function isBlockStart(line: string): boolean {
  return blockStart.test(line)
}

function renderBlocks(source: string, keyBase = 0): ReactNode[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const blocks: ReactNode[] = []
  let cursor = 0
  let key = keyBase
  while (cursor < lines.length) {
    const line = lines[cursor] ?? ''
    if (line.trim().length === 0) {
      cursor += 1
      continue
    }
    const fence = /^```/.exec(line)
    if (fence) {
      const code: string[] = []
      cursor += 1
      while (cursor < lines.length && !/^```/.test(lines[cursor] ?? '')) {
        code.push(lines[cursor] ?? '')
        cursor += 1
      }
      if (cursor < lines.length) cursor += 1
      blocks.push(<pre key={key}><code>{code.join('\n')}</code></pre>)
      key += 1
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      const level = Math.min(6, heading[1]?.length ?? 1)
      const children = renderInline(heading[2] ?? '', key * 100)
      if (level === 1) blocks.push(<h1 key={key}>{children}</h1>)
      else if (level === 2) blocks.push(<h2 key={key}>{children}</h2>)
      else if (level === 3) blocks.push(<h3 key={key}>{children}</h3>)
      else if (level === 4) blocks.push(<h4 key={key}>{children}</h4>)
      else if (level === 5) blocks.push(<h5 key={key}>{children}</h5>)
      else blocks.push(<h6 key={key}>{children}</h6>)
      cursor += 1
      key += 1
      continue
    }
    if (/^(?:---+|___+|\*\*\*+)\s*$/.test(line)) {
      blocks.push(<hr key={key} />)
      cursor += 1
      key += 1
      continue
    }
    if (/^>\s?/.test(line)) {
      const quote: string[] = []
      while (cursor < lines.length && /^>\s?/.test(lines[cursor] ?? '')) {
        quote.push((lines[cursor] ?? '').replace(/^>\s?/, ''))
        cursor += 1
      }
      blocks.push(<blockquote key={key}>{renderBlocks(quote.join('\n'), key * 100)}</blockquote>)
      key += 1
      continue
    }
    if (/^[-*+]\s+/.test(line)) {
      const items: ReactNode[] = []
      while (cursor < lines.length && /^[-*+]\s+/.test(lines[cursor] ?? '')) {
        items.push(<li key={key + items.length}>{renderInline((lines[cursor] ?? '').replace(/^[-*+]\s+/, ''), (key + items.length) * 100)}</li>)
        cursor += 1
      }
      blocks.push(<ul key={key}>{items}</ul>)
      key += items.length + 1
      continue
    }
    if (/^\d+\.\s+/.test(line)) {
      const items: ReactNode[] = []
      while (cursor < lines.length && /^\d+\.\s+/.test(lines[cursor] ?? '')) {
        items.push(<li key={key + items.length}>{renderInline((lines[cursor] ?? '').replace(/^\d+\.\s+/, ''), (key + items.length) * 100)}</li>)
        cursor += 1
      }
      blocks.push(<ol key={key}>{items}</ol>)
      key += items.length + 1
      continue
    }
    const paragraph = [line]
    cursor += 1
    while (cursor < lines.length && (lines[cursor] ?? '').trim().length > 0 && !isBlockStart(lines[cursor] ?? '')) {
      paragraph.push(lines[cursor] ?? '')
      cursor += 1
    }
    blocks.push(<p key={key}>{renderInline(paragraph.join('\n'), key * 100)}</p>)
    key += 1
  }
  return blocks
}

export function Markdown({ source }: MarkdownProps) {
  return <div className="quirky-tasks-markdown">{renderBlocks(source)}</div>
}

function markdownAlt(url: string): string {
  const segment = new URL(url).pathname.split('/').filter(Boolean).at(-1) ?? 'image'
  const name = segment.replace(/\.[A-Za-z0-9]{1,8}$/, '').replace(/[\[\]\\]/g, '').trim()
  return name || 'image'
}

export function MarkdownComposer({ value, onChange, label, placeholder, disabled = false, minRows = 7, onSubmit }: MarkdownComposerProps) {
  const [tab, setTab] = useState<'write' | 'preview'>('write')
  const [showImageUrl, setShowImageUrl] = useState(false)
  const [imageUrl, setImageUrl] = useState('')
  const [imageError, setImageError] = useState('')
  const [inputError, setInputError] = useState('')
  const textarea = useRef<HTMLTextAreaElement>(null)
  const selection = useRef({ start: 0, end: 0 })

  const trackSelection = () => {
    if (textarea.current) selection.current = { start: textarea.current.selectionStart, end: textarea.current.selectionEnd }
  }
  const insertMarkdown = (text: string) => {
    const start = Math.min(selection.current.start, value.length)
    const end = Math.min(selection.current.end, value.length)
    onChange(value.slice(0, start) + text + value.slice(end))
    setImageError('')
    setInputError('')
    requestAnimationFrame(() => {
      textarea.current?.focus()
      const cursor = start + text.length
      textarea.current?.setSelectionRange(cursor, cursor)
      selection.current = { start: cursor, end: cursor }
    })
  }
  const insertImage = (raw: string) => {
    const url = safeHttpUrl(raw, 8192)
    if (!url) {
      setImageError('Use an absolute HTTP(S) image URL no longer than 8 KiB.')
      return false
    }
    insertMarkdown(`![${markdownAlt(url)}](${url})`)
    return true
  }
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.items).filter((item) => item.kind === 'file')
    if (files.length > 0) {
      event.preventDefault()
      setInputError('Binary image attachments are not supported; paste an HTTP(S) image URL instead.')
      return
    }
    const text = event.clipboardData.getData('text/plain')
    if (text.trim().length > 0 && !/[\r\n]/.test(text) && safeHttpUrl(text, 8192)) {
      event.preventDefault()
      insertImage(text)
    }
  }
  const onDrop = (event: DragEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.dataTransfer.files)
    if (files.length > 0) {
      event.preventDefault()
      setInputError('Binary image attachments are not supported; drop an HTTP(S) image URL instead.')
      return
    }
    const text = event.dataTransfer.getData('text/uri-list') || event.dataTransfer.getData('text/plain')
    if (text.trim().length > 0 && !/[\r\n]/.test(text) && safeHttpUrl(text, 8192)) {
      event.preventDefault()
      insertImage(text)
    }
  }

  const toolbarButton: CSSProperties = { border: '1px solid var(--border, #3a3d43)', borderRadius: 5, background: 'var(--surface, #22252b)', color: 'var(--text, #e5e7eb)', padding: '4px 8px', cursor: disabled ? 'default' : 'pointer' }
  return <section aria-label={label} style={{ display: 'grid', gap: 8 }}>
    <div role="tablist" aria-label={`${label} editor`} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      <button type="button" role="tab" aria-selected={tab === 'write'} onClick={() => setTab('write')} style={toolbarButton}>Write</button>
      <button type="button" role="tab" aria-selected={tab === 'preview'} onClick={() => setTab('preview')} style={toolbarButton}>Preview</button>
      {tab === 'write' && <button type="button" onClick={() => { setShowImageUrl((shown) => !shown); setImageError('') }} disabled={disabled} style={{ ...toolbarButton, marginLeft: 'auto' }}>Insert image URL</button>}
    </div>
    {tab === 'write'
      ? <>
          <textarea
            ref={textarea}
            aria-label={label}
            placeholder={placeholder}
            value={value}
            disabled={disabled}
            rows={minRows}
            onChange={(event) => { onChange(event.currentTarget.value); trackSelection(); setInputError('') }}
            onSelect={trackSelection}
            onClick={trackSelection}
            onKeyUp={trackSelection}
            onKeyDown={(event) => {
              if (onSubmit && event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                event.stopPropagation()
                onSubmit()
              }
            }}
            onPaste={onPaste}
            onDrop={onDrop}
            onDragOver={(event) => {
              if (event.dataTransfer.files.length > 0 || safeHttpUrl(event.dataTransfer.getData('text/uri-list') || event.dataTransfer.getData('text/plain'), 8192)) event.preventDefault()
            }}
            style={{ width: '100%', boxSizing: 'border-box', resize: 'vertical', border: '1px solid var(--border, #3a3d43)', borderRadius: 6, background: 'var(--surface, #22252b)', color: 'var(--text, #e5e7eb)', padding: 10, font: 'inherit' }}
          />
          {showImageUrl && <div role="group" aria-label="Insert image by URL" style={{ display: 'flex', gap: 6 }}>
            <input
              aria-label="Image URL"
              type="text"
              inputMode="url"
              value={imageUrl}
              onChange={(event) => setImageUrl(event.currentTarget.value)}
              placeholder="https://example.com/image.png"
              maxLength={8192}
              disabled={disabled}
              style={{ flex: 1, minWidth: 0, border: '1px solid var(--border, #3a3d43)', borderRadius: 5, background: 'var(--surface, #22252b)', color: 'var(--text, #e5e7eb)', padding: 7, font: 'inherit' }}
            />
            <button type="button" disabled={disabled || imageUrl.trim().length === 0} onClick={() => {
              if (insertImage(imageUrl)) {
                setImageUrl('')
                setShowImageUrl(false)
              }
            }} style={toolbarButton}>Insert</button>
          </div>}
          <p style={{ margin: 0, color: 'var(--text-muted, #9ca3af)', fontSize: 12 }}>Paste, drop, or enter an HTTP(S) image URL.</p>
          {imageError && <p role="alert" style={{ margin: 0, color: 'var(--danger, #f87171)' }}>{imageError}</p>}
          {inputError && <p role="alert" style={{ margin: 0, color: 'var(--danger, #f87171)' }}>{inputError}</p>}
        </>
      : <div role="tabpanel" aria-label={`${label} preview`} style={{ minHeight: 64, padding: 10, border: '1px solid var(--border, #3a3d43)', borderRadius: 6, color: 'var(--text, #e5e7eb)', overflowWrap: 'anywhere' }}>
          {value.trim().length === 0 ? <span style={{ color: 'var(--text-muted, #9ca3af)' }}>Nothing to preview</span> : <Markdown source={value} />}
        </div>}
  </section>
}
