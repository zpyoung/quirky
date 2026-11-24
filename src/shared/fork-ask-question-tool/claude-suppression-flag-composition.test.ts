import { afterEach, describe, expect, it } from 'vitest'
import {
  CLAUDE_ASK_SUPPRESSION_DISALLOWED_TOOLS_FLAG,
  CLAUDE_ASK_SUPPRESSION_DISALLOWED_TOOLS_VALUE,
  CLAUDE_ASK_SUPPRESSION_SYSTEM_PROMPT_FLAG,
  CLAUDE_ASK_SUPPRESSION_SYSTEM_PROMPT_VALUE
} from './claude-suppression-flags'
import {
  appendClaudeSuppressionFlags,
  applyClaudeSuppressionFlagsToResumeCommand
} from './claude-suppression-flag-composition'
import { setLocalClaudeSuppressionVerdictReader } from './claude-suppression-verdict'

afterEach(() => {
  setLocalClaudeSuppressionVerdictReader(null)
})

const FLAGS = [
  CLAUDE_ASK_SUPPRESSION_DISALLOWED_TOOLS_FLAG,
  CLAUDE_ASK_SUPPRESSION_DISALLOWED_TOOLS_VALUE,
  CLAUDE_ASK_SUPPRESSION_SYSTEM_PROMPT_FLAG,
  CLAUDE_ASK_SUPPRESSION_SYSTEM_PROMPT_VALUE
]

// quoteStartupArg quotes every posix token, flags included — not just values.
const disallowedPair = `'${CLAUDE_ASK_SUPPRESSION_DISALLOWED_TOOLS_FLAG}' '${CLAUDE_ASK_SUPPRESSION_DISALLOWED_TOOLS_VALUE}'`
const systemPromptPair = `'${CLAUDE_ASK_SUPPRESSION_SYSTEM_PROMPT_FLAG}' '${CLAUDE_ASK_SUPPRESSION_SYSTEM_PROMPT_VALUE}'`

describe('appendClaudeSuppressionFlags', () => {
  it('appends both flags after the resolved command when neither collides', () => {
    const result = appendClaudeSuppressionFlags({
      agent: 'claude',
      shell: 'posix',
      command: "claude 'fix it'",
      commandWithoutSessionOptions: 'claude',
      claudeSuppressionFlags: FLAGS
    })

    expect(result.command).toBe(`claude 'fix it' ${disallowedPair} ${systemPromptPair}`)
    expect(result.commandWithoutSessionOptions).toBe(`claude ${disallowedPair} ${systemPromptPair}`)
  })

  it('skips only the colliding flag when the override carries one of them', () => {
    const result = appendClaudeSuppressionFlags({
      agent: 'claude',
      shell: 'posix',
      override: 'claude --disallowedTools "Bash"',
      command: 'claude --disallowedTools "Bash"',
      commandWithoutSessionOptions: 'claude --disallowedTools "Bash"',
      claudeSuppressionFlags: FLAGS
    })

    expect(result.command).toBe(`claude --disallowedTools "Bash" ${systemPromptPair}`)
    expect(result.command).not.toContain(CLAUDE_ASK_SUPPRESSION_DISALLOWED_TOOLS_VALUE)
  })

  it('skips both flags when the override already carries both', () => {
    const override = `claude --disallowedTools "Bash" --append-system-prompt "be terse"`
    const result = appendClaudeSuppressionFlags({
      agent: 'claude',
      shell: 'posix',
      override,
      command: override,
      commandWithoutSessionOptions: override,
      claudeSuppressionFlags: FLAGS
    })

    expect(result.command).toBe(override)
    expect(result.commandWithoutSessionOptions).toBe(override)
  })

  it('skips the colliding flag when the override uses `--flag=value` form', () => {
    const result = appendClaudeSuppressionFlags({
      agent: 'claude',
      shell: 'posix',
      override: 'claude --disallowedTools=Bash',
      command: 'claude --disallowedTools=Bash',
      commandWithoutSessionOptions: 'claude --disallowedTools=Bash',
      claudeSuppressionFlags: FLAGS
    })

    expect(result.command).toBe(`claude --disallowedTools=Bash ${systemPromptPair}`)
    expect(result.command).not.toContain(CLAUDE_ASK_SUPPRESSION_DISALLOWED_TOOLS_VALUE)
  })

  it('never touches a non-Claude agent', () => {
    const result = appendClaudeSuppressionFlags({
      agent: 'codex',
      shell: 'posix',
      command: "codex 'fix it'",
      commandWithoutSessionOptions: 'codex',
      claudeSuppressionFlags: FLAGS
    })

    expect(result).toEqual({ command: "codex 'fix it'", commandWithoutSessionOptions: 'codex' })
  })

  it('is byte-identical when claudeSuppressionFlags is absent', () => {
    const result = appendClaudeSuppressionFlags({
      agent: 'claude',
      shell: 'posix',
      command: "claude 'fix it'",
      commandWithoutSessionOptions: 'claude'
    })

    expect(result).toEqual({ command: "claude 'fix it'", commandWithoutSessionOptions: 'claude' })
  })

  it('takes the ambient local verdict when the caller supplies none', () => {
    setLocalClaudeSuppressionVerdictReader(() => FLAGS)

    const result = appendClaudeSuppressionFlags({
      agent: 'claude',
      shell: 'posix',
      command: 'claude',
      commandWithoutSessionOptions: 'claude'
    })

    expect(result.command).toBe(`claude ${disallowedPair} ${systemPromptPair}`)
  })

  it('ignores the ambient local verdict for a remote launch', () => {
    setLocalClaudeSuppressionVerdictReader(() => FLAGS)

    const result = appendClaudeSuppressionFlags({
      agent: 'claude',
      shell: 'posix',
      command: 'claude',
      commandWithoutSessionOptions: 'claude',
      isRemote: true
    })

    expect(result).toEqual({ command: 'claude', commandWithoutSessionOptions: 'claude' })
  })

  it('is byte-identical when claudeSuppressionFlags is null', () => {
    const result = appendClaudeSuppressionFlags({
      agent: 'claude',
      shell: 'posix',
      command: "claude 'fix it'",
      commandWithoutSessionOptions: 'claude',
      claudeSuppressionFlags: null
    })

    expect(result).toEqual({ command: "claude 'fix it'", commandWithoutSessionOptions: 'claude' })
  })
})

describe('applyClaudeSuppressionFlagsToResumeCommand', () => {
  it('does not duplicate flags already baked into the captured command', () => {
    const captured = `claude --resume abc ${disallowedPair} ${systemPromptPair}`
    const result = applyClaudeSuppressionFlagsToResumeCommand({
      agent: 'claude',
      shell: 'posix',
      command: captured,
      claudeSuppressionFlags: FLAGS
    })

    expect(result).toBe(captured)
  })

  it('injects a pair missing from the captured command when the fresh verdict still allows it', () => {
    const captured = `claude --resume abc ${systemPromptPair}`
    const result = applyClaudeSuppressionFlagsToResumeCommand({
      agent: 'claude',
      shell: 'posix',
      command: captured,
      claudeSuppressionFlags: FLAGS
    })

    expect(result).toBe(`${captured} ${disallowedPair}`)
  })

  it("strips exactly Quirky's own token pairs when the fresh verdict drops to null", () => {
    const captured = `claude --resume abc ${disallowedPair} ${systemPromptPair}`
    const result = applyClaudeSuppressionFlagsToResumeCommand({
      agent: 'claude',
      shell: 'posix',
      command: captured,
      claudeSuppressionFlags: null
    })

    expect(result).toBe('claude --resume abc')
  })

  it('leaves a user-authored --disallowedTools with a different value untouched by a strip', () => {
    const captured = `claude --resume abc --disallowedTools "Bash" ${systemPromptPair}`
    const result = applyClaudeSuppressionFlagsToResumeCommand({
      agent: 'claude',
      shell: 'posix',
      command: captured,
      claudeSuppressionFlags: null
    })

    expect(result).toBe('claude --resume abc --disallowedTools "Bash"')
  })

  it("leaves a user's `--flag=value` --disallowedTools untouched by a strip", () => {
    const captured = `claude --resume abc --disallowedTools=Bash ${systemPromptPair}`
    const result = applyClaudeSuppressionFlagsToResumeCommand({
      agent: 'claude',
      shell: 'posix',
      command: captured,
      claudeSuppressionFlags: null
    })

    expect(result).toBe('claude --resume abc --disallowedTools=Bash')
  })

  it('leaves the captured command untouched while the verdict is still pending', () => {
    const captured = `claude --resume abc ${disallowedPair} ${systemPromptPair}`

    // A cold restore runs before the probe lands; stripping here un-suppresses every
    // restored session on every boot.
    expect(
      applyClaudeSuppressionFlagsToResumeCommand({
        agent: 'claude',
        shell: 'posix',
        command: captured
      })
    ).toBe(captured)
  })

  it('strips once the ambient verdict concludes the binary cannot take the flags', () => {
    setLocalClaudeSuppressionVerdictReader(() => null)
    const captured = `claude --resume abc ${disallowedPair} ${systemPromptPair}`

    expect(
      applyClaudeSuppressionFlagsToResumeCommand({
        agent: 'claude',
        shell: 'posix',
        command: captured
      })
    ).toBe('claude --resume abc')
  })

  it('never touches a non-Claude agent, injecting or stripping', () => {
    const captured = 'codex --resume abc'
    expect(
      applyClaudeSuppressionFlagsToResumeCommand({
        agent: 'codex',
        shell: 'posix',
        command: captured,
        claudeSuppressionFlags: FLAGS
      })
    ).toBe(captured)
    expect(
      applyClaudeSuppressionFlagsToResumeCommand({
        agent: 'codex',
        shell: 'posix',
        command: captured,
        claudeSuppressionFlags: null
      })
    ).toBe(captured)
  })
})
