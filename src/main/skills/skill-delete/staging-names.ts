/**
 * Every skill transaction stages a path as a hidden sibling before touching it,
 * and those siblings land directly in a scanned discovery root. Discovery must
 * not surface them, or a skill mid-transaction shows up as a second row (and,
 * for delete, as a row the user can delete again).
 *
 * The four conventions in the tree today:
 *   `.<name>.quirky-skill-delete-<uuid>`      (service)
 *   `.<name>.quirky-remove-backup-<uuid>`     (skill-remove-transaction)
 *   `.<name>.quirky-placement-backup-<id>`    (skill-placement-transaction-controller)
 *   `.<name>.quirky-placement-staging-<id>`   (skill-placement-transaction-controller)
 *
 * Matched by shape rather than by an enumerated list so the native walker and
 * WSL's `find -prune` (which can only express a glob) cannot drift apart.
 */
export const SKILL_DELETE_STAGING_MARKER = '.quirky-skill-delete-'

/** The `find -name` glob the WSL guest script prunes on. */
export const SKILL_STAGING_GLOB = '.*.quirky-*'

const SKILL_STAGING_NAME = /^\..+\.quirky-/u

export function isSkillStagingEntryName(name: string): boolean {
  return SKILL_STAGING_NAME.test(name)
}

export function skillDeleteStagedName(basename: string, id: string): string {
  return `.${basename}${SKILL_DELETE_STAGING_MARKER}${id}`
}

export function isSkillDeleteStagedName(basename: string, staged: string): boolean {
  return staged.startsWith(`.${basename}${SKILL_DELETE_STAGING_MARKER}`)
}
