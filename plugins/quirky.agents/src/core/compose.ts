/**
 * Named rules that fold composed option values into the model ID the CLI receives.
 * A catalog selects one through `composeModel`.
 */
export const COMPOSE_RULES: Record<'cursor', (modelId: string, values: Record<string, string | boolean>) => string> = {
  cursor: (modelId, values) => {
    if (modelId === 'auto') return modelId
    const effort = typeof values.effort === 'string' ? `-${values.effort}` : ''
    if (modelId.startsWith('claude-')) {
      return `${modelId}${values.thinking === true ? '-thinking' : ''}${effort}`
    }
    return `${modelId}${effort}${values.fastMode === true ? '-fast' : ''}`
  }
}
