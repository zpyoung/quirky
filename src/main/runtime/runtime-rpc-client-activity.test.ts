import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { QuirkyRuntimeService } from './quirky-runtime'
import { QuirkyRuntimeRpcServer } from './runtime-rpc'
import { readRuntimeMetadata } from './runtime-metadata'
import { sendRequest } from './runtime-rpc-test-harness'

describe('QuirkyRuntimeRpcServer client activity', () => {
  it('records each request so an idle host restarts its quiet period', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'quirky-runtime-rpc-activity-'))
    const server = new QuirkyRuntimeRpcServer({ runtime: new QuirkyRuntimeService(), userDataPath })
    await server.start()
    try {
      const before = server.readClientActivity()
      expect(before).toMatchObject({ openConnections: 0, requestsInFlight: 0 })

      const metadata = readRuntimeMetadata(userDataPath)
      await new Promise((resolve) => setTimeout(resolve, 5))
      await sendRequest(metadata!.transports[0]!.endpoint, {
        id: 'req_status',
        authToken: metadata!.authToken,
        method: 'status.get'
      })

      const after = server.readClientActivity()
      expect(after.requestsInFlight).toBe(0)
      expect(after.lastRequestAt).toBeGreaterThan(before.lastRequestAt)
    } finally {
      await server.stop()
    }
  })
})
