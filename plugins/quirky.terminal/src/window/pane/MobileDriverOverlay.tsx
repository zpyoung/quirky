import { useEffect, useRef, useState } from 'react'
import { Button, InlineError } from '@quirky/ui'
import type { MobileTerminalState, UiPluginContext } from '@quirky/protocol'


function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function MobileDriverOverlay({ context, sessionId }: { context: UiPluginContext; sessionId: string }) {
  const [state, setState] = useState<MobileTerminalState | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const mounted = useRef(false)
  const generation = useRef(0)
  const readSequence = useRef(0)
  const target = useRef({ context, sessionId })
  target.current = { context, sessionId }

  const refresh = async () => {
    if (!mounted.current || target.current.context !== context || target.current.sessionId !== sessionId) return
    const epoch = generation.current
    const sequence = ++readSequence.current
    try {
      const result = (await context.call('quirky.terminal/mobileState', { session: sessionId })) as { terminals: MobileTerminalState[] }
      if (!mounted.current || epoch !== generation.current || sequence !== readSequence.current) return
      setState(result.terminals.find((terminal) => terminal.session === sessionId) ?? null)
      setReadError(null)
    } catch (error) {
      if (!mounted.current || epoch !== generation.current || sequence !== readSequence.current) return
      setReadError(`Could not read mobile terminal state: ${messageOf(error)}`)
    }
  }
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh

  useEffect(() => {
    mounted.current = true
    generation.current += 1
    setState(null)
    setReadError(null)
    void refreshRef.current()
    const unsubscribe = context.subscribe((event) => {
      if (event.type === 'quirky.terminal/mobileChanged') void refreshRef.current()
    })
    return () => {
      mounted.current = false
      generation.current += 1
      unsubscribe()
    }
  }, [context, sessionId])

  const takeBack = async (params: { session?: string }) => {
    try {
      await context.call('quirky.terminal/takeBack', params)
    } catch (error) {
      context.toast('Could not take back terminal', messageOf(error), { kind: 'error' })
    } finally {
      await refresh()
    }
  }
  const restoreFit = async (params: { session?: string }) => {
    try {
      await context.call('quirky.terminal/restoreFit', params)
    } catch (error) {
      context.toast('Could not restore terminal size', messageOf(error), { kind: 'error' })
    } finally {
      await refresh()
    }
  }

  const phoneFit = state?.driver === null && state.phoneFit
  const title = phoneFit ? 'Still sized for your phone' : 'Your phone is in control'
  const description = phoneFit ? 'Your phone session ended. Restore to fit this window.' : 'Desktop typing is paused. Output keeps streaming.'

  if (!state && !readError) return null

  return (
    <div className="terminal-mobile-driver" style={{ display: 'grid', gap: 'var(--ui-space-8)' }}>
      {readError ? <InlineError message={readError} action={{ label: 'Retry', onAction: () => void refresh() }} /> : null}
      {state ? (
        <section data-mobile-driver-overlay aria-label={title}>
          <div className="terminal-mobile-driver__summary">
            <strong>{title}</strong>
            {phoneFit ? (
              <Button aria-label="Restore this terminal" onClick={() => void restoreFit({ session: sessionId })}>Restore</Button>
            ) : (
              <Button aria-label="Take back this terminal" onClick={() => void takeBack({ session: sessionId })}>Take back</Button>
            )}
          </div>
          <details className="ui-disclosure" open>
            <summary>Phone driving controls</summary>
            <p className="terminal-mobile-driver__description">{description}</p>
            <div className="terminal-mobile-driver__actions">
              {phoneFit ? (
                <Button onClick={() => void restoreFit({})}>Restore all</Button>
              ) : (
                <Button onClick={() => void takeBack({})}>Take back all</Button>
              )}
            </div>
          </details>
        </section>
      ) : null}
    </div>
  )
}
