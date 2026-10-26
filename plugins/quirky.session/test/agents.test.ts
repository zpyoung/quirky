import { describe, expect, test } from 'bun:test'
import { agentCommand, shellQuote } from '../src/agents'

describe('agent commands', () => {
  test('shellQuote handles quotes and spaces', () => {
    expect(shellQuote("it's a $test")).toBe(`'it'\\''s a $test'`)
  })

  test('each agent gets its documented command', () => {
    expect(agentCommand('claude', undefined, [])).toBe('claude')
    expect(agentCommand('claude', "fix it's bug", [])).toBe(`claude 'fix it'\\''s bug'`)
    expect(agentCommand('codex', 'hi', [])).toBe(`codex 'hi'`)
    expect(agentCommand('opencode', 'hi', [])).toBe(`opencode --prompt 'hi'`)
    expect(agentCommand('opencode', undefined, [])).toBe('opencode')
    expect(agentCommand('gemini', 'hi', [])).toBe(`gemini --prompt-interactive 'hi'`)
    expect(agentCommand('gemini', '   ', [])).toBe('gemini')
  })

  test('extra args sit after the agent name and before the prompt, quoted', () => {
    const extra = ['--model', 'opus']
    expect(agentCommand('claude', 'hi', extra)).toBe(`claude '--model' 'opus' 'hi'`)
    expect(agentCommand('claude', undefined, extra)).toBe(`claude '--model' 'opus'`)
    expect(agentCommand('codex', 'hi', extra)).toBe(`codex '--model' 'opus' 'hi'`)
    expect(agentCommand('opencode', 'hi', extra)).toBe(`opencode '--model' 'opus' --prompt 'hi'`)
    expect(agentCommand('gemini', 'hi', extra)).toBe(`gemini '--model' 'opus' --prompt-interactive 'hi'`)
    expect(agentCommand('claude', undefined, ["it's $x"])).toBe(`claude 'it'\\''s $x'`)
  })
})
