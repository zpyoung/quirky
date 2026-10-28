import type { CliArgs, CliContext, CliModule } from '@quirky/protocol'

const METHODS: Record<string, string> = {
  uiState: 'uiState', uiNavigate: 'uiNavigate', open: 'open', close: 'close', settings: 'settings',
  'editor-data': 'editorData', 'editor-open': 'openEditor', 'editor-patch': 'patchDraft', 'editor-save': 'saveEditor', 'editor-cancel': 'cancelEditor',
  'external-list': 'externalList', 'external-action': 'externalAction', 'external-action-describe': 'externalActionDescribe'
}
function jsonObject(value: unknown, name: string, context: CliContext): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value !== 'string') throw context.usage(`--${name} must contain a JSON object`)
  let result: unknown
  try { result = JSON.parse(value) } catch { throw context.usage(`--${name} must contain a JSON object`) }
  if (result === null || typeof result !== 'object' || Array.isArray(result)) throw context.usage(`--${name} must contain a JSON object`)
  return result as Record<string, unknown>
}
export const uiCommands: CliModule['commands'] = Object.fromEntries(Object.entries(METHODS).map(([name, method]) => [name, async (args: CliArgs, context: CliContext) => {
  if (args.positionals.length) throw context.usage('This command uses named flags, not positional arguments.')
  const flags: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args.flags)) flags[key.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())] = value
  let params: Record<string, unknown> = {}
  if (flags.params !== undefined) params = jsonObject(flags.params, 'params', context)
  else if (method === 'uiNavigate' || method === 'open') params = flags.patch === undefined ? {} : jsonObject(flags.patch, 'patch', context)
  else if (method === 'patchDraft') params = { patch: jsonObject(flags.patch, 'patch', context), ...(typeof flags.template === 'string' ? { template: flags.template } : {}) }
  else {
    for (const [key, value] of Object.entries(flags)) {
      if (key === 'owner') params[key] = jsonObject(value, 'owner', context)
      else params[key] = value
    }
  }
  const result = await context.call(`quirky.automations/${method}`, params)
  context.out.result(result, () => JSON.stringify(result, null, 2))
}]))
