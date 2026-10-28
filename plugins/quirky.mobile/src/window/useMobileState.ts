import { useCallback, useEffect, useRef, useState } from 'react'
import type { MobileDevice, MobileNetworkInterface, MobileState, UiPluginContext } from '@quirky/protocol'
import { configureMobile, getMobileDevices, getMobileInterfaces, getMobileState, type MobileConfigure } from './api'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export type MobileData = {
  state: MobileState | null
  loading: boolean
  error: string | null
  refresh(): Promise<void>
  refreshDevices(): Promise<MobileDevice[]>
  refreshInterfaces(): Promise<MobileNetworkInterface[]>
  configure(changes: MobileConfigure): Promise<MobileState>
}

/** Keeps the plugin UI on the public mobile RPC projection and invalidates it on daemon events. */
export function useMobileState(context: UiPluginContext): MobileData {
  const [state, setState] = useState<MobileState | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(false)

  const refresh = useCallback(async () => {
    try {
      const next = await getMobileState(context)
      if (alive.current) {
        setState(next)
        setError(null)
      }
    } catch (reason) {
      if (alive.current) setError(messageOf(reason))
    } finally {
      if (alive.current) setLoading(false)
    }
  }, [context])

  const refreshDevices = useCallback(async () => {
    const devices = await getMobileDevices(context)
    if (alive.current) setState((current) => (current ? { ...current, devices } : current))
    return devices
  }, [context])

  const refreshInterfaces = useCallback(async () => {
    const interfaces = await getMobileInterfaces(context)
    if (alive.current) setState((current) => (current ? { ...current, interfaces } : current))
    return interfaces
  }, [context])

  const configure = useCallback(
    async (changes: MobileConfigure) => {
      const next = await configureMobile(context, changes)
      if (alive.current) {
        setState(next)
        setError(null)
      }
      return next
    },
    [context]
  )

  useEffect(() => {
    alive.current = true
    void refresh()
    const unsubscribe = context.subscribe(async (event) => {
      if (event.type !== 'quirky.mobile/changed') return
      await Promise.all([refresh(), refreshDevices()]).catch((reason: unknown) => {
        if (alive.current) setError(messageOf(reason))
      })
    })
    return () => {
      alive.current = false
      unsubscribe()
    }
  }, [context, refresh, refreshDevices])

  return { state, loading, error, refresh, refreshDevices, refreshInterfaces, configure }
}
