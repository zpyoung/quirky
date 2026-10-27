import { useLayoutEffect, useState, type RefObject } from 'react'

export type BoxSize = { width: number; height: number }

/** The size of an element in CSS px, kept current by a ResizeObserver; 0 x 0 until it is laid out. */
export function useBoxSize(ref: RefObject<HTMLElement | null>): BoxSize {
  const [size, setSize] = useState<BoxSize>({ width: 0, height: 0 })
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const measure = () => {
      const { width, height } = element.getBoundingClientRect()
      setSize((previous) => (previous.width === width && previous.height === height ? previous : { width, height }))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return size
}
