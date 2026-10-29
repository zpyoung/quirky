import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { NATIVE_BROWSER_LABEL_DOMAIN } from '@quirky/protocol'

/**
 * Electrobun postBuild hook: lets the Native pane load localhost worktree labels over plain http.
 * App Transport Security exempts `localhost` and IP literals but not `<label>.quirky.localhost`,
 * and Electrobun's config can't add Info.plist keys, so the hook merges a scoped exception into
 * every app bundle in the build directory. Other plain-http hosts stay blocked.
 */
export function allowLabelHosts(buildDirectory: string): string[] {
  const plists = readdirSync(buildDirectory)
    .filter((entry) => entry.endsWith('.app'))
    .map((app) => join(buildDirectory, app, 'Contents', 'Info.plist'))
    .filter((plist) => existsSync(plist))
  for (const plist of plists) {
    const current = plutil(['-extract', 'NSAppTransportSecurity', 'json', '-o', '-', plist], true)
    const ats = current ? JSON.parse(current) as Record<string, unknown> : {}
    const exceptions = typeof ats.NSExceptionDomains === 'object' && ats.NSExceptionDomains !== null
      ? ats.NSExceptionDomains as Record<string, unknown>
      : {}
    exceptions[NATIVE_BROWSER_LABEL_DOMAIN] = { NSIncludesSubdomains: true, NSExceptionAllowsInsecureHTTPLoads: true }
    plutil(['-replace', 'NSAppTransportSecurity', '-json', JSON.stringify({ ...ats, NSExceptionDomains: exceptions }), plist])
  }
  return plists
}

function plutil(args: string[], missingIsEmpty = false): string | null {
  const result = spawnSync('plutil', args, { encoding: 'utf8' })
  if (result.status === 0) return result.stdout
  if (missingIsEmpty) return null
  throw new Error(`plutil ${args.join(' ')} failed: ${result.stderr || result.error?.message}`)
}

if (import.meta.main && process.env.ELECTROBUN_OS === 'macos') {
  const buildDirectory = process.env.ELECTROBUN_BUILD_DIR
  if (!buildDirectory) throw new Error('ELECTROBUN_BUILD_DIR is not set')
  const updated = allowLabelHosts(buildDirectory)
  if (updated.length === 0) throw new Error(`no app bundle found in ${buildDirectory}`)
}
