import { afterEach, expect, test } from 'bun:test'
import { chmodSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Session } from '@quirky/protocol'
import type { PublicListResult } from '../src/types'
import { VaultRig } from './support/harness'

let rig: VaultRig | undefined

afterEach(async () => {
  await rig?.cleanup()
  rig = undefined
})

test('live-pane, worktree and folder jumps follow the exact resumed provider identity', async () => {
  const vault = rig = await VaultRig.start()
  const listing = await vault.call<PublicListResult>('list', { agents: ['claude'], unlimited: true })
  const source = listing.sessions[0]
  if (!source?.source.filePath || !source.cwd) throw new Error('Claude fixture lacks its real transcript or working directory')
  const registeredPath = realpathSync(source.cwd)

  const repo = await vault.client.callAny('quirky.repo/add', { path: source.cwd, folder: true }) as { id: string }
  const worktrees = await vault.client.callAny('quirky.worktree/list', { repo: repo.id }) as {
    id: string
    path: string
    isMain: boolean
    kind: string
  }[]
  const workspace = worktrees.find((worktree) => worktree.isMain)
  if (!workspace) throw new Error('registered folder project has no primary workspace')
  expect(workspace).toMatchObject({ path: registeredPath, kind: 'folder', isMain: true })

  const providerPath = join(vault.home, 'absolute-jump-provider')
  const providerLog = join(vault.home, 'jump-provider-output.log')
  const providerScript = [
    '#!/bin/sh',
    'echo "cwd=$PWD" >> "$VAULT_CAPTURE_LOG"',
    'for arg do echo "arg=$arg" >> "$VAULT_CAPTURE_LOG"; done'
  ].join(String.fromCharCode(10)) + String.fromCharCode(10)
  writeFileSync(providerPath, providerScript, { mode: 0o700 })
  chmodSync(providerPath, 0o700)
  await vault.client.callAny('quirky.agents/configure', {
    agent: 'claude',
    command: `'${providerPath}'`,
    args: "--vault-parity 'literal provider argument'",
    env: { VAULT_CAPTURE_LOG: providerLog }
  })

  const resumed = await vault.call<Session>('resume', { id: source.id, worktree: workspace.id })
  expect(resumed).toMatchObject({
    agent: source.agent,
    cwd: source.cwd,
    worktreeId: workspace.id,
    providerSession: { id: source.sessionId, transcriptPath: source.source.filePath }
  })

  for (const target of ['pane', 'worktree', 'folder'] as const) {
    const jumped = await vault.call<{ available: boolean; reason?: string; workspace?: string }>('jump', {
      id: source.id,
      target
    })
    expect(jumped).toMatchObject({ available: true, workspace: expect.any(String) })
    expect(jumped.reason).toBeUndefined()
  }
})
