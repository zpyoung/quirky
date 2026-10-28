import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type ScriptedTurn = { prompt: string; response: string }
export type ScriptedConversation = { providerSessionId: string; model?: string; effort?: string; turns: ScriptedTurn[] }

type RecordValue = Record<string, unknown>

function record(value: unknown): RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as RecordValue : {}
}

export function scriptedConversationPath(home: string, providerSessionId: string): string {
  const id = createHash('sha256').update(providerSessionId).digest('hex')
  return join(home, 'owner-fakes', 'conversations', `${id}.json`)
}

export function readScriptedConversation(path: string): ScriptedConversation {
  const saved = record(JSON.parse(readFileSync(path, 'utf8')) as unknown)
  if (
    typeof saved.providerSessionId !== 'string' ||
    !Array.isArray(saved.turns) ||
    (saved.model !== undefined && typeof saved.model !== 'string') ||
    (saved.effort !== undefined && typeof saved.effort !== 'string')
  ) throw new Error(`invalid scripted conversation file: ${path}`)
  const turns: ScriptedTurn[] = saved.turns.map((value, index) => {
    const turn = record(value)
    if (typeof turn.prompt !== 'string' || typeof turn.response !== 'string') {
      throw new Error(`invalid scripted conversation turn ${index}: ${path}`)
    }
    return { prompt: turn.prompt, response: turn.response }
  })
  return {
    providerSessionId: saved.providerSessionId,
    ...(typeof saved.model === 'string' ? { model: saved.model } : {}),
    ...(typeof saved.effort === 'string' ? { effort: saved.effort } : {}),
    turns
  }
}

export function writeScriptedConversation(path: string, conversation: ScriptedConversation): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(temporary, JSON.stringify(conversation), { mode: 0o600 })
  renameSync(temporary, path)
}
