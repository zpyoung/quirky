import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AskEnvelope } from '../../../../../shared/fork-ask-question-tool/ask-answer-envelope'
import type { AskSpec } from '../../../../../shared/fork-ask-question-tool/ask-question-schema'
import type { RpcCallerIdentity } from '../../rpc-caller-identity'
import { createAskRpcHarness, type AskRpcHarness } from './ask-rpc-test-harness'

const APPROVAL_SPEC: AskSpec = {
  questions: [
    {
      id: 'approve',
      type: 'confirm',
      header: 'Approval needed',
      question: 'Script wants to: delete the workspace',
      required: true,
      default: false
    }
  ]
}
const YES = { approve: { value: true, source: 'input' } }

const LOCAL_CLI: RpcCallerIdentity = { kind: 'local-cli' }
const DESKTOP: RpcCallerIdentity = { kind: 'desktop' }

describe('ask.answer for an approval prompt', () => {
  const harness = createAskRpcHarness()
  let h: AskRpcHarness

  beforeEach(() => {
    h = harness.setup()
  })
  afterEach(() => harness.cleanup())

  async function registerApproval(): Promise<string> {
    const { askId } = await h.registry.register(
      APPROVAL_SPEC,
      { paneKey: null, worktreeId: null },
      { requestId: 'approval-workspace-delete-3f1c' }
    )
    return askId
  }

  it.each([
    ['no caller identity', undefined],
    ['the local CLI an agent runs', LOCAL_CLI]
  ])('refuses an answer from %s and leaves the ask pending', async (_name, caller) => {
    const askId = await registerApproval()

    await expect(
      h.call('ask.answer', { askId, answers: YES, skipped: [] }, { caller })
    ).rejects.toMatchObject({ code: 'unauthorized', reason: 'approval_requires_user' })

    expect(h.askDb.getAsk(askId)?.status).toBe('registered')
  })

  it('accepts the answer from the desktop app, so the user can approve', async () => {
    const askId = await registerApproval()
    const wait = h.call('ask.wait', { askId, chunkMs: 5000 })

    const result = await h.call(
      'ask.answer',
      { askId, answers: YES, skipped: [] },
      { caller: DESKTOP }
    )

    expect(result).toEqual({ committed: true })
    expect(await wait).toMatchObject({ status: 'answered', askId } satisfies Partial<AskEnvelope>)
  })

  it('still lets any caller answer an ordinary ask', async () => {
    const { askId } = await h.registry.register(
      { questions: [{ id: 'q1', type: 'text', question: 'Name?' }] },
      { paneKey: null, worktreeId: null },
      { requestId: 'req_plain' }
    )

    const result = await h.call(
      'ask.answer',
      { askId, answers: { q1: { value: 'Ada', source: 'input' } }, skipped: [] },
      { caller: LOCAL_CLI }
    )

    expect(result).toEqual({ committed: true })
  })
})
