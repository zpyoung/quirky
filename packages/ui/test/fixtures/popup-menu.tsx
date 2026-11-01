import { createElement, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { PopupMenu } from '../../src/design-system/popup-menu'

function PopupMenuFixture() {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  const [selected, setSelected] = useState('')
  const [searchable, setSearchable] = useState(false)
  const items = [
    { label: 'First item', onSelect: () => setSelected('First item') },
    { label: 'Second item', onSelect: () => setSelected('Second item') },
  ]

  return <main>
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation()
        setSearchable(false)
        setAnchor(event.currentTarget)
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >Open menu</button>
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation()
        setSearchable(true)
        setAnchor(event.currentTarget)
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >Search menu</button>
    <output id="selection">{selected}</output>
    {anchor && <PopupMenu
      anchor={anchor}
      items={items}
      searchPlaceholder={searchable ? 'Search items' : undefined}
      onClose={() => setAnchor(null)}
    />}
  </main>
}

createRoot(document.getElementById('root')!).render(createElement(PopupMenuFixture))
