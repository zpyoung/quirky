import { expect, it } from 'vitest'
import type { TuiAgent } from '../../../shared/tui-agent'
import { buildNewTabAgentMenuRows } from './new-tab-agent-menu-rows'
const disabledTuiAgents: TuiAgent[] = ['pi']
const input = {
  settings: { experimentalNativeChat: true, disabledTuiAgents },
  detectedOnHost: ['claude', 'gemini'] as const,
  chatAgents: ['claude', 'codex', 'pi'] as const,
  hostChatAnswer: () => 'yes' as const
}
it('orders enabled chats, unavailable providers and CLI rows', () => {
  expect(buildNewTabAgentMenuRows(input)).toEqual([
    { kind: 'chat', agent: 'claude' },
    { kind: 'chat-unavailable', agent: 'codex', reason: 'not-installed' },
    { kind: 'cli', agent: 'gemini' }
  ])
})
it.each([true, false])(
  'lists an agent with a chat definition whether or not it is installed: %s',
  (installed) => {
    expect(
      buildNewTabAgentMenuRows({
        ...input,
        detectedOnHost: installed ? ['opencode'] : [],
        chatAgents: ['opencode']
      })
    ).toEqual(
      installed
        ? [{ kind: 'chat', agent: 'opencode' }]
        : [{ kind: 'chat-unavailable', agent: 'opencode', reason: 'not-installed' }]
    )
  }
)

it('starts installed chat agents, disables uninstalled ones and gives agents without a chat definition no chat row', () => {
  expect(
    buildNewTabAgentMenuRows({
      ...input,
      detectedOnHost: ['claude', 'gemini'],
      chatAgents: ['claude', 'opencode']
    })
  ).toEqual([
    { kind: 'chat', agent: 'claude' },
    { kind: 'chat-unavailable', agent: 'opencode', reason: 'not-installed' },
    { kind: 'cli', agent: 'gemini' }
  ])
})

it('hides a chat agent the owner switched off', () => {
  expect(
    buildNewTabAgentMenuRows({
      ...input,
      settings: { ...input.settings, nativeChatProviders: { opencode: false } },
      detectedOnHost: ['opencode'],
      chatAgents: ['opencode']
    })
  ).toEqual([{ kind: 'cli', agent: 'opencode' }])
})
