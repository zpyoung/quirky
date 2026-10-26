/** File at the root of a distro directory. */
export const DISTRO_MANIFEST_FILE = 'quirky-distro.json'

/** The parsed contents of a `quirky-distro.json`. */
export type DistroManifest = {
  /** Plugin-ID syntax. */
  id: string
  name: string
  version: string
  description?: string
  /** Relative directories of the plugins the distro bundles. */
  plugins?: string[]
  /** Plugin or contribution IDs to turn off. */
  disable?: string[]
  /** Setting ID to the value the distro layers under the user's own. */
  settings?: Record<string, boolean | number | string>
  /** A theme contribution ID. */
  theme?: string
  /** Chord to command ID. */
  keybindings?: Record<string, string>
}

/** An installed distro as listed by `distro.list`. */
export type DistroInfo = {
  id: string
  name: string
  version: string
  description?: string
  /** IDs of the plugins it installed. */
  plugins: string[]
  installedAt: number
}

/** What installing a plugin would add, read without running its code. */
export type PluginInspection = {
  id: string
  name: string
  version: string
  description?: string
  contributions: { kind: string; id: string; data: Record<string, unknown> }[]
  overrides: { id: string; replaces: string }[]
  disables: string[]
  /** Present when the plugin is already installed. */
  installed?: { version: string; added: string[]; removed: string[] }
}

/** What installing a distro would change. */
export type DistroInspection = {
  manifest: DistroManifest
  plugins: PluginInspection[]
  settings: { id: string; current: unknown; next: unknown }[]
}
