import { useCallback, useEffect, useState, type CSSProperties } from 'react'
import type { MobileTerminalState, UiPluginContext } from '@quirky/protocol'

const shellStyle: CSSProperties = {
  position: 'absolute',
  top: 8,
  right: 8,
  zIndex: 20,
  maxWidth: 'min(420px, calc(100% - 16px))',
  padding: 12,
  border: '1px solid var(--border, #3a3d45)',
  borderRadius: 8,
  background: 'var(--bg-raised, rgba(29, 32, 39, .97))',
  color: 'var(--text, #d7dae0)',
  boxShadow: '0 4px 20px rgba(0, 0, 0, .3)',
  fontFamily: 'inherit',
  fontSize: 12,
  lineHeight: 1.45
}

const buttonStyle: CSSProperties = {
  border: '1px solid var(--border, #3a3d45)',
  borderRadius: 5,
  background: 'var(--bg-hover, #262a33)',
  color: 'var(--text, #d7dae0)',
  padding: '5px 8px',
  cursor: 'pointer',
  font: 'inherit'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function MobileDriverOverlay({ context, sessionId }: { context: UiPluginContext; sessionId: string }) {
  const [state, setState] = useState<MobileTerminalState | null>(null)
  const [minimized, setMinimized] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const result = (await context.call('quirky.terminal/mobileState', { session: sessionId })) as { terminals: MobileTerminalState[] }
      setState(result.terminals.find((terminal) => terminal.session === sessionId) ?? null)
    } catch (error) {
      setState(null)
      context.log(`could not read mobile terminal state: ${messageOf(error)}`)
    }
  }, [context, sessionId])

  useEffect(() => {
    void refresh()
    const unsubscribe = context.subscribe(async (event) => {
      if (event.type === 'quirky.terminal/mobileChanged') await refresh()
    })
    return unsubscribe
  }, [context, refresh])

  const run = async (method: 'takeBack' | 'restoreFit', params: Record<string, unknown>) => {
    try {
      await context.call(`quirky.terminal/${method}`, params)
      await refresh()
    } catch (error) {
      const title = method === 'takeBack' ? 'Could not take back terminal' : 'Could not restore terminal size'
      context.toast(title, messageOf(error), { kind: 'error' })
      await refresh()
    }
  }

  if (!state) return null

  const phoneFit = state.driver === null && state.phoneFit
  const allParams = {}
  const sessionParams = { session: sessionId }
  const title = phoneFit ? 'Still sized for your phone' : 'Your phone is in control'
  const description = phoneFit ? 'Your phone session ended. Restore to fit this window.' : 'Desktop typing is paused. Output keeps streaming.'

  if (minimized) {
    return (
      <div data-mobile-driver-overlay style={shellStyle} role="status">
        <strong>{phoneFit ? 'Still sized for your phone' : 'Phone driving'}</strong>
        <span style={{ display: 'inline-flex', gap: 6, marginLeft: 10 }}>
          {phoneFit ? (
            <button style={buttonStyle} type="button" aria-label="Restore this terminal" onClick={() => void run('restoreFit', sessionParams)}>Restore</button>
          ) : (
            <button style={buttonStyle} type="button" aria-label="Take back this terminal" onClick={() => void run('takeBack', sessionParams)}>Take back</button>
          )}
          <button style={buttonStyle} type="button" aria-label="Restore phone driving controls" onClick={() => setMinimized(false)}>Expand</button>
        </span>
      </div>
    )
  }

  return (
    <section data-mobile-driver-overlay style={shellStyle} aria-label={title}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <strong>{title}</strong>
          <p style={{ margin: '5px 0 0', color: 'var(--muted, #8a909e)' }}>{description}</p>
        </div>
        <button style={buttonStyle} type="button" aria-label="Minimize phone driving controls" onClick={() => setMinimized(true)}>Minimize</button>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
        {phoneFit ? (
          <>
            <button style={buttonStyle} type="button" aria-label="Restore this terminal" onClick={() => void run('restoreFit', sessionParams)}>Restore</button>
            <button style={buttonStyle} type="button" onClick={() => void run('restoreFit', allParams)}>Restore all</button>
          </>
        ) : (
          <>
            <button style={buttonStyle} type="button" aria-label="Take back this terminal" onClick={() => void run('takeBack', sessionParams)}>Take back</button>
            <button style={buttonStyle} type="button" onClick={() => void run('takeBack', allParams)}>Take back all</button>
          </>
        )}
      </div>
    </section>
  )
}
