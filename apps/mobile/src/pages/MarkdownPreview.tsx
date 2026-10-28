import { createElement, type ReactElement } from 'react'

export function MarkdownPreview({ text }: { text: string }) {
  const lines = text.split(/\r?\n/)
  const blocks: ReactElement[] = []
  let index = 0
  let blockKey = 0

  while (index < lines.length) {
    const line = lines[index]!
    if (line.trim() === '') {
      index++
      continue
    }

    if (/^\s*```/.test(line)) {
      const code: string[] = []
      index++
      while (index < lines.length && !/^\s*```/.test(lines[index]!)) code.push(lines[index++]!)
      if (index < lines.length) index++
      blocks.push(<pre key={`code-${blockKey++}`} style={{ overflowX: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}><code>{code.join('\n')}</code></pre>)
      continue
    }

    const heading = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      const element = `h${heading[1]!.length}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
      blocks.push(createElement(element, { key: `heading-${blockKey++}` }, heading[2]!))
      index++
      continue
    }

    const paragraph = [line]
    index++
    while (index < lines.length && lines[index]!.trim() !== '' && !/^\s*```/.test(lines[index]!) && !/^\s{0,3}#{1,6}\s+/.test(lines[index]!)) {
      paragraph.push(lines[index++]!)
    }
    blocks.push(<p key={`paragraph-${blockKey++}`} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{paragraph.join('\n')}</p>)
  }

  return <article className="qp-markdown-preview">{blocks}</article>
}
