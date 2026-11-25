const SIBLING_APP_HOOK_COMMAND =
  /\/\.orca\/agent-hooks\/|\/orca(?:-dev)?\/agent-hooks\/|ORCA_AGENT_HOOK_ROOT|orca-agent-hook-form|orca-agent-hook\.exe/i

/**
 * Whether a hook command was installed by Orca Dev, which runs beside Quirky and writes the same
 * agent config files. Quirky's sweep of stale managed entries must leave these alone.
 * Expects backslashes already normalized to forward slashes.
 */
export function isSiblingAppHookCommand(normalizedCommand: string): boolean {
  return SIBLING_APP_HOOK_COMMAND.test(normalizedCommand)
}
