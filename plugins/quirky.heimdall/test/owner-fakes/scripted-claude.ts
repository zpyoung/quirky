import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { readScriptedConversation, scriptedConversationPath, writeScriptedConversation, type ScriptedConversation } from './scripted-conversation-store'

type RecordValue = Record<string, unknown>

function record(value: unknown): RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as RecordValue : {}
}

function send(value: RecordValue): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

const providerSessionId = process.argv[2]
const model = process.argv[3] || undefined
const effort = process.argv[4] || undefined
const home = process.env.QUIRKY_HOME
if (!providerSessionId || !home || process.env.HOME !== home || process.env.NODE_ENV !== 'test') {
  throw new Error('scripted Claude requires an isolated test home and provider session ID')
}

const conversationPath = scriptedConversationPath(home, providerSessionId)
const conversation: ScriptedConversation = existsSync(conversationPath)
  ? readScriptedConversation(conversationPath)
  : { providerSessionId, turns: [] }
if (conversation.providerSessionId !== providerSessionId) throw new Error('scripted provider session identity changed')
if (model !== undefined && conversation.model !== undefined && conversation.model !== model) {
  throw new Error('scripted provider model changed across resume')
}
if (effort !== undefined && conversation.effort !== undefined && conversation.effort !== effort) {
  throw new Error('scripted provider effort changed across resume')
}
if (model !== undefined) conversation.model = model
if (effort !== undefined) conversation.effort = effort
if (model !== undefined || effort !== undefined) writeScriptedConversation(conversationPath, conversation)
send({
  type: 'ready',
  providerSessionId,
  turns: conversation.turns.length,
  model: conversation.model ?? null,
  effort: conversation.effort ?? null
})

const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
for await (const line of input) {
  let request: RecordValue
  try {
    request = record(JSON.parse(line) as unknown)
  } catch {
    send({ type: 'error', providerSessionId, message: 'request was not valid JSON' })
    continue
  }

  if (request.type === 'stop') {
    send({ type: 'stopped', providerSessionId, turns: conversation.turns.length })
    break
  }
  if (request.type !== 'turn' || typeof request.text !== 'string') {
    send({ type: 'error', providerSessionId, message: 'request must be a turn or stop' })
    continue
  }

  const turnNumber = conversation.turns.length + 1
  const response = `Scripted Claude completed turn ${turnNumber}`
  conversation.turns.push({ prompt: request.text, response })
  writeScriptedConversation(conversationPath, conversation)
  send({ type: 'ack', providerSessionId, turn: turnNumber, response })
}
process.stdin.pause()
