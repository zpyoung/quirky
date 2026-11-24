import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { runProcessSync } from '@quirky/process-host'
import {
  QUIRKYD_ARTIFACTS,
  QUIRKYD_LINEAR_SDK_ENTRY,
  QUIRKYD_SERVER_ENTRY_FILENAME
} from '../../src/shared/quirkyd-artifacts.ts'
import { stageQuirkydLinearSdk } from './quirkyd-linear-sdk-package.mjs'

const root = join(import.meta.dirname, '..', '..')
// Outside the repo, so Node cannot fall back to the checkout's node_modules.
const deployment = realpathSync(mkdtempSync(join(tmpdir(), 'quirkyd-linear-sdk-')))

beforeAll(async () => {
  await stageQuirkydLinearSdk(root, deployment)
}, 60_000)

afterAll(() => {
  rmSync(deployment, { recursive: true, force: true })
})

it('ships the SDK as a deployment artifact', () => {
  expect(QUIRKYD_ARTIFACTS.map((artifact) => artifact.filename)).toContain(QUIRKYD_LINEAR_SDK_ENTRY)
})

it("resolves linear-sdk.ts's lazy require from the deployed server under plain Node", () => {
  const server = join(deployment, QUIRKYD_SERVER_ENTRY_FILENAME)
  writeFileSync(
    server,
    `const load = require('node:module').createRequire(__filename);
    const sdk = load('@linear/sdk');
    console.log(JSON.stringify({
      resolved: load.resolve('@linear/sdk'),
      client: typeof sdk.LinearClient,
      authError: typeof sdk.AuthenticationLinearError
    }));`
  )
  const loaded = runProcessSync({
    program: process.execPath,
    args: [server],
    cwd: deployment,
    env: { QUIRKY_BACKGROUND_LAUNCH: '1' },
    timeoutMs: 30_000
  })
  expect(loaded.code, loaded.stderr.slice(-2_000)).toBe(0)
  expect(JSON.parse(loaded.stdout.trim())).toEqual({
    resolved: join(deployment, QUIRKYD_LINEAR_SDK_ENTRY),
    client: 'function',
    authError: 'function'
  })
}, 40_000)
