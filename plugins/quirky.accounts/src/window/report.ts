import { useEffect, useRef } from 'react'

export type UiReport = (state: unknown) => void

export function useStableReport(report: UiReport | undefined, state: unknown): void {
  const lastState = useRef<string | null>(null)
  const serialized = JSON.stringify(state)
  useEffect(() => {
    if (!report || serialized === lastState.current) return
    lastState.current = serialized ?? null
    report(state)
  }, [report, serialized, state])
}
