// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { FRAME_CSP, WRAPPER_CSP, frameDocument, wrapperDocument } from './html-frame-document'
import { HtmlFrame } from './HtmlFrame'

afterEach(cleanup)

const CSP_META = (policy: string) =>
  `<meta http-equiv="Content-Security-Policy" content="${policy}">`

describe('frame documents', () => {
  it('puts the agent policy first, before any agent markup', () => {
    const doc = frameDocument('<script>alert(1)</script>', 'body{}')
    expect(doc.startsWith(CSP_META(FRAME_CSP))).toBe(true)
    expect(doc.indexOf('<script>alert(1)</script>')).toBeGreaterThan(doc.indexOf('</style>'))
  })

  it('keeps the network closed in the agent policy', () => {
    expect(FRAME_CSP).toContain("default-src 'none'")
    expect(FRAME_CSP).toContain("connect-src 'none'")
    expect(FRAME_CSP).toContain("frame-src 'none'")
    expect(FRAME_CSP).toContain('img-src data: blob:')
  })

  it('puts the wrapper policy first and nests the agent document', () => {
    const inner = frameDocument('<p class="a&b">"hi"</p>', '')
    const doc = wrapperDocument(inner, true)
    expect(doc.startsWith(CSP_META(WRAPPER_CSP))).toBe(true)
    expect(doc).toContain('<iframe id="agent" sandbox="allow-scripts" srcdoc="')
    expect(doc).toContain('class=&quot;a&amp;b&quot;')
  })

  it('gives a non-interactive agent frame no permissions', () => {
    expect(wrapperDocument('x', false)).toContain('sandbox=""')
  })
})

describe('HtmlFrame', () => {
  it('renders a frame sandboxed to scripts only, with no referrer', () => {
    const { container } = render(<HtmlFrame html="<p>hi</p>" interactive height={300} title="v" />)
    const frame = container.querySelector('iframe')
    expect(frame?.getAttribute('sandbox')).toBe('allow-scripts')
    expect(frame?.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(frame?.getAttribute('srcdoc')?.startsWith(CSP_META(WRAPPER_CSP))).toBe(true)
  })

  it('clamps the height to the allowed range', () => {
    const { container } = render(<HtmlFrame html="" interactive={false} height={99999} title="v" />)
    expect(container.querySelector('iframe')?.style.height).toBe('1200px')
  })
})
