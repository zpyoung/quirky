import { afterEach, describe, expect, it, vi } from 'vitest'
import { openCodexAppServerConnection } from './codex-app-server-connection'
import { QUIRKY_AGENT_SESSION_SPAWN_TOKEN_ENV } from '../../shared/agent-session-caller-env'
import { sealStructuredSessionChild } from '../runtime/structured-session-child-env'
import { createCodexStructuredLaunchResolver } from '../runtime/structured-agent-launch-composition.test-support'
import { agentSessionRecordFixture } from '../native-chat/agent-session-record-test-fixture'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation
} from '../runtime/structured-worker-identity'

const DEV_CLI_BIN_FIRST = /^[^:;]*[\\/]cli[\\/]bin[:;]/
const DEV_CLI_BIN_DIR = /^[^:;]*[\\/]cli[\\/]bin$/
// The dev launcher by absolute path: a login shell's profile cannot reorder it behind a global.
const DEV_CLI_LAUNCHER = /^[^:;]*[\\/]cli[\\/]bin[\\/]quirky-dev$/

/** The sealed env a Codex launch of `sessionId` spawns with, over a shell env of `env`. */
async function codexChildEnv(
  env: Record<string, string>,
  sessionId: string
): Promise<Record<string, string>> {
  const record = agentSessionRecordFixture({
    sessionId,
    provider: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: '/pinned/home' }
  })
  const launch = await createCodexStructuredLaunchResolver({
    store: { getRecord: () => record, pinLaunchDirectory: vi.fn() },
    resolveEnvironment: async () => env,
    resolveCommand: () => 'codex',
    resolveLaunchArgs: () => []
  })({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a launch reads only the session id of its identity here.
    identity: { sessionId } as AgentSessionJournalIdentity,
    spawnToken: 'spawn-token'
  })
  return launch.env
}

function sealed(sessionId: string): Record<string, string> {
  return sealStructuredSessionChild({
    sessionId,
    spawnToken: 'spawn-token',
    env: {},
    inheritedEnvToDelete: []
  }).env
}

describe('the Codex child environment', () => {
  it('keeps shell exports while pinned launch values win', async () => {
    expect(
      await codexChildEnv(
        {
          EXAMPLE_GATEWAY_TOKEN: 'shell-exported',
          CODEX_HOME: '/shell/home',
          QUIRKY_CLI_BIN_DIR: '/inherited/unowned-cli'
        },
        'session-not-a-worker'
      )
    ).toEqual({
      EXAMPLE_GATEWAY_TOKEN: 'shell-exported',
      CODEX_HOME: '/pinned/home',
      [QUIRKY_AGENT_SESSION_SPAWN_TOKEN_ENV]: 'spawn-token',
      QUIRKY_AGENT_SESSION_ID: 'session-not-a-worker',
      QUIRKY_OUTPUT: 'json',
      QUIRKY_STRUCTURED_SESSION: '1',
      QUIRKY_CLI_COMMAND: expect.stringMatching(DEV_CLI_LAUNCHER),
      ...(process.platform !== 'win32'
        ? { QUIRKY_CLI_BIN_DIR: expect.stringMatching(DEV_CLI_BIN_DIR) }
        : {}),
      QUIRKY_USER_DATA_PATH: expect.any(String),
      QUIRKY_ENVIRONMENT: '',
      QUIRKY_PAIRING_CODE: '',
      QUIRKY_REMOTE_PAIRING: '',
      // The test host is unpackaged, so this app's CLI is the dev launcher dir, first on PATH.
      PATH: expect.stringMatching(DEV_CLI_BIN_FIRST)
    })
  })

  it('names every session by its id, and adds the handle only for a registered worker', () => {
    const sessionId = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
    expect(sealed(sessionId)).toEqual({
      [QUIRKY_AGENT_SESSION_SPAWN_TOKEN_ENV]: 'spawn-token',
      // Not a worker, so no handle: the id alone names this chat as a caller.
      QUIRKY_AGENT_SESSION_ID: sessionId,
      QUIRKY_OUTPUT: 'json',
      QUIRKY_STRUCTURED_SESSION: '1',
      QUIRKY_CLI_COMMAND: expect.stringMatching(DEV_CLI_LAUNCHER),
      ...(process.platform !== 'win32'
        ? { QUIRKY_CLI_BIN_DIR: expect.stringMatching(DEV_CLI_BIN_DIR) }
        : {}),
      QUIRKY_USER_DATA_PATH: expect.any(String),
      QUIRKY_ENVIRONMENT: '',
      QUIRKY_PAIRING_CODE: '',
      QUIRKY_REMOTE_PAIRING: '',
      PATH: expect.stringMatching(DEV_CLI_BIN_FIRST)
    })

    const handle = mintStructuredWorkerHandle()
    structuredWorkerIdentities.register({
      handle,
      sessionId,
      agent: 'codex',
      paneKey: mintStructuredWorkerPaneKey(sessionId),
      processIncarnation: structuredWorkerProcessIncarnation(sessionId),
      worktreeId: 'wt_1',
      hostScope: { kind: 'local', hostId: 'local' }
    })
    try {
      const env = sealed(sessionId)
      expect(env.QUIRKY_TERMINAL_HANDLE).toBe(handle)
      expect(env.QUIRKY_AGENT_SESSION_ID).toBe(sessionId)
      expect(env.QUIRKY_CLI_COMMAND).toMatch(DEV_CLI_LAUNCHER)
      // A pane key here would leak into hook-emitted agent statuses, which assume a PTY leaf.
      expect(env.QUIRKY_PANE_KEY).toBeUndefined()
    } finally {
      structuredWorkerIdentities.forget(handle)
    }
  })
})

/** A real child speaking Codex's JSONL framing, answering with the environment it was spawned with. */
const ENV_REPORTING_APP_SERVER = String.raw`
  const readline = require('node:readline')
  const send = (payload) => process.stdout.write(JSON.stringify(payload) + '\n')
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const message = JSON.parse(line)
    if (message.method === 'initialize') return send({ id: message.id, result: {} })
    if (message.method === 'test/env') {
      return send({
        id: message.id,
        result: {
          sessionId: process.env.QUIRKY_AGENT_SESSION_ID ?? null,
          cliCommand: process.env.QUIRKY_CLI_COMMAND ?? null,
          selectors: [
            process.env.QUIRKY_ENVIRONMENT,
            process.env.QUIRKY_PAIRING_CODE,
            process.env.QUIRKY_REMOTE_PAIRING
          ],
          cliBinDir: process.env.QUIRKY_CLI_BIN_DIR ?? null,
          path: process.env.PATH ?? process.env.Path ?? null
        }
      })
    }
  })
`

describe('the spawned Codex child', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("runs with its own session id and this app's CLI, over an id inherited by Quirky itself", async () => {
    // The builder's output is an overlay on process.env, so only the spawned child proves the id
    // survives the merge — an Quirky launched inside another session inherits that session's id.
    vi.stubEnv('QUIRKY_AGENT_SESSION_ID', 'a0b1c2d3-0000-4000-8000-00000000abcd')
    // A server whose own env carries a profile's selectors must not hand them to its agents.
    vi.stubEnv('QUIRKY_ENVIRONMENT', 'stale-shell-selection')
    vi.stubEnv('QUIRKY_PAIRING_CODE', 'stale-pairing')
    vi.stubEnv('QUIRKY_REMOTE_PAIRING', 'stale-remote-pairing')
    const sessionId = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
    const env = sealed(sessionId)
    const connection = await openCodexAppServerConnection({
      command: process.execPath,
      args: ['-e', ENV_REPORTING_APP_SERVER],
      env
    })
    try {
      await expect(connection.request('test/env')).resolves.toEqual({
        sessionId,
        cliCommand: expect.stringMatching(DEV_CLI_LAUNCHER),
        selectors: ['', '', ''],
        cliBinDir: process.platform === 'win32' ? null : expect.stringMatching(DEV_CLI_BIN_DIR),
        path: expect.stringMatching(DEV_CLI_BIN_FIRST)
      })
    } finally {
      await connection.close()
    }
  })
})
