import { useEffect, useRef, useState } from 'react'

/**
 * A field that saves every edit at once and shows what the person typed meanwhile. Saves run
 * one after another in the order made, and the field takes `value` again only when none is
 * pending, so a refresh in the middle of typing cannot overwrite the text.
 *
 * `change(shown, sent)` shows `shown` and saves `sent` (default: the same text), for a reset
 * that sends an empty value yet shows the default.
 */
export function useDraft(value: string, save: (next: string) => Promise<void>): [string, (shown: string, sent?: string) => void] {
  const [text, setText] = useState(value)
  const [idle, setIdle] = useState(0)
  const pending = useRef(0)
  const tail = useRef<Promise<unknown>>(Promise.resolve())

  useEffect(() => {
    if (pending.current === 0) setText(value)
  }, [value, idle])

  const change = (shown: string, sent: string = shown) => {
    setText(shown)
    pending.current += 1
    tail.current = tail.current
      .then(() => save(sent))
      .catch(() => {})
      .then(() => {
        pending.current -= 1
        if (pending.current === 0) setIdle((n) => n + 1)
      })
  }
  return [text, change]
}
