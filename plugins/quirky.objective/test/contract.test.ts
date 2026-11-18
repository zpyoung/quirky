import { test, expect } from 'bun:test'
import { validateValue } from '@quirky/protocol'
import {
  contractProblems,
  objectivePayload,
  objectivePayloadSchema,
  resolveWorkspace,
  territoryProblems,
  type ObjectivePayload
} from '../src/contract'

const payload = (input: unknown = { objectiveText: 'Implement the requested change.' }, worktree = 'id:wt-main') =>
  objectivePayload(input, worktree)

const validPayload = (): ObjectivePayload => payload()

test('fills the CLI defaults and keeps every given field', () => {
  expect(payload()).toEqual({
    objectiveText: 'Implement the requested change.',
    tier: 'standard',
    landingBar: 'files-on-disk',
    lanesEnabled: true,
    maxConcurrency: 3,
    writeTerritory: ['**'],
    roleAgents: {},
    gates: [],
    worktree: 'id:wt-main'
  })

  expect(payload({
    objectiveText: '  Add a feature  ',
    existingPlan: 'Keep the public API stable.',
    tier: 'express',
    landingBar: 'committed-local-branch',
    lanesEnabled: false,
    maxConcurrency: 12,
    writeTerritory: ['src/**', 'docs/*.md'],
    roleAgents: { planner: 'codex', implementer: 'claude', reviewer: 'reviewer', integrator: 'claude' },
    gates: [{ name: 'lint', command: 'pnpm lint', timeoutSeconds: 120 }],
    worktree: 'active'
  }, 'id:wt-selected')).toEqual({
    objectiveText: '  Add a feature  ',
    existingPlan: 'Keep the public API stable.',
    tier: 'express',
    landingBar: 'committed-local-branch',
    lanesEnabled: false,
    maxConcurrency: 12,
    writeTerritory: ['src/**', 'docs/*.md'],
    roleAgents: { planner: 'codex', implementer: 'claude', reviewer: 'reviewer', integrator: 'claude' },
    gates: [{ name: 'lint', command: 'pnpm lint', timeoutSeconds: 120 }],
    worktree: 'id:wt-selected'
  })

  const withUnknownKey = payload({ objectiveText: 'Keep unknown keys for schema validation.', futureOption: true }) as ObjectivePayload & Record<string, unknown>
  expect(withUnknownKey.futureOption).toBe(true)
  expect(validateValue(objectivePayloadSchema, withUnknownKey, 'kindPayload')).toContain('futureOption')
  expect(contractProblems(validPayload())).toEqual([])
})

test('remote bars enroll without weakening local or workspace validation', () => {
  const schemaCases: Array<[string, (value: Record<string, unknown>) => void]> = [
    ['objectiveText must be a string', (value) => { value.objectiveText = 1 }],
    ['existingPlan must be a string', (value) => { value.existingPlan = null }],
    ['tier must be an allowed enum', (value) => { value.tier = 'urgent' }],
    ['landingBar must be an allowed enum', (value) => { value.landingBar = 'remote' }],
    ['dirty is not a landing bar enum', (value) => { value.landingBar = 'dirty' }],
    ['committed is not a landing bar enum', (value) => { value.landingBar = 'committed' }],
    ['merged-into-base is not a landing bar enum', (value) => { value.landingBar = 'merged-into-base' }],
    ['lanesEnabled must be a boolean', (value) => { value.lanesEnabled = 'yes' }],
    ['maxConcurrency must be an integer', (value) => { value.maxConcurrency = 1.5 }],
    ['maxConcurrency must be numeric', (value) => { value.maxConcurrency = '2' }],
    ['maxConcurrency must be finite', (value) => { value.maxConcurrency = Number.NaN }],
    ['maxConcurrency must be finite', (value) => { value.maxConcurrency = Number.POSITIVE_INFINITY }],
    ['maxConcurrency must be finite', (value) => { value.maxConcurrency = Number.NEGATIVE_INFINITY }],
    ['maxConcurrency has a lower bound', (value) => { value.maxConcurrency = 0 }],
    ['maxConcurrency has an upper bound', (value) => { value.maxConcurrency = 1025 }],
    ['writeTerritory must be an array', (value) => { value.writeTerritory = '**' }],
    ['writeTerritory entries must be strings', (value) => { value.writeTerritory = [3] }],
    ['roleAgents must be an object', (value) => { value.roleAgents = [] }],
    ['roleAgents has a strict key set', (value) => { value.roleAgents = { unknown: 'claude' } }],
    ['roleAgents values must be strings', (value) => { value.roleAgents = { planner: 3 } }],
    ['gates must be an array', (value) => { value.gates = {} }],
    ['gate fields are required', (value) => { value.gates = [{ name: 'lint', command: 'pnpm lint' }] }],
    ['gate name must be a string', (value) => { value.gates = [{ name: 1, command: 'pnpm lint', timeoutSeconds: 10 }] }],
    ['gate command must be a string', (value) => { value.gates = [{ name: 'lint', command: false, timeoutSeconds: 10 }] }],
    ['gate timeout must be an integer', (value) => { value.gates = [{ name: 'lint', command: 'pnpm lint', timeoutSeconds: 10.5 }] }],
    ['gate timeout has a lower bound', (value) => { value.gates = [{ name: 'lint', command: 'pnpm lint', timeoutSeconds: 9 }] }],
    ['gate timeout has an upper bound', (value) => { value.gates = [{ name: 'lint', command: 'pnpm lint', timeoutSeconds: 14401 }] }],
    ['worktree must be a string', (value) => { value.worktree = 1 }],
    ['unknown top-level fields are rejected', (value) => { value.unknown = true }]
  ]

  for (const tier of ['express', 'standard', 'full']) {
    const candidate = { ...validPayload(), tier }
    expect(validateValue(objectivePayloadSchema, candidate, 'kindPayload'), `tier ${tier}`).toBeNull()
  }
  for (const landingBar of ['files-on-disk', 'committed-local-branch', 'pushed-ref', 'hosted-review', 'merged']) {
    const candidate = { ...validPayload(), landingBar }
    expect(validateValue(objectivePayloadSchema, candidate, 'kindPayload'), `landing bar ${landingBar}`).toBeNull()
  }
  for (const maxConcurrency of [1, 1024]) {
    expect(validateValue(objectivePayloadSchema, { ...validPayload(), maxConcurrency }, 'kindPayload')).toBeNull()
  }
  for (const timeoutSeconds of [10, 14400]) {
    const candidate = { ...validPayload(), gates: [{ name: 'lint', command: 'pnpm lint', timeoutSeconds }] }
    expect(validateValue(objectivePayloadSchema, candidate, 'kindPayload')).toBeNull()
  }

  const required = ['objectiveText', 'tier', 'landingBar', 'lanesEnabled', 'maxConcurrency', 'writeTerritory', 'roleAgents', 'gates', 'worktree']
  for (const name of required) {
    const candidate: Record<string, unknown> = { ...validPayload() }
    delete candidate[name]
    expect(validateValue(objectivePayloadSchema, candidate, 'kindPayload'), `missing ${name}`).not.toBeNull()
  }
  expect(validateValue(objectivePayloadSchema, validPayload(), 'kindPayload')).toBeNull()

  for (const [description, mutate] of schemaCases) {
    const candidate: Record<string, unknown> = { ...validPayload() }
    mutate(candidate)
    expect(validateValue(objectivePayloadSchema, candidate, 'kindPayload'), description).not.toBeNull()
  }
  expect(validateValue(objectivePayloadSchema, null, 'kindPayload')).not.toBeNull()
  expect(validateValue(objectivePayloadSchema, [], 'kindPayload')).not.toBeNull()

  const invalid: Array<[string, string, (value: ObjectivePayload) => void]> = [
    ['empty objective text', 'objective-text-invalid', (value) => { value.objectiveText = ' \n\t ' }],
    ['overlong objective text', 'objective-text-invalid', (value) => { value.objectiveText = 'x'.repeat(16_385) }],
    ['overlong existing plan', 'existing-plan-too-long', (value) => { value.existingPlan = 'x'.repeat(65_537) }],
    ['empty territory', 'territory-invalid', (value) => { value.writeTerritory = [] }],
    ['too many territory entries', 'territory-invalid', (value) => { value.writeTerritory = Array.from({ length: 65 }, (_, index) => `src/${index}`) }],
    ['duplicate territory entries', 'territory-invalid', (value) => { value.writeTerritory = ['src/**', 'src/**'] }],
    ['empty territory entry', 'territory-invalid', (value) => { value.writeTerritory = [''] }],
    ['absolute territory entry', 'territory-invalid', (value) => { value.writeTerritory = ['/src/main.ts'] }],
    ['tilde territory entry', 'territory-invalid', (value) => { value.writeTerritory = ['~/src/main.ts'] }],
    ['backslash territory entry', 'territory-invalid', (value) => { value.writeTerritory = ['src\\main.ts'] }],
    ['drive-letter territory entry', 'territory-invalid', (value) => { value.writeTerritory = ['C:/src/main.ts'] }],
    ['parent-segment territory entry', 'territory-invalid', (value) => { value.writeTerritory = ['src/../secret.ts'] }],
    ['control character in territory entry', 'territory-invalid', (value) => { value.writeTerritory = ['src/\u0001secret.ts'] }],
    ...['[', ']', '{', '}', '(', ')', '!'].map((character): [string, string, (value: ObjectivePayload) => void] => [
      `forbidden ${character} in territory entry`, 'territory-invalid', (value) => { value.writeTerritory = [`src/${character}file`] }
    ]),
    ['.git territory root', 'territory-invalid', (value) => { value.writeTerritory = ['.git/config'] }],
    ['.quirky territory root', 'territory-invalid', (value) => { value.writeTerritory = ['.quirky/objective'] }],
    ['dot path segment in territory', 'territory-invalid', (value) => { value.writeTerritory = ['.'] }],
    ['leading dot path segment in territory', 'territory-invalid', (value) => { value.writeTerritory = ['./.git/**'] }],
    ['repeated leading dot path segments in territory', 'territory-invalid', (value) => { value.writeTerritory = ['././.git/**'] }],
    ['leading dot path segment before .quirky', 'territory-invalid', (value) => { value.writeTerritory = ['./.quirky/**'] }],
    ['repeated leading dot path segments before .quirky', 'territory-invalid', (value) => { value.writeTerritory = ['././.quirky/**'] }],
    ['interior dot path segment in territory', 'territory-invalid', (value) => { value.writeTerritory = ['src/./**'] }],
    ['too many gates', 'gates-invalid', (value) => { value.gates = Array.from({ length: 9 }, (_, index) => ({ name: `gate-${index}`, command: 'true', timeoutSeconds: 30 })) }],
    ['invalid gate name', 'gates-invalid', (value) => { value.gates = [{ name: 'Lint', command: 'true', timeoutSeconds: 30 }] }],
    ['duplicate gate names', 'gates-invalid', (value) => { value.gates = [{ name: 'lint', command: 'true', timeoutSeconds: 30 }, { name: 'lint', command: 'true', timeoutSeconds: 30 }] }],
    ['empty gate command', 'gates-invalid', (value) => { value.gates = [{ name: 'lint', command: '', timeoutSeconds: 30 }] }],
    ['overlong gate command', 'gates-invalid', (value) => { value.gates = [{ name: 'lint', command: 'x'.repeat(8_193), timeoutSeconds: 30 }] }],
    ['unknown role agent', 'role-agents-invalid', (value) => { value.roleAgents = { planner: 'claude', unknown: 'claude' } as ObjectivePayload['roleAgents'] }],
    ['invalid role-agent identifier', 'role-agents-invalid', (value) => { value.roleAgents = { planner: 'Bad Agent' } }]
  ]

  for (const landingBar of ['files-on-disk', 'committed-local-branch', 'pushed-ref', 'hosted-review', 'merged'] as const) {
    expect(contractProblems({ ...validPayload(), landingBar }), `landing bar ${landingBar}`).toEqual([])
  }

  expect(contractProblems({ ...validPayload(), writeTerritory: ['**'] })).toEqual([])
  expect(territoryProblems(['**', 'src/**'])).toEqual([])
  expect(contractProblems({ ...validPayload(), writeTerritory: ['.gitignore'] })).toEqual([])
  expect(territoryProblems(null).some((problem) => problem.startsWith('territory-invalid:'))).toBe(true)

  for (const [description, code, mutate] of invalid) {
    const candidate = validPayload()
    mutate(candidate)
    const problems = contractProblems(candidate)
    expect(problems.some((problem) => problem.startsWith(`${code}:`)), description).toBe(true)
  }
  expect(contractProblems(validPayload(), 'claude').some((problem) => problem.startsWith('owner-unsupported:'))).toBe(true)
})
test('folder enrollment accepts files-on-disk and refuses every Git-dependent bar', async () => {
  const folders = [
    { id: 'folder-project-wt', repoId: 'folder-project', path: '/registered/folder-project', kind: 'folder' as const, branch: null, headSha: null },
    { id: 'group-folder-wt', repoId: 'group:team', path: '/registered/group-folder', kind: 'folder' as const, branch: null, headSha: null }
  ]
  for (const workspace of folders) {
    const calls: Array<[string, Record<string, unknown>]> = []
    const resolved = await resolveWorkspace(async (method, params) => {
      calls.push([method, params])
      if (method === 'quirky.worktree/resolve') return workspace
      throw new Error(`unexpected method ${method}`)
    }, `id:${workspace.id}`)
    expect(resolved).toEqual(workspace)
    expect(calls).toEqual([['quirky.worktree/resolve', { selector: `id:${workspace.id}` }]])
  }
})

test('resolves active to the single window\'s selected worktree and refuses otherwise', async () => {
  const resolved = { id: 'wt1', repoId: 'repo1', path: '/repo', kind: 'git' as const, branch: 'main' }
  const activeCalls: Array<[string, Record<string, unknown>]> = []
  const active = await resolveWorkspace(async (method, params) => {
    activeCalls.push([method, params])
    if (method === 'ui.state') return { windows: [{ connId: 7 }] }
    if (method === 'ui.window.state') return { connId: 7, layout: { worktree: 'wt1' } }
    if (method === 'quirky.worktree/resolve') return resolved
    throw new Error(`unexpected method ${method}`)
  }, 'active')
  expect(active).toEqual(resolved)
  expect(activeCalls).toEqual([
    ['ui.state', {}],
    ['ui.window.state', { connId: 7 }],
    ['quirky.worktree/resolve', { selector: 'id:wt1' }]
  ])

  const selectorCalls: Array<[string, Record<string, unknown>]> = []
  await resolveWorkspace(async (method, params) => {
    selectorCalls.push([method, params])
    if (method === 'quirky.worktree/resolve') return resolved
    throw new Error(`unexpected method ${method}`)
  }, 'id:wt1')
  expect(selectorCalls).toEqual([['quirky.worktree/resolve', { selector: 'id:wt1' }]])

  const unresolved = [
    { label: 'zero windows', state: { windows: [] } },
    { label: 'multiple windows', state: { windows: [{ connId: 7 }, { connId: 8 }] } },
    { label: 'null selected worktree', state: { windows: [{ connId: 7 }] }, selected: { connId: 7, layout: { worktree: null } } }
  ]
  for (const scenario of unresolved) {
    const call = async (method: string, _params: Record<string, unknown>): Promise<unknown> => {
      if (method === 'ui.state') return scenario.state
      if (method === 'ui.window.state') return scenario.selected
      throw new Error(`unexpected method ${method}`)
    }
    await expect(resolveWorkspace(call, 'active')).rejects.toThrow(/worktree-unresolved.*--worktree/)
  }

  for (const malformed of [
    null,
    { id: 'replacement', repoId: 'repo1', path: '/repo', kind: 'git' },
    { id: 'wt1', repoId: 'repo1', path: 'relative/path', kind: 'git' },
    { id: 'wt1', repoId: 'repo1', path: '/repo/../repo', kind: 'folder' }
  ]) {
    await expect(resolveWorkspace(async (method) => {
      if (method === 'quirky.worktree/resolve') return malformed
      throw new Error(`unexpected method ${method}`)
    }, 'id:wt1')).rejects.toThrow(/worktree-unresolved/)
  }
  await expect(resolveWorkspace(async (method) => {
    if (method === 'quirky.worktree/resolve') throw new Error('not found')
    throw new Error(`unexpected method ${method}`)
  }, 'id:missing')).rejects.toThrow(/worktree-unresolved/)
})
