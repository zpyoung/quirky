import { existsSync, writeFileSync } from 'node:fs'

const marker = process.env.QUIRKY_VAULT_TEST_WORKER_FAILURE_MARKER
if (marker && existsSync(marker)) {
  // This fixture imports the production handler only after faulting its first instance; a static import would install it in the faulted Worker too.
  const buffered: unknown[] = []
  let productionReady = false
  self.addEventListener('message', (event: MessageEvent<unknown>) => {
    if (productionReady) return
    event.stopImmediatePropagation()
    buffered.push(event.data)
  })
  await import('../../src/worker')
  productionReady = true
  for (const data of buffered) self.dispatchEvent(new MessageEvent('message', { data }))
} else {
  if (marker) writeFileSync(marker, 'fault-first-worker')
  self.addEventListener('message', (event: MessageEvent<{ id: number; op: string }>) => {
    const request = event.data
    if (request.op === 'hold') {
      self.postMessage({
        event: 'scanProgress',
        data: { phase: 'reading', scannedFiles: 0, parsedFiles: 0, current: 'worker-fault-pending' }
      })
      return
    }
    if (request.op === 'crash') {
      setTimeout(() => { throw new Error('controlled Worker fault') }, 0)
    }
  })
}
