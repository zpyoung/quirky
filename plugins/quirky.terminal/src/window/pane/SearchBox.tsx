import { useEffect, type KeyboardEvent, type RefObject } from 'react'
import { Button, IconButton } from '@quirky/ui'
import type { UiPluginContext } from '@quirky/protocol'
import { requestWindowCommand, searchCommand, searchNextCommand, searchPreviousCommand, searchCloseCommand, type WindowCommandDescriptor } from './commands'

type Props = {
  context: UiPluginContext
  paneId: string
  query: string
  caseSensitive: boolean
  regex: boolean
  /** The match counter text: `0/0`, `No results`, `Regex too complex`, `n/total` or `total+`. */
  status: string
  inputRef: RefObject<HTMLInputElement | null>
  onQueryChange(query: string): void
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

  const dispatch = (descriptor: WindowCommandDescriptor) => {
    void requestWindowCommand(props.context, descriptor).catch((error: unknown) => {
      props.context.toast('Could not run terminal action', error instanceof Error ? error.message : String(error), { kind: 'error' })
    })
  }
  const toggleCaseSensitive = () => dispatch(searchCommand(props.paneId, { caseSensitive: !props.caseSensitive }))
  const toggleRegex = () => dispatch(searchCommand(props.paneId, { regex: !props.regex }))
  const next = () => dispatch(searchNextCommand(props.paneId))
  const previous = () => dispatch(searchPreviousCommand(props.paneId))
  const close = () => dispatch(searchCloseCommand(props.paneId))

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation()
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
    } else if (event.key === 'Enter') {
      event.preventDefault()
      if (event.shiftKey) previous()
      else next()
    } else if (event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === 'g') {
      event.preventDefault()
      if (event.shiftKey) previous()
      else next()
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
      <Button type="button" className="tt-pane-search__action" title="Case sensitive" aria-pressed={props.caseSensitive} onClick={toggleCaseSensitive}>
        Aa
      </Button>
      <Button type="button" className="tt-pane-search__action" title="Regex" aria-pressed={props.regex} onClick={toggleRegex}>
        .*
      </Button>
      <span data-pane-search-status className="tt-pane-search__status">
        {props.status}
      </span>
      <span className="tt-pane-search__divider" />
      <IconButton className="tt-pane-search__action" type="button" label="Previous match" title="Previous match" onClick={previous}>
        ↑
      </IconButton>
      <IconButton className="tt-pane-search__action" type="button" label="Next match" title="Next match" onClick={next}>
        ↓
      </IconButton>
      <span className="tt-pane-search__divider" />
      <IconButton className="tt-pane-search__action" type="button" label="Close search" title="Close" onClick={close}>
        ×
      </IconButton>
    </div>
  )
}
