/**
 * The Git repository `npx skills add` clones when Orca installs one of its bundled skills.
 *
 * This fork ships skills upstream does not have, so the install URL must name the fork's own
 * repository; a skill directory that exists only here is simply absent from upstream's tree.
 */
export const ORCA_SKILLS_REPOSITORY_SLUG = 'zpyoung/quirky'
export const ORCA_SKILLS_REPOSITORY_URL = `https://github.com/${ORCA_SKILLS_REPOSITORY_SLUG}`
