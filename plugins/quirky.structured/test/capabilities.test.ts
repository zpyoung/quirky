import { afterEach, describe, expect, test } from 'bun:test'
import { RpcErrorCode } from '@quirky/protocol'
import { capabilitiesFor } from '../capabilities'
import { bootChat, teardownChat, type ChatBoot } from './chat-harness'

describe('capabilities values', () => {
  test('claude supports everything', () => {
    const claude = capabilitiesFor('claude')!
    expect(claude).toMatchObject({
      agent: 'claude',
      steer: { ok: true },
      model: { ok: true },
      planMode: { ok: true },
      images: { ok: true },
      effort: { ok: true },
      approveForSession: { ok: true },
      resume: { ok: true }
    })
    expect(claude.permissionModes).toMatchObject({ ok: true })
    expect((claude.permissionModes as { modes: string[] }).modes).toContain('plan')
  })

  test('codex has no plan mode or permission modes, and says why', () => {
    const codex = capabilitiesFor('codex')!
    expect(codex.planMode).toEqual({ ok: false, reason: 'Codex runs with on-request approval in Quirky' })
    expect(codex.permissionModes).toEqual({ ok: false, reason: 'Codex runs with on-request approval in Quirky' })
    expect([codex.steer, codex.model, codex.images, codex.effort, codex.approveForSession, codex.resume].every((c) => c.ok)).toBe(true)
  })

  test('pi and omp change model and effort live but lack plan mode, permission modes and session approval', () => {
    for (const agent of ['pi', 'omp'] as const) {
      const found = capabilitiesFor(agent)!
      expect(found.agent).toBe(agent)
      for (const capability of [found.planMode, found.permissionModes, found.approveForSession]) {
        expect(capability.ok).toBe(false)
        expect((capability as { reason: string }).reason).toContain(agent)
      }
      expect([found.steer, found.images, found.resume, found.model, found.effort].every((c) => c.ok)).toBe(true)
    }
    expect((capabilitiesFor('pi')!.planMode as { reason: string }).reason).toBe('pi has no plan mode')
  })

  test('an unknown agent has no capabilities', () => {
    expect(capabilitiesFor('gemini')).toBeNull()
    expect(capabilitiesFor('constructor')).toBeNull()
  })
})

describe('capabilities RPC', () => {
  let chat: ChatBoot
  afterEach(() => teardownChat(chat))

  test('returns the static value for each agent', async () => {
    chat = await bootChat()
    for (const agent of ['claude', 'codex', 'pi', 'omp']) {
      expect(await chat.call('quirky.structured/capabilities', { agent })).toEqual(capabilitiesFor(agent))
    }
  })

  test('an unknown agent fails with invalid-params', async () => {
    chat = await bootChat()
    const error = await chat.failure(chat.call('quirky.structured/capabilities', { agent: 'gemini' }))
    expect(error.code).toBe(RpcErrorCode.InvalidParams)
    expect(error.message).toContain('unknown agent gemini')
  })
})
