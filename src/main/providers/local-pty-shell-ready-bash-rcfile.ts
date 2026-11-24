/**
 * Content of the bash rcfile Quirky launches interactive bash with.
 *
 * Why: bash gets a single `--rcfile` wrapper (not a ZDOTDIR tree), so the login
 * startup-file chain, OSC 133 hooks, and the shell-ready marker all live here.
 */
import { BASH_PROMPT_COMMAND_COMPOSITION_BLOCK } from '../bash-prompt-command-composition'
import { QUIRKY_CLI_POSIX_PATH_RESTORE } from '../../shared/quirky-cli-shell-path'
import { MANAGED_DATA_ACCOUNT_POSIX_RESTORE } from '../../shared/managed-data-account-shell'
import { getPosixOmpShellWrapper } from '../pty/omp-shell-wrapper'
import { getPosixCodexShellLaunchPreflight } from '../../shared/codex-shell-function'
import { getPosixClaudeShellFunction } from '../../shared/claude-shell-function'
import { getBashStartupCommandPromptBlock } from '../pty/posix-shell-startup-command'
import { BASH_FEATURE_CHANNEL_BLOCK, SHELL_STARTUP_IDENTITY_MARKER_BLOCK } from '../shell-templates'
import { SHELL_READY_MARKER_ESCAPED } from './local-pty-shell-ready-marker'

export function getBashShellReadyRcfileContent(): string {
  return `# Quirky bash shell-ready wrapper
${BASH_FEATURE_CHANNEL_BLOCK}
${SHELL_STARTUP_IDENTITY_MARKER_BLOCK}
# Why a plain variable: the channel is consumed and destroyed in these first
# lines, so nothing this shell later spawns can see or inherit the selection.
__quirky_ready_marker=""
__quirky_has_feature ready && __quirky_ready_marker=1
unset _quirky_shell_features
unset -f __quirky_has_feature
[[ -f /etc/profile ]] && source /etc/profile
if [[ -f "$HOME/.bash_profile" ]]; then
  source "$HOME/.bash_profile"
elif [[ -f "$HOME/.bash_login" ]]; then
  source "$HOME/.bash_login"
elif [[ -f "$HOME/.profile" ]]; then
  source "$HOME/.profile"
fi
# Why: enable bracketed paste so Quirky can deliver a multiline startup prompt as
# a single literal paste (ESC[200~…ESC[201~). Without it, older readline builds
# treat each embedded newline as Enter and mangle the prompt into PS2
# continuation. Modern readline defaults this on; force it for the rest.
[[ $- == *i* ]] && bind 'set enable-bracketed-paste on' 2>/dev/null
# Why: preserve bash's normal login-shell contract. Many users already source
# ~/.bashrc from ~/.bash_profile; forcing ~/.bashrc again here would duplicate
# PATH edits, hooks, and prompt init in Quirky startup-command shells.
__quirky_restore_agent_teams_path() {
  [[ -n "\${QUIRKY_AGENT_TEAMS_SHIM_DIR:-}" ]] || return 0
  case "$PATH" in
    "\${QUIRKY_AGENT_TEAMS_SHIM_DIR}"|"\${QUIRKY_AGENT_TEAMS_SHIM_DIR}:"*) return 0 ;;
  esac
  export PATH="\${QUIRKY_AGENT_TEAMS_SHIM_DIR}:$PATH"
}
__quirky_restore_agent_teams_path
${QUIRKY_CLI_POSIX_PATH_RESTORE}
# Why: user startup files may set the default OpenCode config after Quirky's
# spawn env; restore the Quirky-managed config dir before the first prompt.
[[ -n "\${QUIRKY_OPENCODE_CONFIG_DIR:-}" ]] && export OPENCODE_CONFIG_DIR="\${QUIRKY_OPENCODE_CONFIG_DIR}"
${MANAGED_DATA_ACCOUNT_POSIX_RESTORE}
[[ -n "\${QUIRKY_MIMOCODE_HOME:-}" ]] && export MIMOCODE_HOME="\${QUIRKY_MIMOCODE_HOME}"
${getPosixOmpShellWrapper()}
# Why: Codex must keep using Quirky's runtime CODEX_HOME after profile scripts.
[[ -n "\${QUIRKY_CODEX_HOME:-}" ]] && export CODEX_HOME="\${QUIRKY_CODEX_HOME}"
${getPosixCodexShellLaunchPreflight() + getPosixClaudeShellFunction()}
# Why: emit OSC 133 C/D so terminal-command-lifecycle can drop stale agent
# status when the foreground command (e.g. an interrupted Claude/Codex CLI)
# exits — mirrors the zsh wrapper. Without this, bash users (default on most
# Linux distros) keep a stuck 'working' spinner for up to 30 min after the
# CLI exits without sending a Stop/SessionEnd hook.
__quirky_initializing_wrapper=1
__quirky_osc133_precmd() {
  local exit_code=$?
  __quirky_in_prompt_command=1
  if [[ -n "\${__quirky_in_command:-}" ]]; then
    printf "\\033]133;D;%s\\007" "$exit_code"
    unset __quirky_in_command
  fi
  printf "\\033]133;A\\007"
  return "$exit_code"
}
__quirky_osc133_prompt_done() {
  unset __quirky_in_prompt_command
  __quirky_adopt_outer_debug_trap
  trap '__quirky_osc133_preexec' DEBUG
}
__quirky_osc133_preexec() {
  if [[ -n "\${__quirky_prompt_status_capture_command:-}" && "$BASH_COMMAND" == "$__quirky_prompt_status_capture_command" ]]; then
    unset __quirky_initial_prompt
    __quirky_in_legacy_prompt_wrapper=1
    return 0
  fi
  if [[ -n "\${__quirky_initializing_wrapper:-}\${__quirky_in_debug_capture:-}\${__quirky_initial_prompt:-}\${__quirky_in_prompt_dispatch:-}\${__quirky_in_legacy_prompt_wrapper:-}\${__quirky_in_prompt_command:-}" ]]; then
    [[ -z "\${__quirky_initializing_wrapper:-}\${__quirky_in_debug_capture:-}" ]] || return 0
    if [[ -n "\${__quirky_initial_prompt:-}" && "$BASH_COMMAND" == "__quirky_osc133_precmd" ]]; then
      unset __quirky_initial_prompt; return 0
    fi
    if [[ -n "\${__quirky_in_prompt_dispatch:-}" ]]; then
      [[ -n "\${__quirky_dispatching_user_prompt_command:-}" ]] || return 0
      if [[ "\${FUNCNAME[1]:-}" == "__quirky_run_prompt_command_array" ]]; then
        case "$BASH_COMMAND" in
          '(( __quirky_exit_code == 0 ))'|'__quirky_restore_prompt_status "$__quirky_exit_code"'|'eval "$__quirky_prompt_part"'|'eval "$__quirky_final_prompt_command"'|__quirky_dispatching_user_prompt_command=*|__quirky_osc133_precmd|__quirky_osc133_prompt_done|__quirky_prompt_mark) return 0 ;;
        esac
      fi
    elif [[ "\${FUNCNAME[1]:-}" == "__quirky_run_prompt_command_array" || "$BASH_COMMAND" == "__quirky_run_prompt_command_array" ]]; then
      return 0
    fi
    [[ -z "\${__quirky_in_legacy_prompt_wrapper:-}" || -n "\${__quirky_dispatching_user_prompt_command:-}" ]] || return 0
    if [[ -n "\${__quirky_in_prompt_command:-}" && "$BASH_COMMAND" == "__quirky_in_debug_capture=1" ]]; then
      return 0
    fi
  fi
  case "\${FUNCNAME[1]:-}" in __quirky_osc133_*|__quirky_prompt_mark|__quirky_restore_prompt_status) return 0 ;; esac
  case "$BASH_COMMAND" in __quirky_osc133_precmd|__quirky_osc133_prompt_done|__quirky_prompt_mark) return 0 ;; esac
  __quirky_run_user_debug_trap
  [[ -z "\${__quirky_in_prompt_command:-}" ]] || return 0
  [[ -z "\${__quirky_in_command:-}" ]] || return 0
  # functrace runs this trap inside systemd's PS0 subshell, where a C would repeat the real command's
  case "$BASH_COMMAND" in __systemd_osc_context_*) return 0 ;; esac
  case "\${FUNCNAME[1]:-}" in __systemd_osc_context_*) return 0 ;; esac
  # Why: bash DEBUG fires for every simple command, including PROMPT_COMMAND
  # bodies and chained traps can call us repeatedly for one command.
  printf "\\033]133;C\\007"
  __quirky_in_command=1
}
# Why: prepend so we capture $? before the user's PROMPT_COMMAND chain mutates it.
${BASH_PROMPT_COMMAND_COMPOSITION_BLOCK}
__quirky_prepend_prompt_command "__quirky_osc133_precmd"
# Why: append the marker through PROMPT_COMMAND so it fires after the login
# startup files have rebuilt the prompt, without re-running user rc files.
if [[ -n "$__quirky_ready_marker" ]]; then
  __quirky_prompt_mark() {
    printf "${SHELL_READY_MARKER_ESCAPED}"
  }
  __quirky_append_prompt_command "__quirky_prompt_mark"
fi
__quirky_append_prompt_command '__quirky_in_debug_capture=1; __quirky_prompt_had_functrace=""; if [[ -o functrace ]]; then __quirky_prompt_had_functrace=1; set +T; fi; __quirky_outer_debug_trap_spec="$(trap -p DEBUG)"; [[ -z "$__quirky_prompt_had_functrace" ]] || set -T; unset __quirky_prompt_had_functrace __quirky_in_debug_capture'
__quirky_append_prompt_command "__quirky_osc133_prompt_done"
${getBashStartupCommandPromptBlock()}
__quirky_had_functrace=""
[[ -o functrace ]] && __quirky_had_functrace=1
set +T
__quirky_debug_trap_spec="$(trap -p DEBUG)"
[[ -z "$__quirky_had_functrace" ]] || set -T
if [[ -n "$__quirky_debug_trap_spec" && "$__quirky_debug_trap_spec" != "trap -- '__quirky_osc133_preexec' DEBUG" ]]; then
  __quirky_debug_trap_command="\${__quirky_debug_trap_spec#trap -- }"
  __quirky_debug_trap_command="\${__quirky_debug_trap_command% DEBUG}"
  eval "__quirky_user_debug_trap=$__quirky_debug_trap_command"
fi
unset __quirky_debug_trap_spec __quirky_debug_trap_command __quirky_had_functrace
unset -f __quirky_normalize_prompt_command_part __quirky_normalize_prompt_command __quirky_prepend_prompt_command __quirky_append_prompt_command
unset __quirky_prompt_command_normalized
# Why: arm DEBUG after wrapper setup; otherwise bash treats our own rcfile
# commands as a foreground command and emits a fake C/D before the first prompt.
__quirky_initial_prompt=1
trap '__quirky_osc133_preexec' DEBUG
unset __quirky_initializing_wrapper
`
}
