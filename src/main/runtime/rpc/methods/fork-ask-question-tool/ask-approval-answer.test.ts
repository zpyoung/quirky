import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AskEnvelope } from '../../../../../shared/fork-ask-question-tool/ask-answer-envelope'
import type { AskSpec } from '../../../../../shared/fork-ask-question-tool/ask-question-schema'
import type { RpcContext } from '../../core'
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
const PAIRED_DEVICE: RpcCallerIdentity = { kind: 'paired-device', deviceId: 'device-1' }

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

  it.each<[string, RpcCallerIdentity | undefined, RpcContext['clientKind']]>([
    ['no caller identity', undefined, undefined],
    ['the local CLI an agent runs', LOCAL_CLI, undefined],
    ['a CLI paired to the runtime by a pairing code', PAIRED_DEVICE, 'runtime'],
    ['a paired device with no declared client kind', PAIRED_DEVICE, undefined],
    ['a mobile-scoped call with no caller identity', undefined, 'mobile']
  ])('refuses an answer from %s and leaves the ask pending', async (_name, caller, clientKind) => {
    const askId = await registerApproval()

    await expect(
      h.call('ask.answer', { askId, answers: YES, skipped: [] }, { caller, clientKind })
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

  it("accepts the answer from the user's paired phone", async () => {
    const askId = await registerApproval()

    const result = await h.call(
      'ask.answer',
      { askId, answers: YES, skipped: [] },
      { caller: PAIRED_DEVICE, clientKind: 'mobile' }
    )

    expect(result).toEqual({ committed: true })
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
