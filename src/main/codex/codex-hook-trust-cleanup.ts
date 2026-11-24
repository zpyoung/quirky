import { MANAGED_HOOK_TIMEOUT_SECONDS, type HookDefinition } from '../agent-hooks/installer-utils'
import {
  codexHookSourcePathsEqual,
  computeTrustKey,
  computeTrustedHash,
  getCodexExplicitHomeHookSourcePath,
  normalizeHookTrustKeyForLookup,
  parseTrustKey,
  readHookTrustEntries,
  removeHookTrustEntries,
  type CodexTrustEntry
} from './config-toml-trust'
import { createCodexHookTrustEntry } from './codex-hook-identity'
import {
  CODEX_MANAGED_EVENT_LABELS,
  getCodexConfigTomlPath,
  getManagedCommand,
  getManagedScriptPath,
  getSystemCodexConfigTomlPath
} from './codex-hook-definition'
import { getQuirkyManagedCodexHomePath } from './codex-home-paths'
import { removeCodexManagedHookTrustEntries } from './codex-managed-trust-reconciliation'
import type { CodexHookHashes } from './codex-hook-trust-derivation'

export function collectManagedTrustEntries(
  sourcePath: string,
  eventName: string,
  definitions: readonly HookDefinition[],
  isManagedCommand: (command: string | undefined) => boolean
): CodexTrustEntry[] {
  const entries: CodexTrustEntry[] = []
  definitions.forEach((definition, groupIndex) => {
    const hooks = Array.isArray(definition.hooks) ? definition.hooks : []
    hooks.forEach((hook, handlerIndex) => {
      if (!isManagedCommand(hook.command)) {
        return
      }
      const entry = createCodexHookTrustEntry(
        sourcePath,
        eventName,
        groupIndex,
        handlerIndex,
        definition,
        hook
      )
      if (entry) {
        entries.push(entry)
      }
    })
  })
  return entries
}

export function removeSelfComputedMatchingTrustEntries(
  configPath: string,
  entries: readonly CodexTrustEntry[]
): void {
  if (entries.length === 0) {
    return
  }

  const existingEntries = readHookTrustEntries(configPath)
  const ownedKeys = entries
    .map((entry) => {
      const key = computeTrustKey(entry)
      return existingEntries.get(key)?.trustedHash === computeTrustedHash(entry) ? key : null
    })
    .filter((key): key is string => key !== null)
  if (ownedKeys.length > 0) {
    removeHookTrustEntries(configPath, ownedKeys)
  }
}

export function removeStaleRuntimeHookTrustEntries(
  tomlPath: string,
  runtimeHooksPath: string,
  expectedEntries: readonly CodexTrustEntry[]
): void {
  const expectedHashes = new Map(
    expectedEntries.map((entry) => [
      normalizeHookTrustKeyForLookup(computeTrustKey(entry)),
      entry.trustedHash ?? computeTrustedHash(entry)
    ])
  )
  const canonicalRuntimeHooksPath = getCodexExplicitHomeHookSourcePath(runtimeHooksPath)
  const staleKeys: string[] = []
  for (const [key, state] of readHookTrustEntries(tomlPath)) {
    const parsed = parseTrustKey(key)
    if (!parsed || !codexHookSourcePathsEqual(parsed.sourcePath, canonicalRuntimeHooksPath)) {
      continue
    }
    const expectedHash = expectedHashes.get(normalizeHookTrustKeyForLookup(key))
    // Why a defined hash: conflicting duplicate tables read as no hash, and an
    // unexpected key must not match that and survive.
    if (expectedHash !== undefined && expectedHash === state.trustedHash) {
      continue
    }
    staleKeys.push(key)
  }
  if (staleKeys.length > 0) {
    removeHookTrustEntries(tomlPath, staleKeys)
  }
}

export function removeSystemManagedHookTrustEntries(
  systemHomePath: string,
  sourcePaths: readonly [string, ...string[]],
  codexHashes: readonly CodexHookHashes[],
  tomlPath: string = getSystemCodexConfigTomlPath()
): void {
  removeCodexManagedHookTrustEntries({
    codexHashes,
    tomlPath,
    runtimeHomePath: systemHomePath,
    sourcePaths,
    command: getManagedCommand(getManagedScriptPath()),
    managedEventLabels: CODEX_MANAGED_EVENT_LABELS,
    timeoutSec: MANAGED_HOOK_TIMEOUT_SECONDS
  })
}

export function removeRuntimeManagedHookTrustEntries(
  configPath: string,
  codexHashes: readonly CodexHookHashes[]
): void {
  try {
    removeCodexManagedHookTrustEntries({
      codexHashes,
      tomlPath: getCodexConfigTomlPath(),
      runtimeHomePath: getQuirkyManagedCodexHomePath(),
      sourcePaths: [configPath],
      command: getManagedCommand(getManagedScriptPath()),
      managedEventLabels: CODEX_MANAGED_EVENT_LABELS,
      timeoutSec: MANAGED_HOOK_TIMEOUT_SECONDS,
      sourceUsesExplicitCodexHome: true
    })
  } catch (error) {
    // Best effort — stale trust is harmless once hooks.json no longer references the hook; log so a programmer error isn't silent.
    console.warn('[codex-hook-service] failed to clean trust entries', error)
  }
}
