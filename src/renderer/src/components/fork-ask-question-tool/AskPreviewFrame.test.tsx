// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { AskPreviewFrame, buildAskPreviewSrcDoc } from './AskPreviewFrame'
import type { AskPreview } from '../../../../shared/fork-ask-question-tool/ask-question-schema'

afterEach(() => cleanup())

describe('buildAskPreviewSrcDoc', () => {
  it('strips a <script> tag out of html-format preview content', () => {
    const preview: AskPreview = {
      format: 'html',
      content: '<p>hi</p><script>window.pwned = true</script>'
    }

    const srcDoc = buildAskPreviewSrcDoc(preview)

    expect(srcDoc).not.toContain('<script')
    expect(srcDoc).not.toContain('pwned')
    expect(srcDoc).toContain('hi')
  })

  it('strips an inline event handler from html-format preview content', () => {
    const preview: AskPreview = {
      format: 'html',
      content: '<img src="x" onerror="window.pwned = true">'
    }

    const srcDoc = buildAskPreviewSrcDoc(preview)

    expect(srcDoc).not.toContain('onerror')
  })

  it('strips a raw <script> embedded in markdown-format preview content', () => {
    const preview: AskPreview = {
      format: 'markdown',
      content: '# Title\n\n<script>window.pwned = true</script>'
    }

    const srcDoc = buildAskPreviewSrcDoc(preview)

    expect(srcDoc).not.toContain('<script')
    expect(srcDoc).not.toContain('pwned')
    expect(srcDoc).toContain('Title')
  })

  it('blocks scripts and remote resources via the shell CSP', () => {
    const srcDoc = buildAskPreviewSrcDoc({ format: 'markdown', content: 'hello' })

    expect(srcDoc).toContain('Content-Security-Policy')
    expect(srcDoc).toContain("script-src 'none'")
    expect(srcDoc).toContain("connect-src 'none'")
    expect(srcDoc).toContain('img-src data:')
  })
})

describe('AskPreviewFrame', () => {
  it('renders a sandboxed iframe with no allow-scripts and a sanitized srcDoc, never the raw model markup', () => {
    const preview: AskPreview = {
      format: 'html',
      content: '<script>window.pwned = true</script><p>safe</p>'
    }

    const { container } = render(<AskPreviewFrame preview={preview} />)
    const iframe = container.querySelector('iframe')

    expect(iframe).not.toBeNull()
    expect(iframe?.getAttribute('sandbox')).toBe('')
    expect(iframe?.getAttribute('srcdoc') ?? '').not.toContain('<script')
    expect(iframe?.getAttribute('srcdoc') ?? '').not.toContain('pwned')
    expect(iframe?.getAttribute('srcdoc') ?? '').toContain('safe')
  })
})
