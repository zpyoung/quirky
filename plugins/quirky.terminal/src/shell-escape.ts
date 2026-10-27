const SAFE_PATH = /^[A-Za-z0-9_./-]+$/

/**
 * The text typed at a prompt when files are dropped on a pane: paths made of safe characters
 * stay bare, any other path is single-quoted (an embedded quote becomes `'\''`), joined by spaces.
 */
export function shellEscapePaths(paths: readonly string[]): string {
  return paths.map((path) => (SAFE_PATH.test(path) ? path : `'${path.replaceAll("'", `'\\''`)}'`)).join(' ')
}
