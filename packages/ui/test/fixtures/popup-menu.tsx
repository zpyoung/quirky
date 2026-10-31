import { createElement, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { PopupMenu } from '../../src/design-system/popup-menu'

function PopupMenuFixture() {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  const [selected, setSelected] = useState('')
  const items = [
    { label: 'First item', onSelect: () => setSelected('First item') },
    { label: 'Second item', onSelect: () => setSelected('Second item') },
  ]

  return <main>
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation()
        setAnchor(event.currentTarget)
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >Open menu</button>
    <output id="selection">{selected}</output>
    {anchor && <PopupMenu anchor={anchor} items={items} onClose={() => setAnchor(null)} />}
  </main>
}

createRoot(document.getElementById('root')!).render(createElement(PopupMenuFixture))
