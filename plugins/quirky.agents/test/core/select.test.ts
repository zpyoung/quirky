import { describe, expect, test } from 'bun:test'
import { pickAgent } from '../../src/core/select'
import type { AgentEntry } from '../../src/core/types'

function entry(id: string): AgentEntry {
  return {
    id,
    plugin: 'quirky.agents',
    label: id,
    detect: id,
    detectAliases: [],
    detectRequires: [],
    launch: id,
    process: id,
    env: {},
    prompt: 'argv',
    promptSeparator: null,
    draftFlag: null,
    yolo: null,
    auto: null,
    yoloEnv: null,
    stripArgs: [],
    resume: null,
    fork: null,
    resumeStyle: null,
    readySignal: 'render-quiet-after-bracketed-paste',
    submitSignal: 'render-quiet-after-bracketed-paste',
    readyTimeoutMs: 8000,
    blindPaste: true,
    submitRetryMs: null,
    lineSettleMs: null,
    enterWithPaste: false,
    trust: null,
    homepage: null,
    install: null,
    modelDiscovery: null,
    launchOptions: null,
    oneShot: null
  }
}

const ORDER = ['claude', 'codex', 'gemini', 'continue', 'command-code', 'cursor'].map(entry)

function pick(
  preferred: string | null,
  installed: string[],
  over: { disabled?: string[]; forAgentTab?: boolean; entries?: AgentEntry[] } = {}
): string | null {
  return pickAgent({
    entries: over.entries ?? ORDER,
    installed: (id) => installed.includes(id),
    disabled: (id) => (over.disabled ?? []).includes(id),
    preferred,
    forAgentTab: over.forAgentTab ?? false
  })
}

describe('pickAgent', () => {
  test('uses an installed preferred agent', () => {
    expect(pick('codex', ['claude', 'codex'])).toBe('codex')
  })

  test('falls back in catalog order when the preference is absent or stale', () => {
    expect(pick(null, ['cursor', 'codex'])).toBe('codex')
    expect(pick('gemini', ['cursor', 'codex'])).toBe('codex')
    expect(pick(null, ['continue', 'command-code'])).toBe('continue')
  })

  test('SC-8: the table', () => {
    expect(pick('auto', ['codex', 'gemini'])).toBe('codex')
    expect(pick('gemini', ['codex', 'gemini'])).toBe('gemini')
    expect(pick('claude', ['codex', 'gemini'])).toBe('codex')
    expect(pick('shell', ['codex', 'gemini'])).toBe('shell')
    expect(pick('auto', [])).toBe('shell')
    expect(pick('auto', ['codex', 'gemini'], { disabled: ['codex'] })).toBe('gemini')
  })

  test('a disabled preferred or fallback agent is skipped', () => {
    expect(pick('codex', ['claude', 'codex'], { disabled: ['codex'] })).toBe('claude')
    expect(pick(null, ['claude', 'codex'], { disabled: ['claude', 'codex'] })).toBe('shell')
  })

  test('a preferred agent missing from the catalog is not picked', () => {
    expect(pick('ghost', ['ghost', 'gemini'])).toBe('gemini')
  })

  test('the entries order decides, not the installed order', () => {
    const reversed = [...ORDER].reverse()
    expect(pick(null, ['claude', 'cursor'], { entries: reversed })).toBe('cursor')
  })

  test('SC-9: the agent tab auto-picks when the default is shell', () => {
    expect(pick('shell', ['codex'], { forAgentTab: true })).toBe('codex')
  })

  test('SC-9: the agent tab has no fallback to a shell', () => {
    expect(pick('shell', [], { forAgentTab: true })).toBeNull()
    expect(pick('auto', [], { forAgentTab: true })).toBeNull()
    expect(pick('codex', ['claude'], { forAgentTab: true, disabled: ['claude'] })).toBeNull()
  })

  test('the agent tab still honors an installed preferred agent', () => {
    expect(pick('gemini', ['codex', 'gemini'], { forAgentTab: true })).toBe('gemini')
  })
})
