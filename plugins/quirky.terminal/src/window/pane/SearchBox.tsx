import { useEffect, type CSSProperties, type KeyboardEvent, type RefObject } from 'react'

type Props = {
  query: string
  caseSensitive: boolean
  regex: boolean
  /** The match counter text: `0/0`, `No results`, `n/total` or `total+`. */
  status: string
  inputRef: RefObject<HTMLInputElement | null>
  onQueryChange(query: string): void
  onCaseSensitiveChange(value: boolean): void
  onRegexChange(value: boolean): void
  onNext(): void
  onPrevious(): void
  onClose(): void
}

const style: Record<string, CSSProperties> = {
  box: {
    position: 'absolute',
    top: 8,
    right: 8,
    zIndex: 20,
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    width: 340,
    maxWidth: 'calc(100% - 16px)',
    padding: '4px 8px',
    borderRadius: 8,
    border: '1px solid var(--border, #3a3d45)',
    background: 'var(--popover, rgba(30, 32, 38, 0.95))',
    color: 'var(--popover-foreground, #d7dae0)',
    boxShadow: '0 4px 14px rgba(0, 0, 0, 0.35)',
    fontSize: 12
  },
  input: { flex: 1, minWidth: 0, border: 'none', outline: 'none', background: 'transparent', color: 'inherit', fontSize: 13 },
  status: { flexShrink: 0, padding: '0 4px', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums', opacity: 0.7 },
  button: { flexShrink: 0, minWidth: 22, height: 22, padding: '0 4px', border: 'none', borderRadius: 4, background: 'transparent', color: 'inherit', cursor: 'pointer' },
  pressed: { background: 'rgba(255, 255, 255, 0.16)' },
  divider: { width: 1, height: 16, background: 'var(--border, #3a3d45)' }
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
    <div data-pane-search style={style.box} onKeyDown={onKeyDown} role="search">
      <input
        ref={inputRef}
        type="text"
        aria-label="Search"
        placeholder="Search..."
        style={style.input}
        value={props.query}
        onChange={(event) => props.onQueryChange(event.target.value)}
      />
      <button type="button" title="Case sensitive" aria-pressed={props.caseSensitive} style={{ ...style.button, ...(props.caseSensitive ? style.pressed : null) }} onClick={() => props.onCaseSensitiveChange(!props.caseSensitive)}>
        Aa
      </button>
      <button type="button" title="Regex" aria-pressed={props.regex} style={{ ...style.button, ...(props.regex ? style.pressed : null) }} onClick={() => props.onRegexChange(!props.regex)}>
        .*
      </button>
      <span data-pane-search-status style={style.status}>
        {props.status}
      </span>
      <span style={style.divider} />
      <button type="button" title="Previous match" aria-label="Previous match" style={style.button} onClick={props.onPrevious}>
        ↑
      </button>
      <button type="button" title="Next match" aria-label="Next match" style={style.button} onClick={props.onNext}>
        ↓
      </button>
      <span style={style.divider} />
      <button type="button" title="Close" aria-label="Close search" style={style.button} onClick={props.onClose}>
        ×
      </button>
    </div>
  )
}
