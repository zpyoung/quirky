export type ProviderEnvironmentPatch = Record<string, string | null>

/** Applies provider environment patches without stringifying null removals. */
export function materializeProviderEnvironment(
  base: Record<string, string | undefined>,
  patches: readonly ProviderEnvironmentPatch[]
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(base)) {
    if (value !== undefined) env[name] = value
  }
  for (const patch of patches) {
    for (const [name, value] of Object.entries(patch)) {
      if (value === null) delete env[name]
      else env[name] = value
    }
  }
  return env
}
