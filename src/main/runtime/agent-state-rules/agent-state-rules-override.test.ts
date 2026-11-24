import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getTerminalTailSentinelMatches } from '../terminal-tail-sentinel-index'
import {
  activateAgentStateRules,
  BUNDLED_AGENT_STATE_RULES,
  getActiveAgentStateRules
} from './active-agent-state-rules'
import { BUNDLED_AGENT_STATE_RULES_VERSION } from './agent-state-rules-bundle'
import { BUNDLED_AGENT_STATE_RULE_FILES } from './agent-state-rules-catalog'
import { idleTitleRequiresQuiet } from './agent-state-rules-engine'
import { AgentStateRulesOverride } from './agent-state-rules-override'
import { detectExplicitIdleStatusFromTitle } from '../terminal-wait-detection'
import { showsIdleTitleAnchor } from './agent-state-title-anchors'

function bundledFile(id: string): Record<string, unknown> {
  const file = BUNDLED_AGENT_STATE_RULE_FILES.find((candidate) => candidate.id === id)
  if (!file) {
    throw new Error(`no bundled ${id}`)
  }
  return structuredClone(file)
}

// A Claude file whose title rule settles without quiet: visible through idleTitleRequiresQuiet.
function claudeWithoutQuiet(): Record<string, unknown> {
  const claude = bundledFile('claude')
  return {
    ...claude,
    rules: [
      {
        id: 'idle_title',
        why: 'test',
        priority: 100,
        when: { region: 'title', status: 'idle' },
        answer: { state: 'idle', strength: 'weak', requiresQuiet: false }
      }
    ]
  }
}

function bundleText(version: number, files: unknown[] = [claudeWithoutQuiet()]): string {
  return JSON.stringify({ version, engineVersion: 1, files })
}

let userData: string
let warn: ReturnType<typeof vi.spyOn>
let settings: { agentStateRulesPath?: string | null }
let onActivated: ReturnType<typeof vi.fn<(rules: { version: number; source: string }) => void>>
let override: AgentStateRulesOverride

function status(): { version: number; source: string } {
  const { version, source } = getActiveAgentStateRules()
  return { version, source }
}

function warnings(): string[] {
  return warn.mock.calls.map(([message]) => String(message))
}

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'agent-state-rules-override-'))
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  settings = {}
  onActivated = vi.fn<(rules: { version: number; source: string }) => void>()
  override = new AgentStateRulesOverride({ readSettings: () => settings, onActivated })
})

afterEach(() => {
  override.stop()
  activateAgentStateRules(BUNDLED_AGENT_STATE_RULES)
  warn.mockRestore()
  rmSync(userData, { recursive: true, force: true })
})

describe('agent state rules override', () => {
  it('keeps the bundled rules when no override is set', async () => {
    await override.start()
    expect(status()).toEqual({ version: BUNDLED_AGENT_STATE_RULES_VERSION, source: 'bundled' })
    expect(onActivated).not.toHaveBeenCalled()
  })

  it('activates a local override over the bundled rules and reverts when it is cleared', async () => {
    const overridePath = join(userData, 'override.json')
    writeFileSync(overridePath, bundleText(1, [claudeWithoutQuiet()]))
    settings.agentStateRulesPath = overridePath
    await override.start()
    expect(status()).toMatchObject({ version: 1, source: 'override' })
    expect(idleTitleRequiresQuiet('claude')).toBe(false)
    expect(onActivated).toHaveBeenCalledWith({ version: 1, source: 'override' })

    settings.agentStateRulesPath = null
    await override.start()
    expect(status()).toMatchObject({ source: 'bundled' })
    expect(idleTitleRequiresQuiet('claude')).toBe(true)
  })

  it('lets an override carry an agent outside the bundled set', async () => {
    const overridePath = join(userData, 'override.json')
    writeFileSync(overridePath, bundleText(1, [bundledFile('gemini')]))
    settings.agentStateRulesPath = overridePath
    await override.start()
    expect(status()).toMatchObject({ version: 1, source: 'override' })
  })

  it('reports a rejected override and keeps the bundled rules', async () => {
    const overridePath = join(userData, 'override.json')
    writeFileSync(overridePath, '{"version":1,"engineVersion":1,"files":[{"id":"claude"}]}')
    settings.agentStateRulesPath = overridePath
    await override.start()
    expect(status().source).toBe('bundled')
    expect(warnings()[0]).toContain(`override ${overridePath} rejected`)
    expect(onActivated).not.toHaveBeenCalled()
  })

  it('reports an unreadable override and keeps the bundled rules', async () => {
    const overridePath = join(userData, 'missing.json')
    settings.agentStateRulesPath = overridePath
    await override.start()
    expect(status().source).toBe('bundled')
    expect(warnings()[0]).toContain(`override ${overridePath} unreadable`)
  })

  it('lets no superseded start change the rules after a restart', async () => {
    const overridePath = join(userData, 'override.json')
    writeFileSync(overridePath, bundleText(1, [bundledFile('gemini')]))
    settings.agentStateRulesPath = overridePath
    const superseded = override.start()
    settings.agentStateRulesPath = null
    await override.start()
    await superseded
    expect(status()).toEqual({ version: BUNDLED_AGENT_STATE_RULES_VERSION, source: 'bundled' })
  })
})

describe('agent state rules hot reload', () => {
  it('recompiles the title anchors every pane reads, past the title memo', () => {
    expect(showsIdleTitleAnchor('✳ Claude Code')).toBe(true)
    expect(detectExplicitIdleStatusFromTitle('✳ Claude Code')).toBe('idle')
    activateAgentStateRules({
      ...BUNDLED_AGENT_STATE_RULES,
      files: BUNDLED_AGENT_STATE_RULES.files.map((file) =>
        file.id === 'claude' ? { ...file, anchors: [] } : file
      )
    })
    expect(showsIdleTitleAnchor('✳ Claude Code')).toBe(false)
    expect(detectExplicitIdleStatusFromTitle('✳ Claude Code')).toBeNull()
  })

  it('rescans a tail the sentinel index already covered when a blocked anchor arrives', () => {
    const lines = ['zebra crossing prompt']
    expect(getTerminalTailSentinelMatches(lines)).toEqual([])
    activateAgentStateRules({
      ...BUNDLED_AGENT_STATE_RULES,
      files: BUNDLED_AGENT_STATE_RULES.files.map((file) =>
        file.id === 'claude'
          ? {
              ...file,
              anchors: [
                ...file.anchors,
                {
                  id: 'zebra',
                  why: 'test',
                  when: { region: 'text', find: { lastOf: 'zebra crossing' } },
                  answer: { state: 'blocked', reason: 'agent-approval-prompt' }
                }
              ]
            }
          : file
      )
    })
    expect(getTerminalTailSentinelMatches(lines)).toEqual([0])
  })
})
