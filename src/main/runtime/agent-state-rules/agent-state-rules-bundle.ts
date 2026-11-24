import { z } from 'zod'
import release from './agent-state-rules-release.json'
import { parseAgentStateRuleFiles } from './agent-state-rules-catalog'
import {
  AGENT_STATE_RULES_ENGINE_VERSION,
  type AgentStateRulesFile
} from './agent-state-rules-schema'

/** The `agent-state-rules.json` override format: a versioned set of per-agent rule files. */

// Why a cap: the file is parsed on the main thread.
export const AGENT_STATE_RULES_BUNDLE_MAX_BYTES = 256 * 1024

/** The version of the rules this build ships. */
export const BUNDLED_AGENT_STATE_RULES_VERSION: number = release.version

// Why the engine is checked here, before the files: a newer engine's files fail the file schema
// for a reason that is not theirs.
const BundleEnvelopeSchema = z
  .object({
    version: z.number().int().positive(),
    engineVersion: z.literal(AGENT_STATE_RULES_ENGINE_VERSION),
    files: z.array(z.unknown())
  })
  .strict()

export type AgentStateRulesBundle = {
  version: number
  files: readonly AgentStateRulesFile[]
}

export type AgentStateRulesBundleParse =
  | { ok: true; bundle: AgentStateRulesBundle }
  | { ok: false; error: string }

/** Validates a bundle whole: a file that fails any check is rejected, never partly applied. */
export function parseAgentStateRulesBundle(text: string): AgentStateRulesBundleParse {
  if (Buffer.byteLength(text, 'utf8') > AGENT_STATE_RULES_BUNDLE_MAX_BYTES) {
    return { ok: false, error: `larger than ${AGENT_STATE_RULES_BUNDLE_MAX_BYTES} bytes` }
  }
  try {
    const { version, files } = BundleEnvelopeSchema.parse(JSON.parse(text))
    const parsed = parseAgentStateRuleFiles(files)
    return { ok: true, bundle: { version, files: parsed } }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
