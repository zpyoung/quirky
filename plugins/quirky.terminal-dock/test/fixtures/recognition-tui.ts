export const RECOGNITION_TUI = `saved=$(stty -g)
restore() { stty "$saved"; }
trap restore EXIT HUP INT TERM
stty raw -echo
emit_title() { printf '\\033]0;Claude Code - manual recognition\\007'; }
emit_status() { printf '\\033]7501;state=working:app=ClaudeCode\\007'; }
emit_title
printf 'manual recognition ready\\n'
while :; do
  key=$(dd bs=1 count=1 2>/dev/null)
  printf '%s' "$key" >> "$HOME/dock-pty-input.bin"
  case "$key" in
    P) emit_status ;;
    L) printf '\\033]0;\\007'; printf '\\033]7501;state=clear:app=ClaudeCode\\007' ;;
    R) emit_title; emit_status ;;
    Q) break ;;
  esac
done
printf '\\033]0;manual shell prompt\\007'
printf '\\033]7501;state=done:app=ClaudeCode\\007'
`