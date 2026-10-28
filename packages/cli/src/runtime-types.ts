/** Saved pairing material stays private to QUIRKY_HOME and is never printed by list/status. */
export type SavedRuntimeTarget = {
  id: string
  name: string
  pairingCode: string
  createdAt: number
  lastUsedAt: number | null
}

/** One-off selection outranks ambient selection; conflicting explicit selectors are refused. */
export type RuntimeSelection =
  | { kind: 'local' }
  | { kind: 'saved'; selector: string }
  | { kind: 'pairing'; pairingCode: string }

export type InstalledCommandStatus = {
  path: string
  target: string | null
  state: 'missing' | 'managed' | 'foreign'
  profileHome: string
}
