// The tag families published as GitHub releases of this repo. Every release-triggered workflow and
// every script that lists releases classifies tags through this file, so a new family is excluded
// or admitted in one place; release-tag-pattern-census.test.mjs enforces that.

const NUMBER = '(?:0|[1-9][0-9]*)'
const VERSION = `${NUMBER}\\.${NUMBER}\\.${NUMBER}`

/** The stable desktop tag as a bash `[[ =~ ]]` pattern, for workflows that gate inline. */
export const DESKTOP_STABLE_TAG_SHELL_PATTERN =
  '^v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$'

export const DESKTOP_STABLE_TAG = new RegExp(DESKTOP_STABLE_TAG_SHELL_PATTERN)
export const DESKTOP_RC_TAG = new RegExp(`^v${VERSION}-rc\\.${NUMBER}(?:\\.[0-9A-Za-z]+)?$`)
export const MOBILE_TAG = new RegExp(`^mobile(?:-android)?-v${VERSION}$`)
