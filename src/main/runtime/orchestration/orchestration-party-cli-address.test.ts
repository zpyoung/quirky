import { afterEach, describe, expect, it } from 'vitest'
import { injectedSessionAddress } from '../../../shared/agent-session-caller-env'
import { testQuirkySessionId } from '../../../shared/quirky-session-address-test-fixture'
import {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation
} from '../structured-worker-identity'
import { resolveQuirkySessionParty } from './orchestration-party'

// The CLI spells its own address without the host resolver (it runs before the codec's module
// graph), so it must land on the one mailbox address the resolver gives the same session.
const CHAT = testQuirkySessionId('f7a1c0de-1111-4222-8333-444455556666')
const WORKER = testQuirkySessionId('a0b1c2d3-0000-4000-8000-00000000abcd')

afterEach(() => {
  structuredWorkerIdentities.clear()
})

describe("the CLI's own address", () => {
  it("is a chat's session address, even beside a pane handle it inherited", () => {
    const hostAddress = resolveQuirkySessionParty(CHAT, null).address
    expect(injectedSessionAddress({ QUIRKY_AGENT_SESSION_ID: CHAT })).toBe(hostAddress)
    expect(
      injectedSessionAddress({
        QUIRKY_AGENT_SESSION_ID: CHAT,
        QUIRKY_TERMINAL_HANDLE: 'term_inherited'
      })
    ).toBe(hostAddress)
  })

  it("is a structured worker's minted handle, as the host resolves it", () => {
    const handle = mintStructuredWorkerHandle()
    structuredWorkerIdentities.register({
      handle,
      sessionId: WORKER,
      agent: 'claude',
      paneKey: mintStructuredWorkerPaneKey(WORKER),
      processIncarnation: structuredWorkerProcessIncarnation(WORKER),
      worktreeId: 'wt_1',
      hostScope: { kind: 'local', hostId: 'local' }
    })
    const hostAddress = resolveQuirkySessionParty(WORKER, null).address
    expect(hostAddress).toBe(handle)
    expect(
      injectedSessionAddress({ QUIRKY_AGENT_SESSION_ID: WORKER, QUIRKY_TERMINAL_HANDLE: handle })
    ).toBe(hostAddress)
  })
})
