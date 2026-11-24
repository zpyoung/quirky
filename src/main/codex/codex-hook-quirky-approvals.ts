import {
  MANAGED_HOOK_TIMEOUT_SECONDS,
  readHooksJson,
  type HooksConfig
} from '../agent-hooks/installer-utils'
import {
  computeTrustKey,
  getCodexExplicitHomeHookSourcePath,
  readHookTrustEntries,
  type CodexEventLabel,
  type CodexHookTrustState
} from './config-toml-trust'
import {
  CODEX_EVENTS,
  CODEX_EVENT_LABEL,
  computeQuirkyCodexHookHashes,
  getCodexConfigTomlPath,
  getConfigPath,
  getSystemCodexConfigTomlPath
} from './codex-hook-definition'
import { readEveryKnownCodexHookHashes } from './codex-hook-hash-lookup'
import { getSystemCodexHomePath } from './codex-home-paths'
import { readLedgerQuirkyHashes } from './codex-managed-trust-reconciliation'
import {
  getRealHomeHookKeySourcePaths,
  getRealHomeHooksJsonPath
} from './codex-real-home-hooks-json'
import type { CodexHookHashes } from './codex-hook-trust-derivation'

/** One Codex home's hook files, and every path Codex may key its entries by. */
export type CodexHookHome = {
  homePath: string
  hooksJsonPath: string
  tomlPath: string
  keySourcePaths: readonly [string, ...string[]]
}

export function getManagedCodexHookHome(runtimeHomePath: string): CodexHookHome {
  const hooksJsonPath = getConfigPath(runtimeHomePath)
  return {
    homePath: runtimeHomePath,
    hooksJsonPath,
    tomlPath: getCodexConfigTomlPath(runtimeHomePath),
    keySourcePaths: [getCodexExplicitHomeHookSourcePath(hooksJsonPath)]
  }
}

/** A Codex home Quirky edits in place as it does ~/.codex: user hooks and approvals stay put. */
export function getInPlaceCodexHookHome(homePath: string): CodexHookHome {
  const hooksJsonPath = getConfigPath(homePath)
  return {
    homePath,
    hooksJsonPath,
    tomlPath: getCodexConfigTomlPath(homePath),
    keySourcePaths: getRealHomeHookKeySourcePaths(hooksJsonPath)
  }
}

/** ~/.codex, under every spelling Codex may key its entries by. */
export function getRealHomeCodexHookHome(): CodexHookHome {
  return {
    homePath: getSystemCodexHomePath(),
    hooksJsonPath: getRealHomeHooksJsonPath(),
    tomlPath: getSystemCodexConfigTomlPath(),
    keySourcePaths: getRealHomeHookKeySourcePaths()
  }
}

type CodexEventName = (typeof CODEX_EVENTS)[number]
type QuirkyEntrySlot = { groupIndex: number; handlerIndex: number }
type QuirkyEntryApproval = CodexHookTrustState & { key: string; trustedHash: string }

/** Where each event holds Quirky's entry first. */
export function findQuirkyEntrySlots(
  hooks: HooksConfig['hooks'],
  command: string
): Map<CodexEventName, QuirkyEntrySlot> {
  return new Map(
    CODEX_EVENTS.flatMap((eventName) => {
      const definitions = Array.isArray(hooks?.[eventName]) ? hooks[eventName] : []
      const slot = definitions.flatMap((definition, groupIndex) =>
        (definition.hooks ?? []).flatMap((hook, handlerIndex) =>
          hook.command === command ? [{ groupIndex, handlerIndex }] : []
        )
      )[0]
      return slot ? [[eventName, slot] as const] : []
    })
  )
}

/** Per event, the approvals holding a hash at Quirky's entry, one per spelling Codex keys it by. */
export function approvalsAtQuirkyEntries(
  trustStates: ReadonlyMap<string, CodexHookTrustState>,
  slots: ReadonlyMap<CodexEventName, QuirkyEntrySlot>,
  keySourcePaths: readonly string[],
  command: string
): Map<CodexEventLabel, QuirkyEntryApproval[]> {
  return new Map(
    [...slots].map(([eventName, slot]) => {
      const eventLabel = CODEX_EVENT_LABEL[eventName]
      const approvals = keySourcePaths.flatMap((sourcePath) => {
        const key = computeTrustKey({ sourcePath, eventLabel, command, ...slot })
        const state = trustStates.get(key)
        return state?.trustedHash ? [{ ...state, key, trustedHash: state.trustedHash }] : []
      })
      return [eventLabel, approvals]
    })
  )
}

/**
 * Every hash Quirky's entry may carry in `home`: Quirky's own, every answer Codex
 * gave this Quirky, and what main's grant recorded there. Keys are positional, so
 * an approval at Quirky's key holding any other hash is a removed user hook's.
 */
export function readKnownQuirkyHashes(home: CodexHookHome, command: string): CodexHookHashes[] {
  return [
    computeQuirkyCodexHookHashes(command),
    ...readEveryKnownCodexHookHashes(),
    ...readLedgerQuirkyHashes(home.homePath, command, MANAGED_HOOK_TIMEOUT_SECONDS)
  ]
}

/** The one rule for whether an approval's hash is Quirky's. */
export function isKnownQuirkyHash(
  knownQuirkyHashes: readonly CodexHookHashes[],
  eventLabel: CodexEventLabel,
  trustedHash: string | undefined
): boolean {
  return (
    trustedHash !== undefined &&
    knownQuirkyHashes.some((hashes) => hashes[eventLabel] === trustedHash)
  )
}

/** Until Codex answers: Quirky's own hash, overlaid with each event's approval at Quirky's entry holding a known Quirky hash. */
export function readStopgapQuirkyHashes(home: CodexHookHome, command: string): CodexHookHashes {
  let trustStates: ReadonlyMap<string, CodexHookTrustState>
  try {
    trustStates = readHookTrustEntries(home.tomlPath)
  } catch {
    trustStates = new Map()
  }
  return findStopgapQuirkyHashes({
    trustStates,
    hooks: readHooksJson(home.hooksJsonPath)?.hooks,
    keySourcePaths: home.keySourcePaths,
    command,
    knownQuirkyHashes: readKnownQuirkyHashes(home, command)
  })
}

/** `readStopgapQuirkyHashes` over files already read, counting only `knownQuirkyHashes`. */
export function findStopgapQuirkyHashes(found: {
  trustStates: ReadonlyMap<string, CodexHookTrustState>
  hooks: HooksConfig['hooks']
  keySourcePaths: readonly string[]
  command: string
  knownQuirkyHashes: readonly CodexHookHashes[]
}): CodexHookHashes {
  const slots = findQuirkyEntrySlots(found.hooks, found.command)
  const approvals = approvalsAtQuirkyEntries(
    found.trustStates,
    slots,
    found.keySourcePaths,
    found.command
  )
  return {
    ...computeQuirkyCodexHookHashes(found.command),
    ...Object.fromEntries(
      [...approvals].flatMap(([eventLabel, held]) => {
        // Why a known hash also holds for a rewritten copy: Codex hashes content, not position.
        const approval = held.find(({ trustedHash }) =>
          isKnownQuirkyHash(found.knownQuirkyHashes, eventLabel, trustedHash)
        )
        return approval ? [[eventLabel, approval.trustedHash]] : []
      })
    )
  }
}
