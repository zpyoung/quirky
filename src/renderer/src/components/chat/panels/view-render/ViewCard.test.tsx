// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ViewNode } from '../../../../../../shared/view-spec/view-spec-types'
import { ViewCard } from './ViewCard'

vi.mock('../../markdown', () => ({ ChatMarkdown: () => null }))
vi.mock('../panel-link-opening', () => ({ openPanelLink: vi.fn(), openPanelPreview: vi.fn() }))

afterEach(cleanup)

const image = (path: string): ViewNode => ({ type: 'image', props: { path, alt: 'shot' } })

function card(root: ViewNode, readWorkspaceImage = vi.fn()) {
  render(
    <ViewCard
      spec={{ title: 'Card', root }}
      viewId="v1"
      workspaceRoot="/work/project"
      readWorkspaceImage={readWorkspaceImage}
    />
  )
  return readWorkspaceImage
}

describe('image nodes', () => {
  it.each(['../outside.png', '/etc/passwd', 'a/../../b.png'])(
    'shows an error tile and never reads %s',
    async (path) => {
      const read = card(image(path))
      await waitFor(() => expect(document.querySelector('[data-image-error]')).not.toBeNull())
      expect(read).not.toHaveBeenCalled()
    }
  )

  it('reads a path inside the workspace and shows it', async () => {
    const read = vi.fn().mockResolvedValue({ dataUrl: 'data:image/png;base64,AAAA' })
    card(image('docs/./shot.png'), read)
    const img = await screen.findByRole('img', { name: 'shot' })
    expect(img.getAttribute('src')).toBe('data:image/png;base64,AAAA')
    expect(read).toHaveBeenCalledWith('docs/shot.png')
  })
})

describe('controls', () => {
  it('render disabled with a visible hint', () => {
    card({ type: 'button', props: { label: 'Ship it', action: 'ship' } })
    expect(screen.getByRole('button', { name: 'Ship it' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByText("Answering from the panel isn't available yet")).toBeTruthy()
  })
})

describe('live previews', () => {
  it('offers Open preview only for a localhost url', () => {
    card({ type: 'live-preview', props: { url: 'http://localhost:3000' } })
    expect(screen.getByRole('button', { name: /Open preview/ })).toBeTruthy()
    cleanup()
    card({ type: 'live-preview', props: { url: 'https://example.com' } })
    expect(screen.queryByRole('button', { name: /Open preview/ })).toBeNull()
  })
})
