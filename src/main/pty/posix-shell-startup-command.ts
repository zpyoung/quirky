import { basename, win32 as pathWin32 } from 'node:path'

export const POSIX_SHELL_STARTUP_COMMAND_ENV = 'QUIRKY_POSIX_SHELL_STARTUP_COMMAND'

export function supportsPosixShellStartupCommand(shellPath: string): boolean {
  const shellName = pathWin32.basename(basename(shellPath)).toLowerCase()
  return shellName === 'bash' || shellName === 'zsh' || shellName === 'fish'
}

export function getBashStartupCommandPromptBlock(): string {
  return `if [[ \${${POSIX_SHELL_STARTUP_COMMAND_ENV}+present} == present ]]; then
  __quirky_remove_startup_command_prompt_hook() {
    local __quirky_item
    local -a __quirky_remaining=()
    if (( BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 1) )); then
      for __quirky_item in "\${PROMPT_COMMAND[@]+"\${PROMPT_COMMAND[@]}"}"; do
        [[ "$__quirky_item" == "__quirky_run_startup_command" ]] || __quirky_remaining+=("$__quirky_item")
      done
      PROMPT_COMMAND=("\${__quirky_remaining[@]+"\${__quirky_remaining[@]}"}")
    else
      for __quirky_item in "\${__quirky_prompt_command_suffix[@]+"\${__quirky_prompt_command_suffix[@]}"}"; do
        [[ "$__quirky_item" == "__quirky_run_startup_command" ]] || __quirky_remaining+=("$__quirky_item")
      done
      __quirky_prompt_command_suffix=("\${__quirky_remaining[@]+"\${__quirky_remaining[@]}"}")
    fi
  }
  __quirky_run_startup_command() {
    local __quirky_command="$${POSIX_SHELL_STARTUP_COMMAND_ENV}" __quirky_status
    unset ${POSIX_SHELL_STARTUP_COMMAND_ENV}
    __quirky_remove_startup_command_prompt_hook
    unset -f __quirky_remove_startup_command_prompt_hook
    builtin history -s "$__quirky_command" 2>/dev/null || true
    builtin printf '%s\n' "$__quirky_command"
    eval "$__quirky_command"
    __quirky_status=$?
    unset -f __quirky_run_startup_command
    return "$__quirky_status"
  }
  __quirky_append_prompt_command "__quirky_run_startup_command"
fi`
}
