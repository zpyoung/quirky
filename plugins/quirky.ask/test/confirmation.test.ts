import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { join } from 'node:path'
import { RpcErrorCode, type AskEnvelope } from '@quirky/protocol'
import { writePlugin } from '../../../packages/daemon/test/plugins/fixtures'
import { askOnlyPluginsDir, cleanupAll, connectAs, errorOf, startAsk } from './support'

afterEach(cleanupAll)

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
        method: [{ id: 'wipe', params: { type: 'object', properties: {} }, destructive: true, confirm: 'Wipe everything?' }]
      }
    },
    { 'main.ts': "export function activate(context: any) { context.provide('method:quirky.fake/wipe', () => ({ wiped: true })) }\n" }
  )
  return startAsk(undefined, builtin)
}

describe('quirky.ask as the confirmation backend', () => {
  test('D20: a destructive call opens a confirm ask for the caller and runs once it is answered yes', async () => {
    const h = await startWithDestructivePlugin()
    const caller = await connectAs(h, { sessionId: 'sess_3', worktreeId: 'wt_3' })

    const refused = await errorOf(caller.callAny('quirky.fake/wipe', {}))
    expect(refused?.code).toBe(RpcErrorCode.ConfirmationRequired)
    const { askId, action } = (refused as unknown as { data: { askId: string; action: string } }).data
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

  test('a declined confirm ask refuses the call', async () => {
    const h = await startWithDestructivePlugin()
    const caller = await h.connect('cli')
    const refused = await errorOf(caller.callAny('quirky.fake/wipe', {}))
    const { askId } = (refused as unknown as { data: { askId: string } }).data
    const envelope = (await caller.callAny('quirky.ask/cancel', { askId })) as AskEnvelope
    expect(envelope.status).toBe('declined')
    const again = await errorOf(caller.callAny('quirky.fake/wipe', { confirmation: askId }))
    expect(again).toMatchObject({ code: RpcErrorCode.Conflict, message: 'declined' })
  })
  test('an unavailable confirmation is a refusal and never runs the destructive method', async () => {
    const h = await startWithDestructivePlugin()
    const caller = await connectAs(h)
    const refused = await errorOf(caller.callAny('quirky.fake/wipe', {}))
    const { askId } = (refused as unknown as { data: { askId: string } }).data

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
  })
})
