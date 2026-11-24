export const QUIRKY_CLI_POSIX_PATH_RESTORE = `if [ -n "\${QUIRKY_CLI_BIN_DIR:-}" ]; then
  case "\${PATH:-}" in
    "$QUIRKY_CLI_BIN_DIR"|"$QUIRKY_CLI_BIN_DIR":*) ;;
    *) export PATH="$QUIRKY_CLI_BIN_DIR\${PATH:+:$PATH}" ;;
  esac
fi`
