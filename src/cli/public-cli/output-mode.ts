import { QUIRKY_OUTPUT_ENV } from '../../shared/agent-session-caller-env'

export type OutputMode = 'json' | 'text'

/** JSON when the caller asked with `--json` or an agent's environment sets `QUIRKY_OUTPUT=json`. */
export function resolveOutputMode(
  flags: ReadonlyMap<string, string | boolean>,
  env: Readonly<Record<string, string | undefined>>
): OutputMode {
  return flags.has('json') || env[QUIRKY_OUTPUT_ENV] === 'json' ? 'json' : 'text'
}
