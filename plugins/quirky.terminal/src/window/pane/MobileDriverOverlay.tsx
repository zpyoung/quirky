import { useCallback, useEffect, useState } from 'react'
import { Button } from '@quirky/ui'
import type { MobileTerminalState, UiPluginContext } from '@quirky/protocol'


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
      <div data-mobile-driver-overlay className="terminal-mobile-driver" role="status">
        <strong>{phoneFit ? 'Still sized for your phone' : 'Phone driving'}</strong>
        <span className="terminal-mobile-driver__minimized-actions">
          {phoneFit ? (
            <Button aria-label="Restore this terminal" onClick={() => void run('restoreFit', sessionParams)}>Restore</Button>
          ) : (
            <Button aria-label="Take back this terminal" onClick={() => void run('takeBack', sessionParams)}>Take back</Button>
          )}
          <Button aria-label="Restore phone driving controls" onClick={() => setMinimized(false)}>Expand</Button>
        </span>
      </div>
    )
  }

  return (
    <section data-mobile-driver-overlay className="terminal-mobile-driver" aria-label={title}>
      <div className="terminal-mobile-driver__summary">
        <div>
          <strong>{title}</strong>
          <p className="terminal-mobile-driver__description">{description}</p>
        </div>
        <Button aria-label="Minimize phone driving controls" onClick={() => setMinimized(true)}>Minimize</Button>
      </div>
      <div className="terminal-mobile-driver__actions">
        {phoneFit ? (
          <>
            <Button aria-label="Restore this terminal" onClick={() => void run('restoreFit', sessionParams)}>Restore</Button>
            <Button onClick={() => void run('restoreFit', allParams)}>Restore all</Button>
          </>
        ) : (
          <>
            <Button aria-label="Take back this terminal" onClick={() => void run('takeBack', sessionParams)}>Take back</Button>
            <Button onClick={() => void run('takeBack', allParams)}>Take back all</Button>
          </>
        )}
      </div>
    </section>
  )
}
