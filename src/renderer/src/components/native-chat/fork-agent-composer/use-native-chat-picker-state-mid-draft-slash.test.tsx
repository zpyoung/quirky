// @vitest-environment happy-dom

import { createRef } from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiscoveredSkill } from '../../../../../shared/skills'
import type { NativeChatPickerState } from '../use-native-chat-picker-state'

const mocks = vi.hoisted(() => ({
  discoveryEnabled: [] as boolean[]
}))

const SKILLS: DiscoveredSkill[] = [
  {
    id: 'browser',
    name: 'browser',
    description: null,
    providers: ['claude'],
    sourceKind: 'repo',
    sourceLabel: 'Repository',
    rootPath: '/repo/.claude/skills',
    directoryPath: '/repo/.claude/skills/browser',
    skillFilePath: '/repo/.claude/skills/browser/SKILL.md',
    installed: true,
    updatedAt: null
  }
]

vi.mock('../use-native-chat-skills', () => ({
  useNativeChatSkills: (_agent: string, _tabId: string, enabled: boolean) => {
    mocks.discoveryEnabled.push(enabled)
    return { status: 'ready', skills: SKILLS, error: null, retry: () => {} }
  }
}))

import { useNativeChatPickerState } from '../use-native-chat-picker-state'

function renderPickerState(draft: string): NativeChatPickerState {
  const captured = createRef<NativeChatPickerState>()
  function Probe(): null {
    captured.current = useNativeChatPickerState({
      agent: 'claude',
      terminalTabId: 'tab-1',
      draftScopeKey: 'pane-1',
      draft,
      caret: draft.length,
      agentCommands: [{ name: 'clear' }, { name: 'compact' }],
      recalledFromHistory: false,
      disabled: false,
      textareaRef: createRef<HTMLTextAreaElement>(),
      setDraft: () => {},
      setCaret: () => {},
      setActiveSuggestion: () => {}
    })
    return null
  }
  render(<Probe />)
  if (!captured.current) {
    throw new Error('picker state was not captured')
  }
  return captured.current
}

describe('useNativeChatPickerState — mid-draft slash', () => {
  beforeEach(() => {
    mocks.discoveryEnabled = []
  })
  afterEach(cleanup)

  it('requests skill discovery for a `/` that does not lead the draft', () => {
    renderPickerState('please run /bro')
    expect(mocks.discoveryEnabled.at(-1)).toBe(true)
  })

  it('opens a skills-only picker mid-draft and keeps commands at the draft start', () => {
    const midDraft = renderPickerState('please run /bro')
    expect(midDraft.autocomplete.mode).toBe('slash')
    if (midDraft.autocomplete.mode !== 'slash') {
      return
    }
    expect(midDraft.autocomplete.items.map((item) => item.kind)).toEqual(['skill'])

    const atStart = renderPickerState('/cl')
    if (atStart.autocomplete.mode !== 'slash') {
      throw new Error('expected slash mode at the draft start')
    }
    expect(atStart.autocomplete.items.map((item) => item.kind)).toEqual(['command'])
  })

  it('leaves discovery idle when no `/` token is open', () => {
    renderPickerState('please run the browser')
    expect(mocks.discoveryEnabled.at(-1)).toBe(false)
  })
})
