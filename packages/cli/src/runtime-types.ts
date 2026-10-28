import type {
  InstalledCommandStatus as ProtocolInstalledCommandStatus,
  StoredRuntimeTarget
} from '@quirky/protocol/node'

/** Saved pairing material stays private to QUIRKY_HOME and is never printed by list/status. */
export type SavedRuntimeTarget = StoredRuntimeTarget

/** One-off selection outranks ambient selection; conflicting explicit selectors are refused. */
export type RuntimeSelection =
  | { kind: 'local' }
  | { kind: 'saved'; selector: string }
  | { kind: 'pairing'; pairingCode: string }

export type InstalledCommandStatus = ProtocolInstalledCommandStatus
