import { afterEach, expect, test } from 'bun:test'
import type { DashboardSnapshot } from '../../src/dashboard-types'
import { cliJson, newSession, startStatusE2E, type StatusE2E } from './support'

let e2e: StatusE2E | undefined

afterEach(async () => {
  await e2e?.cleanup()
  e2e = undefined
})

test('the public dashboard CLI returns the filtered Activity snapshot and rejects invalid filters', async () => {
  e2e = await startStatusE2E({ fakes: { claude: true } })
  const session = await newSession(e2e, 'claude')
  const idle = await cliJson<{ id: string }>(e2e, ['session', 'new', '--agent', 'claude', '--name', 'acceptance-idle'])
  await e2e.shim('claude', session.id, { hook_event_name: 'UserPromptSubmit', prompt: 'dashboard acceptance probe' })
  await e2e.shim('claude', session.id, { hook_event_name: 'Stop', last_assistant_message: 'Dashboard complete' })
  await e2e.shim('claude', idle.id, { hook_event_name: 'SessionStart', source: 'startup' })

  const result = await e2e.cli(['agent-status', 'dashboard', '--text', 'acceptance', '--json'])
  expect(result.code).toBe(0)
  const snapshot = JSON.parse(result.stdout) as DashboardSnapshot
  expect(snapshot).toMatchObject({ total: 2, hiddenIdle: 1 })
  expect(snapshot.cards).toHaveLength(1)
  expect(snapshot.cards[0]).toMatchObject({ bucket: 'done', thread: { sessionId: session.id, display: 'done' } })

  const revealed = await cliJson<DashboardSnapshot>(e2e, ['agent-status', 'dashboard', '--text', 'acceptance', '--show-idle'])
  expect(revealed).toMatchObject({ total: 2, hiddenIdle: 0 })
  expect(revealed.cards.map(({ bucket }) => bucket)).toEqual(['done', 'idle'])


  const invalid = await e2e.cli(['agent-status', 'dashboard', '--workspace-status', 'doing', '--json'])
  expect(invalid.code).not.toBe(0)
  expect(`${invalid.stdout}\n${invalid.stderr}`).toContain('workspace-status')
}, 20_000)
