import { describe, expect, it } from 'vitest'
import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import { structuredAgentRuntimeRegistration } from '../runtime/structured-agent-runtime-registrations'

const local: AgentSessionExecutionLocation = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'folder-1',
  workspaceKind: 'folder'
}

describe('Pi execution host support', () => {
  it('refuses another execution host and WSL without probing local process identity', () => {
    const registration = structuredAgentRuntimeRegistration('pi')
    expect(registration?.supportsLocation({ ...local, executionHostId: 'runtime:remote' })).toBe(
      false
    )
    expect(registration?.supportsLocation({ ...local, wslDistro: 'Ubuntu' })).toBe(false)
  })
})
