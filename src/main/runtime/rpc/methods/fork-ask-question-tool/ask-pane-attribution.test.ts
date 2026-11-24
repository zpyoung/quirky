import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveAskAttribution } from './ask-pane-attribution'
import { createAskRpcHarness, HANDOFF_PANE_KEY, type AskRpcHarness } from './ask-rpc-test-harness'

const VALID_PANE_KEY = 'tab_a:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

describe('resolveAskAttribution (C3)', () => {
  const harness = createAskRpcHarness()
  let h: AskRpcHarness

  beforeEach(() => {
    h = harness.setup()
  })
  afterEach(() => harness.cleanup())

  it('rule 1: a valid paneKey that resolves to a live pane owns the ask', async () => {
    h.setPaneOwner(VALID_PANE_KEY, 'term_1')
    const result = await resolveAskAttribution({ paneKey: VALID_PANE_KEY }, h.runtime)
    expect(result.paneKey).toBe(VALID_PANE_KEY)
    expect(result.dispatchLookupHandle).toBe('term_1')
  })

  it('rejects a syntactically invalid paneKey and falls through', async () => {
    const result = await resolveAskAttribution({ paneKey: 'not-a-pane-key' }, h.runtime)
    expect(result.paneKey).toBeNull()
  })

  it('never trusts a paneKey that does not resolve to a live pane', async () => {
    // Why: the server never trusts an env claim without validating it (tech.md C3) — an
    // unproven QUIRKY_PANE_KEY must not silently win over resolution.
    const result = await resolveAskAttribution({ paneKey: VALID_PANE_KEY }, h.runtime)
    expect(result.paneKey).toBeNull()
  })

  it('rule 2: falls back to terminalHandle -> pane when paneKey does not resolve', async () => {
    h.setPaneOwner(HANDOFF_PANE_KEY, 'term_2')
    const result = await resolveAskAttribution({ terminalHandle: 'term_2' }, h.runtime)
    expect(result.paneKey).toBe(HANDOFF_PANE_KEY)
    expect(result.dispatchLookupHandle).toBe('term_2')
  })

  it('rule 3: a known worktreeId is workspace-scoped with no owning pane', async () => {
    h.setKnownWorktree('wt_1')
    const result = await resolveAskAttribution({ worktreeId: 'wt_1' }, h.runtime)
    expect(result.paneKey).toBeNull()
    expect(result.worktreeId).toBe('wt_1')
    expect(result.anyIdentityClaimed).toBe(true)
  })

  it('rule 3: a known workspaceId is accepted as a worktree-equivalent scope', async () => {
    h.setKnownWorktree('ws_1')
    const result = await resolveAskAttribution({ workspaceId: 'ws_1' }, h.runtime)
    expect(result.worktreeId).toBe('ws_1')
  })

  // the server never trusts a worktreeId/workspaceId env claim without validating it against
  // the runtime's actual known worktrees — an unrecognised id must not attribute the ask to it.
  it('F4: an unknown worktreeId is not trusted and falls through to the no-UI path', async () => {
    const result = await resolveAskAttribution({ worktreeId: 'wt_does_not_exist' }, h.runtime)
    expect(result.paneKey).toBeNull()
    expect(result.worktreeId).toBeNull()
    expect(result.anyIdentityClaimed).toBe(true)
  })

  it('rule 4: nothing claimed resolves to no attribution at all', async () => {
    const result = await resolveAskAttribution({}, h.runtime)
    expect(result.paneKey).toBeNull()
    expect(result.worktreeId).toBeNull()
    expect(result.dispatchLookupHandle).toBe('')
    expect(result.anyIdentityClaimed).toBe(false)
  })

  it('a terminalHandle that resolves no pane still carries through for the no-UI dispatch lookup', async () => {
    h.setKnownWorktree('wt_2')
    const result = await resolveAskAttribution(
      { terminalHandle: 'term_headless', worktreeId: 'wt_2' },
      h.runtime
    )
    expect(result.paneKey).toBeNull()
    expect(result.dispatchLookupHandle).toBe('term_headless')
  })
})
