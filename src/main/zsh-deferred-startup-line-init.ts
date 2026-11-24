// Why: stock zshrc can replace line-init after the user clears the prompt-hook array.
export const ZSH_DEFERRED_LINE_INIT_BLOCK = `__quirky_deferred_line_init() {
  builtin emulate -L zsh
  (( \${+functions[__quirky_deferred_init]} )) || return 0
  local __quirky_direct_line_init=0
  [[ "\${widgets[zle-line-init]:-}" == user:__quirky_deferred_line_init ]] && __quirky_direct_line_init=1
  __quirky_deferred_init
  if (( __quirky_direct_line_init && \${+widgets[zle-line-init]} )); then
    zle zle-line-init "$@"
  elif [[ "\${widgets[zle-line-init]:-}" == user:__quirky_prompt_mark ]]; then
    local __quirky_prev_line_init_fn=""
    __quirky_prompt_mark "$@"
  fi
}
# Why: scheduled callbacks run after user prompt hooks without copying their function metadata.
__quirky_deferred_sched_init() {
  local __quirky_prompt_status=$?
  builtin emulate -L zsh
  (( \${+functions[__quirky_deferred_init]} )) && __quirky_deferred_init
  builtin unset __quirky_deferred_sched_armed
  builtin unfunction __quirky_deferred_sched_init
  return $__quirky_prompt_status
}
__quirky_arm_deferred_line_init() {
  builtin emulate -L zsh
  if [[ "\${widgets[zle-line-init]:-}" != user:__quirky_deferred_line_init ]]; then
    if (( \${+widgets[zle-line-init]} )); then
      zle -A zle-line-init __quirky_saved_line_init
    fi
    zle -N zle-line-init __quirky_deferred_line_init
  fi
  if (( ! $+__quirky_deferred_sched_armed )) && builtin zmodload -F zsh/sched b:sched 2>/dev/null; then
    builtin sched +0 __quirky_deferred_sched_init && builtin typeset -g __quirky_deferred_sched_armed=1
  fi
}`

// Why: restore the exact prior widget before the existing readiness hook captures it.
export const ZSH_DEFERRED_LINE_INIT_RETIRE_BLOCK = `  if (( \${+widgets[__quirky_saved_line_init]} )); then
    if [[ "\${widgets[zle-line-init]:-}" == user:__quirky_deferred_line_init ]]; then
      zle -A __quirky_saved_line_init zle-line-init
    fi
    zle -D __quirky_saved_line_init
  elif [[ "\${widgets[zle-line-init]:-}" == user:__quirky_deferred_line_init ]]; then
    zle -D zle-line-init
  fi`

// Why: plugins can copy a call to line-init into their own body; its guard makes it inert after startup.
export const ZSH_DEFERRED_LINE_INIT_CLEANUP_BLOCK = `  (( $+__quirky_deferred_sched_armed )) || builtin unfunction __quirky_deferred_sched_init`
