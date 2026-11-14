import type { Schema } from '@quirky/protocol'

export interface ObjectivePayload {
  objectiveText: string
  existingPlan?: string
  tier: 'express' | 'standard' | 'full'
  landingBar: 'files-on-disk' | 'committed-local-branch' | 'pushed-ref' | 'hosted-review' | 'merged'
  lanesEnabled: boolean
  maxConcurrency: number
  writeTerritory: string[]
  roleAgents: { planner?: string; implementer?: string; reviewer?: string; integrator?: string }
  gates: { name: string; command: string; timeoutSeconds: number }[]
  worktree: string
}

export type ResolvedWorkspace = Record<string, unknown> & {
  id: string
  repoId: string
  path: string
  kind: 'git' | 'folder'
}

export const objectivePayloadSchema: Schema = {
  type: 'object',
  properties: {
    objectiveText: { type: 'string' },
    existingPlan: { type: 'string' },
    tier: { type: 'string', enum: ['express', 'standard', 'full'] },
    landingBar: {
      type: 'string',
      enum: ['files-on-disk', 'committed-local-branch', 'pushed-ref', 'hosted-review', 'merged']
    },
    lanesEnabled: { type: 'boolean' },
    maxConcurrency: { type: 'integer', minimum: 1, maximum: 1024 },
    writeTerritory: { type: 'array', items: { type: 'string' } },
    roleAgents: {
      type: 'object',
      properties: {
        planner: { type: 'string' },
        implementer: { type: 'string' },
        reviewer: { type: 'string' },
        integrator: { type: 'string' }
      },
      additionalProperties: false
    },
    gates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          command: { type: 'string' },
          timeoutSeconds: { type: 'integer', minimum: 10, maximum: 14_400 }
        },
        required: ['name', 'command', 'timeoutSeconds'],
        additionalProperties: false
      }
    },
    worktree: { type: 'string' }
  },
  required: ['objectiveText', 'tier', 'landingBar', 'lanesEnabled', 'maxConcurrency', 'writeTerritory', 'roleAgents', 'gates', 'worktree'],
  additionalProperties: false
}

const gateNamePattern = /^[a-z0-9][a-z0-9-]{0,39}$/
const agentNamePattern = /^[a-z0-9][a-z0-9._-]{0,63}$/
const roles: Record<string, true> = { planner: true, implementer: true, reviewer: true, integrator: true }
const forbiddenTerritoryCharacters = /[\[\]{}()!]/
const controlCharacters = /[\u0000-\u001f\u007f-\u009f]/

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function matchesWhole(pattern: RegExp, value: string): boolean {
  const match = pattern.exec(value)
  return match !== null && match[0] === value
}

function contractProblem(code: string, detail: string): string {
  return `${code}: ${detail}`
}

export function objectivePayload(input: unknown, worktreeSelector: string): ObjectivePayload {
  return {
    tier: 'standard',
    landingBar: 'files-on-disk',
    lanesEnabled: true,
    maxConcurrency: 3,
    writeTerritory: ['**'],
    roleAgents: {},
    gates: [],
    ...(recordOf(input) ?? {}),
    worktree: worktreeSelector
  } as ObjectivePayload
}

export function territoryProblems(value: unknown): string[] {
  if (!Array.isArray(value)) return [contractProblem('territory-invalid', 'write territory must be an array of relative paths')]
  const problems: string[] = []
  if (value.length === 0) problems.push(contractProblem('territory-invalid', 'write territory must include at least one path'))
  if (value.length > 64) problems.push(contractProblem('territory-invalid', 'write territory cannot include more than 64 paths'))
  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'string') {
      problems.push(contractProblem('territory-invalid', 'each write territory entry must be a string'))
      continue
    }
    if (seen.has(entry)) problems.push(contractProblem('territory-invalid', `duplicate write territory entry '${entry}'`))
    seen.add(entry)
    if (entry.length === 0) problems.push(contractProblem('territory-invalid', 'write territory entries must not be empty'))
    if (entry.startsWith('/') || entry.startsWith('~')) problems.push(contractProblem('territory-invalid', `write territory entry '${entry}' must be relative`))
    if (entry.includes('\\')) problems.push(contractProblem('territory-invalid', `write territory entry '${entry}' must use forward slashes`))
    if (/^[A-Za-z]:/.test(entry)) problems.push(contractProblem('territory-invalid', `write territory entry '${entry}' must not start with a drive letter`))
    if (/(^|\/)\.\.(\/|$)/.test(entry)) problems.push(contractProblem('territory-invalid', `write territory entry '${entry}' must not contain a '..' path segment`))
    if (controlCharacters.test(entry)) problems.push(contractProblem('territory-invalid', 'write territory entries must not contain control characters'))
    if (forbiddenTerritoryCharacters.test(entry)) problems.push(contractProblem('territory-invalid', `write territory entry '${entry}' contains a forbidden character`))
    const firstSegment = entry.split('/')[0]
    if (firstSegment === '.git' || firstSegment === '.quirky') {
      problems.push(contractProblem('territory-invalid', `write territory entry '${entry}' must not target ${firstSegment}`))
    }
  }
  return problems
}

export function contractProblems(payload: ObjectivePayload, owner?: unknown): string[] {
  const problems: string[] = []
  const value = recordOf(payload) ?? {}
  const objectiveText = value.objectiveText
  if (typeof objectiveText !== 'string' || objectiveText.trim().length === 0 || objectiveText.length > 16_384) {
    problems.push(contractProblem('objective-text-invalid', 'objective text must contain 1 to 16,384 characters after trimming'))
  }
  if (typeof value.existingPlan === 'string' && value.existingPlan.length > 65_536) {
    problems.push(contractProblem('existing-plan-too-long', 'existing plan must not exceed 65,536 characters'))
  }
  problems.push(...territoryProblems(value.writeTerritory))

  if (!Array.isArray(value.gates)) {
    problems.push(contractProblem('gates-invalid', 'gates must be an array'))
  } else {
    if (value.gates.length > 8) problems.push(contractProblem('gates-invalid', 'at most 8 gates are allowed'))
    const seenNames = new Set<string>()
    for (const entry of value.gates) {
      const gate = recordOf(entry)
      if (!gate) {
        problems.push(contractProblem('gates-invalid', 'each gate must be an object'))
        continue
      }
      const name = gate.name
      const command = gate.command
      const timeoutSeconds = gate.timeoutSeconds
      if (typeof name !== 'string' || !matchesWhole(gateNamePattern, name)) {
        problems.push(contractProblem('gates-invalid', 'gate names must match ^[a-z0-9][a-z0-9-]{0,39}$'))
      } else if (seenNames.has(name)) {
        problems.push(contractProblem('gates-invalid', `duplicate gate name '${name}'`))
      }
      if (typeof name === 'string') seenNames.add(name)
      if (typeof command !== 'string' || command.trim().length === 0 || command.length > 8_192) {
        problems.push(contractProblem('gates-invalid', 'gate commands must contain 1 to 8,192 characters'))
      }
      if (typeof timeoutSeconds !== 'number' || !Number.isInteger(timeoutSeconds) || timeoutSeconds < 10 || timeoutSeconds > 14_400) {
        problems.push(contractProblem('gates-invalid', 'gate timeoutSeconds must be an integer from 10 to 14,400'))
      }
    }
  }

  const roleAgents = recordOf(value.roleAgents)
  if (!roleAgents) {
    problems.push(contractProblem('role-agents-invalid', 'roleAgents must be an object'))
  } else {
    for (const [role, agent] of Object.entries(roleAgents)) {
      if (!Object.hasOwn(roles, role) || typeof agent !== 'string' || !matchesWhole(agentNamePattern, agent)) {
        problems.push(contractProblem('role-agents-invalid', `roleAgents.${role} must name a supported role and match ^[a-z0-9][a-z0-9._-]{0,63}$`))
      }
    }
  }

  if (value.landingBar === 'pushed-ref' || value.landingBar === 'hosted-review' || value.landingBar === 'merged') {
    problems.push(contractProblem('landing-bar-unsupported', `landing bar '${value.landingBar}' is not supported`))
  }
  if (owner !== undefined && owner !== null) problems.push(contractProblem('owner-unsupported', 'objective watchers cannot have an owning agent'))
  return problems
}

function worktreeUnresolved(detail: string): Error {
  return new Error(`worktree-unresolved: ${detail}; select a workspace with --worktree`)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function resolveWorkspace(
  call: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  selector: string
): Promise<ResolvedWorkspace> {
  let resolvedSelector = selector
  if (selector === 'active') {
    let state: unknown
    try {
      state = await call('ui.state', {})
    } catch (error) {
      throw worktreeUnresolved(`could not read UI state: ${errorText(error)}`)
    }
    const windows = recordOf(state)?.windows
    if (!Array.isArray(windows) || windows.length !== 1) {
      throw worktreeUnresolved('active requires exactly one connected UI window; specify --worktree')
    }
    const connId = recordOf(windows[0])?.connId
    if (typeof connId !== 'number' || !Number.isSafeInteger(connId) || connId < 1) {
      throw worktreeUnresolved('the connected UI window has no valid connection ID; specify --worktree')
    }
    let selected: unknown
    try {
      selected = await call('ui.window.state', { connId })
    } catch (error) {
      throw worktreeUnresolved(`could not read the selected UI window: ${errorText(error)}`)
    }
    const selectedState = recordOf(selected)
    const layout = recordOf(selectedState?.layout)
    const worktreeId = layout?.worktree
    if (selectedState?.connId !== connId || typeof worktreeId !== 'string' || worktreeId.length === 0) {
      throw worktreeUnresolved('the single connected UI window has no selected worktree; specify --worktree')
    }
    resolvedSelector = `id:${worktreeId}`
  }

  let value: unknown
  try {
    value = await call('quirky.worktree/resolve', { selector: resolvedSelector })
  } catch (error) {
    throw worktreeUnresolved(`could not resolve '${resolvedSelector}': ${errorText(error)}`)
  }
  const workspace = recordOf(value)
  if (!workspace || typeof workspace.id !== 'string' || typeof workspace.repoId !== 'string' ||
    typeof workspace.path !== 'string' || (workspace.kind !== 'git' && workspace.kind !== 'folder')) {
    throw worktreeUnresolved(`quirky.worktree/resolve returned an invalid workspace for '${resolvedSelector}'`)
  }
  if (workspace.kind === 'folder') throw new Error('workspace-requires-git: objective workspaces must be git worktrees')
  return workspace as ResolvedWorkspace
}
