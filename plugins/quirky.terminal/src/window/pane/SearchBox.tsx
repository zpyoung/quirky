import { useEffect, type KeyboardEvent, type RefObject } from 'react'
import { Button, IconButton } from '@quirky/ui'

type Props = {
  query: string
  caseSensitive: boolean
  regex: boolean
  /** The match counter text: `0/0`, `No results`, `Regex too complex`, `n/total` or `total+`. */
  status: string
  inputRef: RefObject<HTMLInputElement | null>
  onQueryChange(query: string): void
  onCaseSensitiveChange(value: boolean): void
  onRegexChange(value: boolean): void
  onNext(): void
  onPrevious(): void
  onClose(): void
}


/**
 * The find box of a terminal pane: query field, Case sensitive and Regex toggles, the match
 * counter and Previous, Next and Close. It handles its own keys (Enter, Shift+Enter, Cmd+G,
 * Cmd+Shift+G, Escape) because the terminal's focus context is false while the field has focus.
 */
export function SearchBox(props: Props) {
  const { inputRef } = props

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [inputRef])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation()
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'Escape') {
      event.preventDefault()
      props.onClose()
    } else if (event.key === 'Enter') {
      event.preventDefault()
      if (event.shiftKey) props.onPrevious()
      else props.onNext()
    } else if (event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === 'g') {
      event.preventDefault()
      if (event.shiftKey) props.onPrevious()
      else props.onNext()
    }
  }

  return (
    <div data-pane-search className="tt-pane-search" onKeyDown={onKeyDown} role="search">
      <input
        ref={inputRef}
        type="text"
        className="ui-text-field__input tt-pane-search__input"
        aria-label="Search"
        placeholder="Search..."
        value={props.query}
        onChange={(event) => props.onQueryChange(event.target.value)}
      />
      <Button type="button" className="tt-pane-search__action" title="Case sensitive" aria-pressed={props.caseSensitive} onClick={() => props.onCaseSensitiveChange(!props.caseSensitive)}>
        Aa
      </Button>
      <Button type="button" className="tt-pane-search__action" title="Regex" aria-pressed={props.regex} onClick={() => props.onRegexChange(!props.regex)}>
        .*
      </Button>
      <span data-pane-search-status className="tt-pane-search__status">
        {props.status}
      </span>
      <span className="tt-pane-search__divider" />
      <IconButton className="tt-pane-search__action" type="button" label="Previous match" title="Previous match" onClick={props.onPrevious}>
        ↑
      </IconButton>
      <IconButton className="tt-pane-search__action" type="button" label="Next match" title="Next match" onClick={props.onNext}>
        ↓
      </IconButton>
      <span className="tt-pane-search__divider" />
      <IconButton className="tt-pane-search__action" type="button" label="Close search" title="Close" onClick={props.onClose}>
        ×
      </IconButton>
    </div>
  )
}
