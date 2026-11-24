/** The AskUserQuestion suppression flag/value pairs Quirky injects into a managed
 *  Claude Code launch. Lives in `shared` (not the main-process gate module that
 *  owns the version-floor decision) so launch-command composition code running
 *  in the renderer can match against these same literals without pulling
 *  main-process code into the renderer bundle. */
export const CLAUDE_ASK_SUPPRESSION_DISALLOWED_TOOLS_FLAG = '--disallowedTools'
export const CLAUDE_ASK_SUPPRESSION_DISALLOWED_TOOLS_VALUE = 'AskUserQuestion'
export const CLAUDE_ASK_SUPPRESSION_SYSTEM_PROMPT_FLAG = '--append-system-prompt'
export const CLAUDE_ASK_SUPPRESSION_SYSTEM_PROMPT_VALUE =
  'When you need to ask the user a question, run the quirky ask CLI (see the quirky-ask skill) instead of asking in chat.'
