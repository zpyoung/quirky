// R1 gate: the working tree must attach the newest release's terminal daemon, or an
// upgrade strands every live terminal. Rollback crossing is reported, not enforced.
// Usage: node check-daemon-protocol-crossing.mjs [--release-ref <ref>]
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  DAEMON_PROTOCOL_SOURCE_PATH,
  canAttach,
  crossingRequirements,
  parseDaemonProtocolFacts
} from './daemon-protocol-facts.mjs'
import { compareReleaseTags } from './stable-release-tags.mjs'

// Same override the cross-version-wire harness honors, so both pair against one ref.
const RELEASE_REF_ENV = 'QUIRKY_CROSS_VERSION_BASELINE_REF'

// Releases below this come from the pre-fork Quirky line, which has no daemon protocol file.
const MIN_RELEASE_VERSION_TAG = 'v2.0.0'
const RELEASE_TAG = /^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/

/** Newest vX.Y.Z[-pre] tag at or after 2.0.0; stable wins a tie with its own prerelease. */
function selectLatestCrossableReleaseTag(tags) {
  let latest = null
  for (const tag of tags) {
    if (!RELEASE_TAG.test(tag) || compareReleaseTags(tag, MIN_RELEASE_VERSION_TAG) < 0) {
      continue
    }
    const diff = latest === null ? 1 : compareReleaseTags(tag, latest)
    if (diff > 0 || (diff === 0 && !tag.includes('-'))) {
      latest = tag
    }
  }
  return latest
}

function git(repoRoot, args) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024
  }).trim()
}

export function resolveReleaseRef(repoRoot, explicitRef, env = process.env) {
  const override = explicitRef?.trim() || env[RELEASE_REF_ENV]?.trim()
  if (override) {
    return override
  }
  const tags = git(repoRoot, ['tag', '--list', 'v[0-9]*']).split('\n').filter(Boolean)
  return selectLatestCrossableReleaseTag(tags)
}

/**
 * @param {{ release: ReturnType<typeof parseDaemonProtocolFacts>, candidate: ReturnType<typeof parseDaemonProtocolFacts>, releaseRef: string }} input
 */
export function assessDaemonProtocolCrossing({ release, candidate, releaseRef }) {
  const upgrade = canAttach(candidate, release)
  const rollback = canAttach(release, candidate)
  const requirements = crossingRequirements(release)
  const lines = [
    `release ${releaseRef}: daemon protocol ${release.protocolVersion}`,
    `candidate (working tree): daemon protocol ${candidate.protocolVersion}`,
    upgrade
      ? `upgrade ${releaseRef} -> candidate: OK, live terminals are adopted`
      : `upgrade ${releaseRef} -> candidate: FAIL, ${requirements.upgrade}; add ${release.protocolVersion} to PREVIOUS_DAEMON_PROTOCOL_VERSIONS`,
    rollback
      ? `rollback candidate -> ${releaseRef}: OK, live terminals survive (info)`
      : `rollback candidate -> ${releaseRef}: terminals from the candidate's daemon are unreachable until re-upgrade (info, expected after a protocol bump)`
  ]
  return { upgrade, rollback, lines }
}

export function checkDaemonProtocolCrossing({ repoRoot, releaseRef: explicitRef, env }) {
  const releaseRef = resolveReleaseRef(repoRoot, explicitRef, env)
  if (!releaseRef) {
    return {
      skipped: true,
      upgrade: true,
      rollback: true,
      lines: [
        `skipped: no release tag at or after ${MIN_RELEASE_VERSION_TAG} to cross against ` +
          `(pre-fork releases have no ${DAEMON_PROTOCOL_SOURCE_PATH}). ` +
          `Pass --release-ref / ${RELEASE_REF_ENV} to force one.`
      ]
    }
  }
  let releaseSource
  try {
    releaseSource = git(repoRoot, ['show', `${releaseRef}:${DAEMON_PROTOCOL_SOURCE_PATH}`])
  } catch (error) {
    throw new Error(
      `cannot read ${DAEMON_PROTOCOL_SOURCE_PATH} at ${releaseRef}: ${error.stderr?.trim() || String(error)}`
    )
  }
  const release = parseDaemonProtocolFacts(
    releaseSource,
    `${releaseRef}:${DAEMON_PROTOCOL_SOURCE_PATH}`
  )
  const candidate = parseDaemonProtocolFacts(
    readFileSync(join(repoRoot, DAEMON_PROTOCOL_SOURCE_PATH), 'utf8'),
    DAEMON_PROTOCOL_SOURCE_PATH
  )
  return assessDaemonProtocolCrossing({ release, candidate, releaseRef })
}

function parseArgs(argv) {
  const index = argv.indexOf('--release-ref')
  if (index === -1) {
    return {}
  }
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) {
    throw new Error('--release-ref requires a value')
  }
  return { releaseRef: value }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const repoRoot = resolve(import.meta.dirname, '..', '..')
  try {
    const { releaseRef } = parseArgs(process.argv.slice(2))
    const result = checkDaemonProtocolCrossing({ repoRoot, releaseRef })
    for (const line of result.lines) {
      console.log(line)
    }
    if (!result.upgrade) {
      process.exitCode = 1
    }
  } catch (error) {
    console.error(`daemon protocol crossing check failed: ${error.message}`)
    process.exitCode = 1
  }
}
