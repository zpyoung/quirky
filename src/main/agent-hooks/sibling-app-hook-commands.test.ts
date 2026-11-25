import { describe, expect, it } from 'vitest'
import { createManagedCommandMatcher } from './installer-utils'

// Verbatim shapes Orca Dev writes into ~/.claude/settings.json and ~/.codex/hooks.json.
const ORCA_DEV_CODEX_COMMAND =
  ': orca-agent-hook-form=1; if [ -n "${ORCA_PANE_KEY-}" ] && [ -n "${ORCA_AGENT_HOOK_ROOT-}" ] && [ -f "${ORCA_AGENT_HOOK_ROOT-}/agent-hooks/codex-hook.sh" ]; then /bin/sh "${ORCA_AGENT_HOOK_ROOT-}/agent-hooks/codex-hook.sh" || :; elif [ -z "${ORCA_AGENT_HOOK_ROOT-}" ] && [ -n "${ORCA_PANE_KEY-}" ] && [ -n "${ORCA_AGENT_HOOK_PORT-}" ] && [ -f "${HOME-}/.orca/agent-hooks/codex-hook.sh" ]; then /bin/sh "${HOME-}/.orca/agent-hooks/codex-hook.sh" || :; else { command -p cat 2>/dev/null || cat; } >/dev/null 2>&1 || :; fi'
const ORCA_DEV_CLAUDE_COMMAND =
  'if [ -n "${HOME-}" ] && [ -f "${HOME-}/.orca/agent-hooks/claude-hook.sh" ]; then /bin/sh "${HOME-}/.orca/agent-hooks/claude-hook.sh"; fi'

describe('managed hook sweep beside Orca Dev', () => {
  it('leaves hook entries Orca Dev installed in shared agent config alone', () => {
    expect(createManagedCommandMatcher('codex-hook.sh')(ORCA_DEV_CODEX_COMMAND)).toBe(false)
    expect(createManagedCommandMatcher('claude-hook.sh')(ORCA_DEV_CLAUDE_COMMAND)).toBe(false)
    expect(
      createManagedCommandMatcher('claude-hook.sh')(
        '/bin/sh "/Users/alice/Library/Application Support/orca-dev/agent-hooks/claude-hook.sh"'
      )
    ).toBe(false)
  })

  it('still sweeps the same command shape when it points at Quirky', () => {
    expect(
      createManagedCommandMatcher('codex-hook.sh')(
        ORCA_DEV_CODEX_COMMAND.replaceAll('ORCA_', 'QUIRKY_')
          .replaceAll('orca-agent', 'quirky-agent')
          .replaceAll('/.orca/', '/.quirky/')
      )
    ).toBe(true)
    expect(
      createManagedCommandMatcher('claude-hook.sh')(
        ORCA_DEV_CLAUDE_COMMAND.replaceAll('/.orca/', '/.quirky/')
      )
    ).toBe(true)
  })
})
