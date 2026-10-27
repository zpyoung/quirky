import type { Template, TemplateVars } from './types'

export const TEMPLATE_NAME_MAX = 80
export const TEMPLATE_BODY_MAX = 8_000
export const TEMPLATE_LIMIT = 24

export const NO_GIT_STATUS = 'No git status was included.'
export const NO_CHANGED_PATHS = 'No changed paths were included.'
export const NO_EDITOR_TABS = 'No open editor tabs were included.'

export const BUILTIN_TEMPLATES: Template[] = [
  {
    id: 'continue-implementation',
    name: 'Continue implementation',
    body: 'Continue the implementation from where the prior session stopped. Check the current state first:\n{{gitStatus}}\nFinish the remaining work, run the relevant tests, and report what changed.'
  },
  {
    id: 'review-completed-work',
    name: 'Review what was done',
    body: 'Review the work the prior session did. Changed paths:\n{{changedPaths}}\nLook for bugs, missing tests and unfinished pieces. Report findings before changing anything.'
  },
  {
    id: 'debug-failure',
    name: 'Debug the failure',
    body: 'The prior session hit a failure. Reproduce it first, find the root cause, then fix it with a test that fails without the fix. Current state:\n{{gitStatus}}'
  }
]

const MISSING: Record<keyof TemplateVars, string> = {
  gitStatus: NO_GIT_STATUS,
  changedPaths: NO_CHANGED_PATHS,
  openEditorTabs: NO_EDITOR_TABS
}

const ALIASES: Record<string, keyof TemplateVars> = {
  gitStatus: 'gitStatus',
  GIT_STATUS: 'gitStatus',
  changedPaths: 'changedPaths',
  CHANGED_PATHS: 'changedPaths',
  openEditorTabs: 'openEditorTabs',
  OPEN_EDITOR_TABS: 'openEditorTabs'
}

const VARIABLE = /\{\{\s*(gitStatus|GIT_STATUS|changedPaths|CHANGED_PATHS|openEditorTabs|OPEN_EDITOR_TABS)\s*\}\}/g

/** Fills a template's variables; a variable whose data was not included reads as a sentence saying so. */
export function applyTemplate(body: string, vars: TemplateVars): string {
  return body.replace(VARIABLE, (_, name: string) => {
    const key = ALIASES[name]!
    return vars[key] || MISSING[key]
  })
}

function cutText(text: string, max: number): string {
  if (text.length <= max) return text
  const last = text.charCodeAt(max - 1)
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max)
}

/**
 * Cleans a template catalog on every write: names cut to 80 characters, bodies to 8,000,
 * entries with no name or body dropped, duplicate ids dropped, missing ids numbered, at most 24.
 */
export function normalizeTemplates(list: unknown[]): Template[] {
  const entries = list.flatMap((item) => {
    if (typeof item !== 'object' || item === null) return []
    const { id, name, body } = item as Record<string, unknown>
    const cleanName = typeof name === 'string' ? cutText(name.trim(), TEMPLATE_NAME_MAX) : ''
    const cleanBody = typeof body === 'string' ? cutText(body, TEMPLATE_BODY_MAX) : ''
    if (cleanName === '' || cleanBody.trim() === '') return []
    return [{ id: typeof id === 'string' && id.trim() !== '' ? id.trim() : null, name: cleanName, body: cleanBody }]
  })
  const taken = new Set<string>()
  const kept: { id: string | null; name: string; body: string }[] = []
  for (const entry of entries) {
    if (entry.id !== null) {
      if (taken.has(entry.id)) continue
      taken.add(entry.id)
    }
    kept.push(entry)
  }
  let counter = 0
  return kept.slice(0, TEMPLATE_LIMIT).map(({ id, name, body }) => {
    if (id !== null) return { id, name, body }
    do counter += 1
    while (taken.has(`template-${counter}`))
    taken.add(`template-${counter}`)
    return { id: `template-${counter}`, name, body }
  })
}
