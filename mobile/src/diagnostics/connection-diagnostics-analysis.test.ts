import { describe, expect, it } from 'vitest'
import { diagnoseConnection } from './connection-diagnostics-analysis'
import type { ConnectionLogEntry } from '../transport/types'

function event(message: string, detail?: string): ConnectionLogEntry {
  return { id: message, ts: 1, level: 'error', message, detail }
}

describe('diagnoseConnection', () => {
  it('reports the current healthy path instead of a historical failure', () => {
    expect(
      diagnoseConnection({
        endpoint: 'ws://100.88.90.25:6768',
        state: 'connected',
        activePath: 'tailscale',
        entries: [event('WebSocket connect timeout')]
      })
    ).toEqual({
      likelyCause: 'Connection is healthy via Tailscale/direct.',
      nextStep: 'No action needed.'
    })
  })

  it('identifies a Tailscale endpoint timeout', () => {
    expect(
      diagnoseConnection({
        endpoint: 'ws://100.88.90.25:6768',
        state: 'reconnecting',
        activePath: 'tailscale',
        entries: [event('WebSocket connect timeout')]
      })
    ).toEqual({
      likelyCause: 'The saved Tailscale endpoint did not answer before the connection timeout.',
      nextStep: 'Check the local/VPN network and confirm the desktop is awake.'
    })
  })

  it('classifies the newest failure instead of an older persisted one', () => {
    expect(
      diagnoseConnection({
        endpoint: 'ws://192.168.1.2:6768',
        state: 'reconnecting',
        entries: [
          { ...event('Authentication rejected'), id: 'old', ts: 1 },
          { ...event('WebSocket connect timeout'), id: 'new', ts: 2 }
        ]
      }).likelyCause
    ).toBe('The saved direct endpoint did not answer before the connection timeout.')
  })

  it('ignores failures from before the current app resume boundary', () => {
    const diagnosis = diagnoseConnection({
      endpoint: 'ws://192.168.1.2:6768',
      state: 'connecting',
      activePath: 'lan',
      entries: [
        { ...event('Health check failed'), code: 'liveness-timeout', path: 'lan' },
        { ...event('App returned to foreground'), id: 'resume', ts: 2, code: 'app-resumed' },
        { ...event('WebSocket closed'), id: 'closed', ts: 3, code: 'socket-closed' }
      ]
    })
    expect(diagnosis.likelyCause).toMatch(/^Before the app last resumed:/)
  })
})
