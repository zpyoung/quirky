import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HostedSession, PublicListResult } from '../src/types'
import { VaultRig } from './support/harness'

let rig: VaultRig | undefined

afterEach(async () => {
  await rig?.cleanup()
  rig = undefined
})

const start = async () => (rig = await VaultRig.start())

const claudeSession = async (vault: VaultRig): Promise<HostedSession> => {
  const list = await vault.call<PublicListResult>('list', { agents: ['claude'], unlimited: true })
  const session = list.sessions[0]
  if (!session) throw new Error('Claude fixture was not discovered')
  return session
}

describe('vault session actions', () => {
  test('inspection returns on-demand first prompt and parent-owned subagents', async () => {
    const vault = await start()
    const session = await claudeSession(vault)
    const fetched = await vault.call<HostedSession | null>('get', { id: session.id })
    const prompt = await vault.call<{ prompt: string | null }>('firstPrompt', { id: session.id })

    const subagents = await vault.call<HostedSession[]>('subagents', { id: session.id })
    expect(fetched).toMatchObject({ id: session.id, sourceId: session.sourceId, hostId: 'local', agent: 'claude' })
    expect(prompt.prompt).toEqual(expect.any(String))
    expect(subagents).toEqual([])
  })

  test('open and reveal actions use the terminal public API with the selected source path', async () => {
    const vault = await start()
    const session = await claudeSession(vault)
    const log = join(vault.home, 'open-external.jsonl')
    const previousLog = process.env.QUIRKY_TEST_OPEN_LOG
    process.env.QUIRKY_TEST_OPEN_LOG = log
    try {
      expect(await vault.call('openSource', { id: session.id, mode: 'view' })).toMatchObject({ ok: true })
      expect(await vault.call('openWorkingDirectory', { id: session.id })).toMatchObject({ ok: true })
      const calls = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { target: string; reveal: boolean })
      expect(calls).toEqual([
        expect.objectContaining({ target: session.source.filePath, reveal: false }),
        expect.objectContaining({ target: session.cwd, reveal: false })
      ])
    } finally {
      if (previousLog === undefined) delete process.env.QUIRKY_TEST_OPEN_LOG
      else process.env.QUIRKY_TEST_OPEN_LOG = previousLog
    }
  })

  test('optional handoff and live-pane integrations report unavailable instead of simulating an action', async () => {
    const vault = await start()
    const session = await claudeSession(vault)

    expect(await vault.call<{ available: boolean; reason: string }>('handoff', { id: session.id })).toMatchObject({ available: false, reason: expect.any(String) })
    expect(await vault.call<{ available: boolean; reason: string }>('jump', { id: session.id, target: 'pane' })).toMatchObject({ available: false, reason: expect.any(String) })
  })

  test('unsupported source deletion refuses without changing the original file', async () => {
    const vault = await start()
    const list = await vault.call<PublicListResult>('list', { agents: ['codex'], unlimited: true })
    const session = list.sessions[0]
    if (!session?.source.filePath) throw new Error('Codex source fixture was not discovered')
    const filePath = session.source.filePath

    await expect(vault.call('deleteSession', { id: session.id, yes: true })).rejects.toThrow(/unsupported|cannot delete/i)
    expect(existsSync(filePath)).toBe(true)
  })

  test('supported local deletion moves only the selected temporary transcript to macOS Trash', async () => {
    if (process.platform !== 'darwin') return
    const vault = await start()
    const session = await claudeSession(vault)
    const sourcePath = session.source.filePath
    if (!sourcePath) throw new Error('Claude source fixture path was redacted')
    expect(existsSync(sourcePath)).toBe(true)

    const result = await vault.call<{ deleted: boolean; hostId: string }>('deleteSession', { id: session.id, yes: true })

    expect(result).toMatchObject({ deleted: true, hostId: 'local' })
    expect(existsSync(sourcePath)).toBe(false)
    expect(existsSync(vault.sourceHome)).toBe(true)
  })
})
