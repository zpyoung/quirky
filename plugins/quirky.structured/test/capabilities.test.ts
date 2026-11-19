import { afterEach, describe, expect, test } from 'bun:test'
import { RpcErrorCode } from '@quirky/protocol'
import { capabilitiesFor, startingPermissionMode } from '../capabilities'
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
    expect(claude.permissionModes).toEqual({
      ok: true,
      modes: ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'],
      labels: { default: 'Default', acceptEdits: 'Accept edits', plan: 'Plan', auto: 'Auto', dontAsk: "Don't ask", bypassPermissions: 'Bypass permissions' },
      dangerous: ['bypassPermissions']
    })
  })

  test("codex offers its /permissions presets but no plan mode", () => {
    const codex = capabilitiesFor('codex')!
    expect(codex.planMode).toEqual({ ok: false, reason: 'Codex has no plan mode in Quirky' })
    expect(codex.permissionModes).toEqual({
      ok: true,
      modes: ['default', 'read-only', 'auto-review', 'full-access'],
      labels: { default: 'Default', 'read-only': 'Read only', 'auto-review': 'Auto-review', 'full-access': 'Full access' },
      dangerous: ['full-access']
    })
    expect([codex.steer, codex.model, codex.images, codex.effort, codex.approveForSession, codex.resume].every((c) => c.ok)).toBe(true)
  })

  test('omp offers its approval modes; pi has none', () => {
    expect(capabilitiesFor('omp')!.permissionModes).toEqual({
      ok: true,
      modes: ['always-ask', 'always-ask-cached', 'write', 'yolo'],
      labels: { 'always-ask': 'Always ask', 'always-ask-cached': 'Ask and remember', write: 'Write', yolo: 'Yolo' },
      dangerous: ['yolo']
    })
    expect(capabilitiesFor('pi')!.permissionModes).toEqual({ ok: false, reason: 'pi has no permission modes; it runs tools without asking unless an extension asks' })
  })

  test('every dangerous mode and label names an offered mode', () => {
    for (const agent of ['claude', 'codex', 'pi', 'omp']) {
      const modes = capabilitiesFor(agent)!.permissionModes
      if (!modes.ok) continue
      for (const name of [...(modes.dangerous ?? []), ...Object.keys(modes.labels ?? {})]) expect(modes.modes).toContain(name)
    }
  })

  test('pi and omp change model and effort live but lack plan mode and session approval', () => {
    for (const agent of ['pi', 'omp'] as const) {
      const found = capabilitiesFor(agent)!
      expect(found.agent).toBe(agent)
      for (const capability of [found.planMode, found.approveForSession]) {
        expect(capability.ok).toBe(false)
        expect((capability as { reason: string }).reason).toContain(agent)
      }
      expect([found.steer, found.images, found.resume, found.model, found.effort].every((c) => c.ok)).toBe(true)
    }
    expect((capabilitiesFor('pi')!.planMode as { reason: string }).reason).toBe('pi has no plan mode')
  })

  test('fork is ok for claude and codex and unsupported, with a reason, for pi and omp', () => {
    expect(capabilitiesFor('claude')!.fork).toEqual({ ok: true })
    expect(capabilitiesFor('codex')!.fork).toEqual({ ok: true })
    expect(capabilitiesFor('pi')!.fork).toEqual({ ok: false, reason: "pi can't fork from Quirky yet" })
    expect(capabilitiesFor('omp')!.fork).toEqual({ ok: false, reason: "omp can't fork from Quirky yet" })
  })

  test('every agent advertises a fork capability', () => {
    for (const agent of ['claude', 'codex', 'pi', 'omp']) {
      const fork = capabilitiesFor(agent)!.fork
      expect(typeof fork.ok).toBe('boolean')
      if (!fork.ok) expect(fork.reason.length).toBeGreaterThan(0)
    }
  })

  test('an unknown agent has no capabilities', () => {
    expect(capabilitiesFor('gemini')).toBeNull()
    expect(capabilitiesFor('constructor')).toBeNull()
  })
})

describe('starting permission mode', () => {
  test('an offered pick wins over the terminal preset', () => {
    expect(startingPermissionMode('claude', 'acceptEdits', 'yolo')).toBe('acceptEdits')
    expect(startingPermissionMode('codex', 'read-only', 'auto')).toBe('read-only')
  })

  test("without a pick, the terminal preset picks the matching chat mode", () => {
    expect(startingPermissionMode('claude', undefined, 'manual')).toBe('default')
    expect(startingPermissionMode('claude', undefined, 'auto')).toBe('auto')
    expect(startingPermissionMode('claude', undefined, 'yolo')).toBe('bypassPermissions')
    expect(startingPermissionMode('codex', undefined, 'auto')).toBe('auto-review')
    expect(startingPermissionMode('codex', undefined, 'yolo')).toBe('full-access')
  })

  test('a custom, missing or unmatched preset falls back to the first mode', () => {
    expect(startingPermissionMode('claude', undefined, 'custom')).toBe('default')
    expect(startingPermissionMode('codex', undefined, null)).toBe('default')
    expect(startingPermissionMode('omp', undefined, 'yolo')).toBe('always-ask')
    expect(startingPermissionMode('claude', 'nonsense', undefined)).toBe('default')
  })

  test('an agent without permission modes has no starting mode', () => {
    expect(startingPermissionMode('pi', 'default', 'yolo')).toBeUndefined()
    expect(startingPermissionMode('gemini', undefined, undefined)).toBeUndefined()
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
