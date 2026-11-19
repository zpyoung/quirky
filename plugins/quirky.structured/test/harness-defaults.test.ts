import { describe, expect, test } from 'bun:test'
import { harnessDefaults, type HarnessDefaultsDeps } from '../harness-defaults'

const deps = (files: Record<string, string>, over: Partial<HarnessDefaultsDeps> = {}): HarnessDefaultsDeps => ({
  env: {},
  home: '/home/u',
  claudeSettings: async () => ({}),
  readText: (path) => files[path] ?? null,
  ...over
})

describe('harnessDefaults', () => {
  test('claude reads the merged settings for the worktree, with the CLI env overrides on top', async () => {
    const seen: string[] = []
    const claudeSettings = async (cwd: string) => (seen.push(cwd), { model: 'opus', effortLevel: 'high' })
    expect(await harnessDefaults('claude', '/repo', deps({}, { claudeSettings }))).toEqual({ model: 'opus', effort: 'high' })
    expect(seen).toEqual(['/repo'])
    expect(await harnessDefaults('claude', '/repo', deps({}, { claudeSettings, env: { ANTHROPIC_MODEL: 'sonnet', CLAUDE_CODE_EFFORT_LEVEL: 'low' } }))).toEqual({ model: 'sonnet', effort: 'low' })
    expect(await harnessDefaults('claude', '/repo', deps({}, { claudeSettings, env: { CLAUDE_CODE_EFFORT_LEVEL: 'unset' } }))).toEqual({ model: 'opus', effort: null })
  })

  test('codex reads config.toml under CODEX_HOME, and the active profile wins', async () => {
    const top = 'model = "gpt-5.5"\nmodel_reasoning_effort = "medium"\n'
    expect(await harnessDefaults('codex', '/repo', deps({ '/home/u/.codex/config.toml': top }))).toEqual({ model: 'gpt-5.5', effort: 'medium' })
    const profiled = `profile = "deep"\n${top}\n[profiles.deep]\nmodel_reasoning_effort = "xhigh"\n`
    expect(await harnessDefaults('codex', '/repo', deps({ '/c/config.toml': profiled }, { env: { CODEX_HOME: '/c' } }))).toEqual({ model: 'gpt-5.5', effort: 'xhigh' })
  })

  test('pi joins its default provider and model and reads the default thinking level', async () => {
    const settings = JSON.stringify({ defaultProvider: 'openai-codex', defaultModel: 'gpt-5.5', defaultThinkingLevel: 'xhigh' })
    expect(await harnessDefaults('pi', '/repo', deps({ '/home/u/.pi/agent/settings.json': settings }))).toEqual({ model: 'openai-codex/gpt-5.5', effort: 'xhigh' })
  })

  test('omp splits the thinking suffix off its default model role', async () => {
    const config = 'modelRoles:\n  smol: a/b:low\n  default: openai-codex/gpt-6.1-sol:high\n'
    expect(await harnessDefaults('omp', '/repo', deps({ '/home/u/.omp/agent/config.yml': config }))).toEqual({ model: 'openai-codex/gpt-6.1-sol', effort: 'high' })
    const bare = 'defaultThinkingLevel: medium\nmodelRoles:\n  default: anthropic/claude-opus\n'
    expect(await harnessDefaults('omp', '/repo', deps({ '/home/u/.omp/agent/config.yml': bare }))).toEqual({ model: 'anthropic/claude-opus', effort: 'medium' })
  })

  test('missing, malformed or failing settings read as naming nothing', async () => {
    const none = { model: null, effort: null }
    expect(await harnessDefaults('codex', '/repo', deps({}))).toEqual(none)
    expect(await harnessDefaults('pi', '/repo', deps({ '/home/u/.pi/agent/settings.json': '{nope' }))).toEqual(none)
    expect(await harnessDefaults('codex', '/repo', deps({ '/home/u/.codex/config.toml': 'model = [' }))).toEqual(none)
    expect(await harnessDefaults('claude', '/repo', deps({}, { claudeSettings: async () => { throw new Error('boom') } }))).toEqual(none)
  })
})
