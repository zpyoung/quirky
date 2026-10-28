import { existsSync, watch } from 'node:fs'
import { dirname } from 'node:path'

const gatePath = process.env.QUIRKY_VAULT_RETIREMENT_GATE
const workerId = crypto.randomUUID()
const closeRequestIds: number[] = []
let calls = 0
let closing = false

function post(value: unknown): void {
  self.postMessage(value)
}

function waitForGate(): Promise<void> {
  if (!gatePath || existsSync(gatePath)) return Promise.resolve()
  const { promise, resolve } = Promise.withResolvers<void>()
  const watcher = watch(dirname(gatePath), () => {
    if (!existsSync(gatePath)) return
    watcher.close()
    resolve()
  })
  return promise
}

function replyToRecord(request: { id: number; args: Record<string, unknown> }): void {
  calls += 1
  post({ id: request.id, result: { workerId, calls, value: request.args.value } })
}

self.addEventListener('message', (event: MessageEvent<{ id: number; op: string; args: Record<string, unknown> }>) => {
  const request = event.data
  if (request.op === 'close') {
    closeRequestIds.push(request.id)
    if (closing) return
    closing = true
    const gate = waitForGate()
    post({ event: 'scanProgress', data: { phase: 'complete', scannedFiles: 0, parsedFiles: 0, current: 'close-started' } })
    void gate.then(() => {
      for (const id of closeRequestIds) post({ id, result: { closed: true } })
      self.close()
    })
    return
  }
  if (closing) return
  if (request.op === 'record') replyToRecord(request)
})
