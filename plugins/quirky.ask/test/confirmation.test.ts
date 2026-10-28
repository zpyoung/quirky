import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { join } from 'node:path'
import { RpcErrorCode, type AskEnvelope } from '@quirky/protocol'
import { writePlugin } from '../../../packages/daemon/test/plugins/fixtures'
import { askOnlyPluginsDir, cleanupAll, connectAs, errorOf, startAsk } from './support'

afterEach(cleanupAll)

function confirmationOf(error: unknown): { askId: string; action: string } {
  if (!error || typeof error !== 'object' || !('data' in error)) throw new Error('missing confirmation error')
  const data = error.data
  if (!data || typeof data !== 'object' || !('askId' in data) || typeof data.askId !== 'string' ||
    !('action' in data) || typeof data.action !== 'string') throw new Error('missing confirmation identity')
  return { askId: data.askId, action: data.action }
}

async function startWithDestructivePlugin() {
  const builtin = askOnlyPluginsDir()
  writePlugin(
    builtin,
    {
      id: 'quirky.fake',
      name: 'Fake',
      version: '1.0.0',
      main: 'main.ts',
      contributes: {
        method: [
          { id: 'wipe', params: { type: 'object', properties: {} }, destructive: true, confirm: 'Wipe everything?' },
          { id: 'wipeCount', params: { type: 'object', properties: {} }, readOnly: true },
          { id: 'requestWipe', params: { type: 'object', properties: { confirmation: { type: 'string' } } } }
        ]
      }
    },
    { 'main.ts': `
      import type { PluginContext } from '@quirky/protocol'
      export function activate(context: PluginContext) {
        let count = 0
        context.provide('method:quirky.fake/wipe', () => { count++; return { wiped: true } })
        context.provide('method:quirky.fake/wipeCount', () => count)
        context.provide('method:quirky.fake/requestWipe', (params: Record<string, unknown>) => context.call('quirky.fake/wipe', params))
      }
    ` }
  )
  return startAsk(undefined, builtin)
}

describe('quirky.ask as the confirmation backend', () => {
  test('D20: a destructive call opens a confirm ask for the caller and runs once it is answered yes', async () => {
    const h = await startWithDestructivePlugin()
    const caller = await connectAs(h, { sessionId: 'sess_3', worktreeId: 'wt_3' })

    const refused = await errorOf(caller.callAny('quirky.fake/wipe', {}))
    expect(refused?.code).toBe(RpcErrorCode.ConfirmationRequired)
    const { askId, action } = confirmationOf(refused)
    expect(action).toBe('Wipe everything?')

    const [ask] = (await caller.callAny('quirky.ask/list', { pendingOnly: true })) as { id: string; sessionId: string; worktreeId: string; spec: unknown }[]
    expect(ask).toMatchObject({
      id: askId,
      sessionId: 'sess_3',
      worktreeId: 'wt_3',
      spec: { title: 'Confirm', questions: [{ id: 'confirm', type: 'confirm', question: 'Wipe everything?' }] }
    })

    await caller.callAny('quirky.ask/answer', { askId, answers: { confirm: { value: true, source: 'input' } } })
    expect(await caller.callAny('quirky.fake/wipe', { confirmation: askId })).toEqual({ wiped: true })
  })

  test('a plugin-originated call consumes its confirmation without a borrowed client connection', async () => {
    const h = await startWithDestructivePlugin()
    const caller = await connectAs(h)
    const refused = await errorOf(caller.callAny('quirky.fake/requestWipe', {}))
    expect(refused?.code).toBe(RpcErrorCode.ConfirmationRequired)
    const { askId } = confirmationOf(refused)
    expect(await caller.callAny('quirky.fake/wipeCount', {})).toBe(0)
    await caller.callAny('quirky.ask/answer', { askId, answers: { confirm: { value: true, source: 'input' } } })
    expect(await caller.callAny('quirky.fake/requestWipe', { confirmation: askId })).toEqual({ wiped: true })
    const replay = await errorOf(caller.callAny('quirky.fake/requestWipe', { confirmation: askId }))
    expect(replay?.code).toBe(RpcErrorCode.Conflict)
    expect(await caller.callAny('quirky.fake/wipeCount', {})).toBe(1)
  })

  test('a declined confirm ask refuses the call', async () => {
    const h = await startWithDestructivePlugin()
    const caller = await h.connect('cli')
    const refused = await errorOf(caller.callAny('quirky.fake/wipe', {}))
    const { askId } = confirmationOf(refused)
    const envelope = (await caller.callAny('quirky.ask/cancel', { askId })) as AskEnvelope
    expect(envelope.status).toBe('declined')
    const again = await errorOf(caller.callAny('quirky.fake/wipe', { confirmation: askId }))
    expect(again).toMatchObject({ code: RpcErrorCode.Conflict, message: 'declined' })
  })
  test('an unavailable confirmation is a refusal and never runs the destructive method', async () => {
    const h = await startWithDestructivePlugin()
    const caller = await connectAs(h)
    const refused = await errorOf(caller.callAny('quirky.fake/wipe', {}))
    const { askId } = confirmationOf(refused)

    const database = new Database(join(h.home, 'plugin-data', 'quirky.ask', 'store.db'))
    try {
      database.query(`
        UPDATE asks
        SET status = 'unavailable', reason = ?, answers = '{}', skipped = '["confirm"]', summary = ''
        WHERE id = ?
      `).run('exact asker session exited', askId)
    } finally {
      database.close()
    }

    const replay = await errorOf(caller.callAny('quirky.fake/wipe', { confirmation: askId }))
    expect(replay).toMatchObject({
      code: RpcErrorCode.Conflict,
      message: expect.stringContaining('confirmation unavailable: exact asker session exited')
    })
    const unused = await errorOf(caller.callAny('quirky.fake/wipe', { confirmation: askId }))
    expect(unused).toMatchObject({ code: RpcErrorCode.Conflict })
    const envelope = (await caller.callAny('quirky.ask/wait', { askId, timeoutMs: 0 })) as AskEnvelope
    expect(envelope).toMatchObject({ status: 'unavailable', reason: 'exact asker session exited' })
    expect(await caller.callAny('quirky.fake/wipeCount', {})).toBe(0)
  })

  test('an expired confirmation Ask is a refusal and leaves the action unexecuted', async () => {
    const h = await startWithDestructivePlugin()
    const caller = await connectAs(h)
    const refused = await errorOf(caller.callAny('quirky.fake/wipe', {}))
    const { askId } = confirmationOf(refused)
    const database = new Database(join(h.home, 'plugin-data', 'quirky.ask', 'store.db'))
    try {
      database.query('DELETE FROM asks WHERE id = ?').run(askId)
    } finally {
      database.close()
    }
    const replay = await errorOf(caller.callAny('quirky.fake/wipe', { confirmation: askId }))
    expect(replay).toMatchObject({
      code: RpcErrorCode.Conflict,
      message: expect.stringContaining('confirmation unavailable')
    })
    expect(await caller.callAny('quirky.fake/wipeCount', {})).toBe(0)
  })

  test('an unrelated corrupt historical Ask cannot block an exact valid confirmation', async () => {
    const h = await startWithDestructivePlugin()
    const caller = await connectAs(h)
    const history = await caller.callAny('quirky.ask/create', { spec: { questions: [{ id: 'old', type: 'confirm', question: 'Old question?' }] } }) as { askId: string }
    await caller.callAny('quirky.ask/cancel', { askId: history.askId })
    const refused = await errorOf(caller.callAny('quirky.fake/wipe', {}))
    const { askId } = confirmationOf(refused)
    await caller.callAny('quirky.ask/answer', { askId, answers: { confirm: { value: true, source: 'input' } } })
    const database = new Database(join(h.home, 'plugin-data', 'quirky.ask', 'store.db'))
    try {
      database.query('UPDATE asks SET spec = ? WHERE id = ?').run('{invalid-history', history.askId)
    } finally {
      database.close()
    }
    expect(await caller.callAny('quirky.fake/wipe', { confirmation: askId })).toEqual({ wiped: true })
    expect(await caller.callAny('quirky.fake/wipeCount', {})).toBe(1)
  })
})
