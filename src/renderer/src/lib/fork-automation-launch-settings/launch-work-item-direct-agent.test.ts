import { describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({ toast: { message: vi.fn() } }))
vi.mock('@/lib/agent-paste-draft', () => ({ pasteDraftWhenAgentReady: vi.fn() }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, value: string) => value }))

import { buildDirectWorkItemAgentStartupPlan } from '../launch-work-item-direct-agent'

const settings = {
  agentCmdOverrides: {},
  agentDefaultArgs: {},
  agentDefaultEnv: {}
}

describe('direct work-item launch settings', () => {
  it('applies recipe launch options without catalog defaults', () => {
    const result = buildDirectWorkItemAgentStartupPlan({
      agent: 'codex',
      agentArgs: '--verbose',
      launchOptions: { model: 'recipe-model', optionValues: { effort: 'high' } },
      draftContent: 'Review issue 42',
      promptDelivery: 'draft',
      settings,
      launchPlatform: 'darwin'
    })

    expect(result.startupPlan?.launchCommand).toContain("'-m' 'recipe-model'")
    expect(result.startupPlan?.launchCommand).toContain("'-c' 'model_reasoning_effort=high'")
    expect(result.startupPlan?.launchCommand).toContain("'--verbose'")
  })

  it('lets a raw model argument replace the recipe model instead of repeating the flag', () => {
    const result = buildDirectWorkItemAgentStartupPlan({
      agent: 'codex',
      agentArgs: '--model raw-model',
      launchOptions: { model: 'recipe-model', optionValues: { effort: 'high' } },
      draftContent: 'Review issue 42',
      promptDelivery: 'draft',
      settings,
      launchPlatform: 'darwin'
    })

    expect(result.startupPlan?.launchCommand).toContain("'--model' 'raw-model'")
    expect(result.startupPlan?.launchCommand).not.toContain('recipe-model')
  })
})
