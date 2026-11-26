import { createServer, type Server, type Socket } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import { APPROVAL_TIMEOUT_MS } from '../../main/runtime/approvals/approval-gate'
import { PUBLIC_CLI_RUNTIME_CAPABILITY } from '../../shared/public-cli-runtime-capabilities'
import { exitCodeFor } from '../public-cli/exit-codes'
import { RuntimeClient } from './client'

type SeenRequest = Record<string, unknown>

const servers = new Set<Server>()
const sockets = new Set<Socket>()

afterEach(async () => {
  for (const socket of sockets) {
    socket.destroy()
  }
  sockets.clear()
  await Promise.all(
    [...servers].map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  )
  servers.clear()
})

/** A runtime that advertises `capabilities` and answers every other method with an empty result. */
async function startRuntime(capabilities: string[]): Promise<{
  client: RuntimeClient
  requests: SeenRequest[]
}> {
  const userDataPath = mkdtempSync(join(tmpdir(), 'quirky-client-public-'))
  onTestFinished(() => rmSync(userDataPath, { recursive: true, force: true }))
  const endpoint = join(userDataPath, 'runtime.sock')
  const requests: SeenRequest[] = []
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    socket.once('data', (data) => {
      const request = JSON.parse(String(data).trim()) as SeenRequest
      requests.push(request)
      socket.write(
        `${JSON.stringify({
          id: request.id,
          ok: true,
          result: request.method === 'status.get' ? { capabilities } : { done: true },
          _meta: { runtimeId: 'runtime-1' }
        })}\n`
      )
    })
  })
  servers.add(server)
  await new Promise<void>((resolve) => server.listen(endpoint, resolve))
  writeFileSync(
    join(userDataPath, 'quirky-runtime.json'),
    JSON.stringify({
      runtimeId: 'runtime-1',
      pid: 123,
      transports: [{ kind: 'unix', endpoint }],
      authToken: 'token',
      startedAt: 1
    }),
    'utf8'
  )
  return { client: new RuntimeClient(userDataPath, 5_000, null, null, 'quirky'), requests }
}

describe.skipIf(process.platform === 'win32')('public-contract calls', () => {
  it('fails with capability_missing and never sends a call to a runtime without public-cli.v1', async () => {
    const { client, requests } = await startRuntime([])

    const error = await client
      .call(
        'files.delete',
        { worktree: 'w', relativePath: 'important.txt' },
        {
          publicContract: true,
          confirm: false
        }
      )
      .catch((caught: unknown) => caught)

    expect(error).toMatchObject({ code: 'capability_unsupported' })
    expect(exitCodeFor(error)).toBe(6)
    expect(requests.map((request) => request.method)).toEqual(['status.get'])
  })

  it('refuses a public stream on a runtime without public-cli.v1 before opening it', async () => {
    const { client, requests } = await startRuntime([])

    await expect(
      client.stream('events.subscribe', {}, () => {}, { publicContract: true })
    ).rejects.toMatchObject({ code: 'capability_unsupported' })
    expect(requests.map((request) => request.method)).toEqual(['status.get'])
  })

  it('probes capabilities once per connection and then sends the public fields', async () => {
    const { client, requests } = await startRuntime([PUBLIC_CLI_RUNTIME_CAPABILITY])

    await client.call('ui.state', undefined, { publicContract: true })
    await client.call('ui.state', undefined, { publicContract: true, confirm: true })

    expect(requests.map((request) => request.method)).toEqual([
      'status.get',
      'ui.state',
      'ui.state'
    ])
    expect(requests[1]).toMatchObject({ publicContract: 1 })
    expect(requests[2]).toMatchObject({ publicContract: 1, confirm: true })
  })

  it('does not probe for a legacy call', async () => {
    const { client, requests } = await startRuntime([])

    await client.call('ui.state')

    expect(requests.map((request) => request.method)).toEqual(['ui.state'])
  })
})

describe('public-contract request timeout', () => {
  const timeoutFor = (
    client: RuntimeClient,
    method: string,
    options: { publicContract?: true } = {}
  ): number =>
    (
      client as unknown as {
        resolveCallTimeoutMs: (m: string, p: unknown, o: unknown) => number
      }
    ).resolveCallTimeoutMs(method, undefined, options)

  it('covers the server approval window plus margin for a public mutation', () => {
    const client = new RuntimeClient('/unused', 60_000, null, null, 'quirky')

    expect(timeoutFor(client, 'ui.runAction', { publicContract: true })).toBeGreaterThan(
      APPROVAL_TIMEOUT_MS
    )
    expect(timeoutFor(client, 'files.delete', { publicContract: true })).toBeGreaterThan(
      APPROVAL_TIMEOUT_MS
    )
  })

  it('keeps the default timeout for reads and for legacy calls', () => {
    const client = new RuntimeClient('/unused', 60_000, null, null, 'quirky')

    expect(timeoutFor(client, 'ui.state', { publicContract: true })).toBe(60_000)
    expect(timeoutFor(client, 'ui.runAction')).toBe(60_000)
  })
})
