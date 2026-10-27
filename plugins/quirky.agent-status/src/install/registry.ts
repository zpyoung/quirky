import type { Installer } from '../types.ts'
import { OTHER_INSTALLERS } from './other-installers.ts'
import { JSON_INSTALLERS } from './other-json.ts'

/**
 * Every hook installer in the order `hooks status` lists them. Claude and claude-agent-teams are
 * absent on purpose: they take their hooks from the per-launch settings file.
 */
export const INSTALLERS: readonly Installer[] = [...JSON_INSTALLERS, ...OTHER_INSTALLERS]

/** The installer for an agent ID, or undefined when the agent has none. */
export function installerFor(agent: string): Installer | undefined {
  return INSTALLERS.find((installer) => installer.agent === agent)
}
