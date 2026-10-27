// wrappers may prepend an SSH/tmux label and OpenCode one status glyph; a spinner-led task
// from another agent must not read as a wrapper
const OPENCODE_NATIVE_TITLE_RE = /^\s*(?:(?![▣⠀-⣿])[^|]+? \| )?(?:[▣⠀-⣿] )?OC \|[ \t]+\S/u

export function isOpenCodeNativeTitle(title: string): boolean {
  return OPENCODE_NATIVE_TITLE_RE.test(title)
}
