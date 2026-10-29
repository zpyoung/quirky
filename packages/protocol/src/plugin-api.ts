/** Stable plugin-author API release; independent of app, wire-protocol and plugin package versions. */
export const PLUGIN_API_VERSION = '1.1.0'

const STABLE_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/

type Version = [number, number, number]

function parseVersion(value: unknown): Version | null {
  if (typeof value !== 'string') return null
  const match = STABLE_VERSION.exec(value)
  // `$` also matches before a final newline in JavaScript; require the whole string.
  if (!match || match[0] !== value) return null
  const parts: Version = [Number(match[1]), Number(match[2]), Number(match[3])]
  return parts.every(Number.isSafeInteger) ? parts : null
}

/**
 * Null when `target` is a canonical stable API floor supported by this executing host.
 * Other majors and newer floors fail closed. Optional `hostVersion` supports explicit
 * release comparisons; daemon, CLI and UI loaders use their own default host release.
 */
export function pluginApiCompatibilityError(target: unknown, hostVersion: string = PLUGIN_API_VERSION): string | null {
  const required = parseVersion(target)
  if (!required) return "field 'apiVersion' must be a stable major.minor.patch version with safe integer components"
  const host = parseVersion(hostVersion)
  if (!host) return `host plugin API version '${hostVersion}' is not a stable major.minor.patch version`
  if (required[0] !== host[0] || required[1] > host[1] || (required[1] === host[1] && required[2] > host[2])) {
    return `apiVersion '${target}' is not supported by host plugin API '${hostVersion}'`
  }
  return null
}
