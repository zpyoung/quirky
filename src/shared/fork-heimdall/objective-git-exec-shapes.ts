export const OBJECTIVE_GIT_EXEC_PATH_BATCH_SIZE = 200

export const OBJECTIVE_SYMLINK_OID_ALIAS = 'quirky-objective-symlink-oid'
export const OBJECTIVE_SYMLINK_OID_ALIAS_CONFIG =
  'alias.quirky-objective-symlink-oid=!f() { test "$1" = -- && shift; for path do case "$path" in -*) path="./$path";; esac; printf "%s" "$(readlink "$path")" | git hash-object --stdin | tr -d "\\n"; printf "\\0"; done; }; f'

export const OBJECTIVE_PATH_MODES_ALIAS = 'quirky-objective-modes'
export const OBJECTIVE_PATH_MODES_ALIAS_CONFIG =
  'alias.quirky-objective-modes=!f() { test "$1" = -- && shift; for path do case "$path" in -*) path="./$path";; esac; if test -L "$path"; then printf "symlink\\\\0"; readlink "$path" || exit; printf "\\\\0"; elif test -x "$path"; then printf "file:executable\\\\0"; else printf "file:regular\\\\0"; fi; done; }; f'
