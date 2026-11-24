export const BASH_PROMPT_COMMAND_COMPOSITION_BLOCK = `__quirky_normalize_prompt_command_part() {
  local __quirky_value="$1" __quirky_output_name="$2" __quirky_character __quirky_chunk
  local __quirky_value_length=\${#1} __quirky_suffix_length=0 __quirky_backslash_length=0
  local __quirky_output_length __quirky_scan_start
  while (( __quirky_value_length - __quirky_suffix_length >= 1024 )); do
    __quirky_scan_start=$(( __quirky_value_length - __quirky_suffix_length - 1024 ))
    __quirky_chunk="\${__quirky_value:__quirky_scan_start:1024}"
    case "$__quirky_chunk" in
      *[!$' \\t\\n;']*) break ;;
      *) __quirky_suffix_length=$(( __quirky_suffix_length + 1024 )) ;;
    esac
  done
  while (( __quirky_suffix_length < __quirky_value_length )); do
    __quirky_character="\${__quirky_value: -__quirky_suffix_length - 1:1}"
    case "$__quirky_character" in
      ' '|$'\\t'|$'\\n'|';') __quirky_suffix_length=$(( __quirky_suffix_length + 1 )) ;;
      *) break ;;
    esac
  done
  __quirky_output_length=$(( \${#__quirky_value} - __quirky_suffix_length ))
  while (( __quirky_output_length - __quirky_backslash_length >= 1024 )); do
    __quirky_scan_start=$(( __quirky_output_length - __quirky_backslash_length - 1024 ))
    __quirky_chunk="\${__quirky_value:__quirky_scan_start:1024}"
    case "$__quirky_chunk" in
      *[!\\\\]*) break ;;
      *) __quirky_backslash_length=$(( __quirky_backslash_length + 1024 )) ;;
    esac
  done
  while (( __quirky_backslash_length < __quirky_output_length )); do
    __quirky_character="\${__quirky_value:__quirky_output_length - __quirky_backslash_length - 1:1}"
    [[ "$__quirky_character" == '\\' ]] || break
    __quirky_backslash_length=$(( __quirky_backslash_length + 1 ))
  done
  # Preserve the first separator when an odd backslash run escapes it.
  if (( __quirky_suffix_length > 0 && __quirky_backslash_length % 2 == 1 )); then
    __quirky_suffix_length=$(( __quirky_suffix_length - 1 ))
    __quirky_backslash_length=0
  fi
  __quirky_output_length=$(( \${#__quirky_value} - __quirky_suffix_length ))
  __quirky_value="\${__quirky_value:0:__quirky_output_length}"
  # Bash 4.4-5.0 scalar prompt evaluation preserves an odd terminal backslash.
  if (( __quirky_suffix_length == 0 && ((BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 4) || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] == 0)) && __quirky_backslash_length % 2 == 1 )); then
    __quirky_value="$__quirky_value\\\\"
  fi
  printf -v "$__quirky_output_name" '%s' "$__quirky_value"
}
__quirky_restore_prompt_status() {
  return "$1"
}
__quirky_update_user_debug_trap() {
  local __quirky_debug_trap_spec="$1" __quirky_unchanged_debug_trap_spec="$2"
  local __quirky_debug_trap_command
  [[ "$__quirky_debug_trap_spec" != "$__quirky_unchanged_debug_trap_spec" ]] || return 0
  [[ "$__quirky_debug_trap_spec" != "trap -- '__quirky_osc133_preexec' DEBUG" ]] || return 0
  if [[ -z "$__quirky_debug_trap_spec" ]]; then
    __quirky_user_debug_trap=""
    unset __quirky_chained_debug_trap
    return 0
  fi
  __quirky_debug_trap_command="\${__quirky_debug_trap_spec#trap -- }"
  __quirky_debug_trap_command="\${__quirky_debug_trap_command% DEBUG}"
  eval "__quirky_user_debug_trap=$__quirky_debug_trap_command"
  unset __quirky_chained_debug_trap
}
__quirky_run_user_debug_trap() {
  if [[ -n "\${__quirky_user_debug_trap:-}" ]]; then
    eval "$__quirky_user_debug_trap" || true
  fi
}
__quirky_adopt_outer_debug_trap() {
  local __quirky_debug_trap_spec="\${__quirky_outer_debug_trap_spec:-}"
  unset __quirky_outer_debug_trap_spec
  __quirky_update_user_debug_trap "$__quirky_debug_trap_spec" "trap -- '__quirky_osc133_preexec' DEBUG"
}
__quirky_run_prompt_command_array() {
  local __quirky_exit_code="\${__quirky_prompt_status:-$?}" __quirky_prompt_part __quirky_prompt_index __quirky_user_count
  local __quirky_suffix_part
  local __quirky_final_prompt_command
  local __quirky_in_prompt_dispatch=1 __quirky_dispatching_user_prompt_command=""
  unset __quirky_prompt_status
  __quirky_adopt_outer_debug_trap
  trap '__quirky_osc133_preexec' DEBUG
  for __quirky_prompt_part in "\${__quirky_prompt_command_prefix[@]+"\${__quirky_prompt_command_prefix[@]}"}"; do
    if (( __quirky_exit_code == 0 )); then
      eval "$__quirky_prompt_part"
    else
      __quirky_restore_prompt_status "$__quirky_exit_code" || eval "$__quirky_prompt_part"
    fi
  done
  __quirky_user_count=0
  for __quirky_prompt_part in "\${__quirky_prompt_command_array[@]+"\${__quirky_prompt_command_array[@]}"}"; do
    __quirky_user_count=$(( __quirky_user_count + 1 ))
  done
  for (( __quirky_prompt_index = 0; __quirky_prompt_index + 1 < __quirky_user_count; __quirky_prompt_index++ )); do
    __quirky_prompt_part="\${__quirky_prompt_command_array[__quirky_prompt_index]}"
    __quirky_dispatching_user_prompt_command=1
    if (( __quirky_exit_code == 0 )); then
      eval "$__quirky_prompt_part"
    else
      __quirky_restore_prompt_status "$__quirky_exit_code" || eval "$__quirky_prompt_part"
    fi
    __quirky_dispatching_user_prompt_command=""
  done
  if (( __quirky_user_count > 0 )); then
    __quirky_prompt_part="\${__quirky_prompt_command_array[__quirky_user_count - 1]}"
    # Why: keep the final user hook and Quirky suffixes in one status-preserving eval.
    __quirky_final_prompt_command='eval "$__quirky_prompt_part"'
    for __quirky_suffix_part in "\${__quirky_prompt_command_suffix[@]+"\${__quirky_prompt_command_suffix[@]}"}"; do
      __quirky_final_prompt_command+=$'\\n'"$__quirky_suffix_part"
    done
    __quirky_dispatching_user_prompt_command=1
    if (( __quirky_exit_code == 0 )); then
      eval "$__quirky_final_prompt_command"
    else
      __quirky_restore_prompt_status "$__quirky_exit_code" || eval "$__quirky_final_prompt_command"
    fi
    __quirky_dispatching_user_prompt_command=""
  else
    for __quirky_prompt_part in "\${__quirky_prompt_command_suffix[@]+"\${__quirky_prompt_command_suffix[@]}"}"; do
      if (( __quirky_exit_code == 0 )); then
        eval "$__quirky_prompt_part"
      else
        __quirky_restore_prompt_status "$__quirky_exit_code" || eval "$__quirky_prompt_part"
      fi
    done
  fi
  return "$__quirky_exit_code"
}
__quirky_finish_legacy_prompt_dispatch() {
  local __quirky_suffix_part
  if [[ -n "\${__quirky_in_prompt_command:-}" ]]; then
    for __quirky_suffix_part in "\${__quirky_prompt_command_suffix[@]+"\${__quirky_prompt_command_suffix[@]}"}"; do
      eval "$__quirky_suffix_part"
    done
  fi
  trap '__quirky_osc133_preexec' DEBUG
  unset __quirky_in_legacy_prompt_wrapper
}
__quirky_normalize_prompt_command() {
  [[ -z "\${__quirky_prompt_command_normalized:-}" ]] || return 0
  local __quirky_prompt_part
  local -a __quirky_normalized=()
  for __quirky_prompt_part in "\${PROMPT_COMMAND[@]+"\${PROMPT_COMMAND[@]}"}"; do
    __quirky_normalize_prompt_command_part "$__quirky_prompt_part" __quirky_prompt_part
    [[ -n "$__quirky_prompt_part" ]] && __quirky_normalized+=("$__quirky_prompt_part")
  done
  __quirky_prompt_command_normalized=1
  if (( BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 1) )); then
    PROMPT_COMMAND=("\${__quirky_normalized[@]+"\${__quirky_normalized[@]}"}")
  else
    __quirky_prompt_command_array=("\${__quirky_normalized[@]+"\${__quirky_normalized[@]}"}")
    __quirky_prompt_command_prefix=()
    __quirky_prompt_command_suffix=()
    unset PROMPT_COMMAND
    # Why: PID scope distinguishes legacy prompt dispatch from ordinary user command text.
    __quirky_prompt_status_variable="__quirky_prompt_status_$$"
    __quirky_prompt_status_capture_command="$__quirky_prompt_status_variable=\\$?"
    __quirky_prompt_status_value="\\\${$__quirky_prompt_status_variable}"
    PROMPT_COMMAND="$__quirky_prompt_status_capture_command; __quirky_prompt_status=$__quirky_prompt_status_value"'; __quirky_prompt_had_functrace=""; if [[ -o functrace ]]; then __quirky_prompt_had_functrace=1; set +T; fi; __quirky_outer_debug_trap_spec="$(trap -p DEBUG)"; [[ -z "$__quirky_prompt_had_functrace" ]] || set -T; unset __quirky_prompt_had_functrace; __quirky_run_prompt_command_array; __quirky_finish_legacy_prompt_dispatch'
  fi
}
__quirky_prepend_prompt_command() {
  local command="$1"
  __quirky_normalize_prompt_command
  if (( BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 1) )); then
    PROMPT_COMMAND=("$command" "\${PROMPT_COMMAND[@]+"\${PROMPT_COMMAND[@]}"}")
  else
    __quirky_prompt_command_prefix=("$command" "\${__quirky_prompt_command_prefix[@]+"\${__quirky_prompt_command_prefix[@]}"}")
  fi
}
__quirky_append_prompt_command() {
  local command="$1"
  __quirky_normalize_prompt_command
  if (( BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 1) )); then
    PROMPT_COMMAND+=("$command")
  else
    __quirky_prompt_command_suffix+=("$command")
  fi
}`
