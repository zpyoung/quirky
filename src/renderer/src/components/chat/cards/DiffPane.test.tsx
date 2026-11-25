// @vitest-environment happy-dom
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { DiffPane } from './DiffPane'

afterEach(cleanup)

function lineBlocks(): HTMLElement[] {
  return screen
    .getAllByRole('row')
    .filter((row) => row.hasAttribute('data-diff-line'))
    .flatMap((row) => (row.parentElement ? [row.parentElement] : []))
}

const REPLACEMENT = '@@ -3,1 +3,1 @@\n-old line\n+new line'

describe('DiffPane comments', () => {
  it('hangs a comment on the added line, not the removed line sharing its number', () => {
    render(
      <DiffPane
        patch={REPLACEMENT}
        path="a.ts"
        commentKey="k"
        comments={[{ id: '1', path: 'a.ts', line: 3, side: 'new', text: 'about the addition' }]}
      />
    )
    const [removed, added] = lineBlocks()
    if (!removed || !added) {
      throw new Error('expected a removed and an added line')
    }
    expect(within(removed).queryByText('about the addition')).toBeNull()
    expect(within(added).getByText('about the addition')).toBeTruthy()
  })

  it('hangs an old-side comment on the removed line', () => {
    render(
      <DiffPane
        patch={REPLACEMENT}
        path="a.ts"
        commentKey="k"
        comments={[{ id: '1', path: 'a.ts', line: 3, side: 'old', text: 'about the removal' }]}
      />
    )
    const [removed, added] = lineBlocks()
    if (!removed || !added) {
      throw new Error('expected a removed and an added line')
    }
    expect(within(removed).getByText('about the removal')).toBeTruthy()
    expect(within(added).queryByText('about the removal')).toBeNull()
  })
})
