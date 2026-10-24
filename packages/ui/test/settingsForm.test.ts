import { expect, test } from 'bun:test'
import { toSettingsPatch, SCROLLBACK_MAX, SCROLLBACK_MIN } from '../src/lib/settingsForm'

const ok = { worktreesRoot: ' ~/wt ', terminalScrollback: '2000', notifications: true }

test('builds a patch from a valid draft', () => {
  expect(toSettingsPatch(ok)).toEqual({
    ok: true,
    patch: { worktreesRoot: '~/wt', terminalScrollback: 2000, notifications: true }
  })
})

test('rejects an empty worktrees root', () => {
  expect(toSettingsPatch({ ...ok, worktreesRoot: '  ' }).ok).toBe(false)
})

test('enforces the scrollback bounds and integers', () => {
  expect(toSettingsPatch({ ...ok, terminalScrollback: String(SCROLLBACK_MIN - 1) }).ok).toBe(false)
  expect(toSettingsPatch({ ...ok, terminalScrollback: String(SCROLLBACK_MAX + 1) }).ok).toBe(false)
  expect(toSettingsPatch({ ...ok, terminalScrollback: '1000.5' }).ok).toBe(false)
  expect(toSettingsPatch({ ...ok, terminalScrollback: 'abc' }).ok).toBe(false)
  expect(toSettingsPatch({ ...ok, terminalScrollback: String(SCROLLBACK_MIN) }).ok).toBe(true)
  expect(toSettingsPatch({ ...ok, terminalScrollback: String(SCROLLBACK_MAX) }).ok).toBe(true)
})
