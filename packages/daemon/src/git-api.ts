/** The git module as a dependency, so tests can substitute a fake. */
export type GitApi = typeof import('./git')
