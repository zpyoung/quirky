import { describe, expect, it } from 'vitest'
import { buildImportPlan, namesRemovedProvider, rewriteManagedPath, unlistedDomains } from './plan'

const userDataPath = '/quirky-user-data'
const homeDir = '/home/owner'

function planFor(
  source: Record<string, unknown>,
  known: Record<string, string[]> = {},
  plaintext = new Map<'settings.httpProxyUrl', string>()
) {
  return buildImportPlan({
    source,
    known: (domain) => new Set(known[domain] ?? []),
    plaintextSecrets: plaintext,
    userDataPath,
    homeDir
  })
}

const repo = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  path: `/work/${id}`,
  displayName: id,
  badgeColor: '#000',
  addedAt: 1,
  ...extra
})

describe('import mapping', () => {
  it('copies the listed domains and transforms settings', () => {
    const plan = planFor({
      repos: [repo('r1')],
      worktreeMeta: { 'r1::/w/one': { displayName: 'one' } },
      sshTargets: [{ id: 's1', label: 'box', host: 'box.test', port: 22, username: 'me' }],
      settings: {
        theme: 'dark',
        workspaceDir: '/Users/owner/orca/workspaces',
        httpProxyUrl: 'AAAA',
        claudeManagedAccounts: [
          {
            id: 'a1',
            email: 'a@b.c',
            managedAuthPath: '/src/orca/claude-accounts/a1',
            wslLinuxAuthPath: '/home/x/.claude',
            authMethod: 'unknown'
          }
        ]
      },
      automations: [
        {
          id: 'auto1',
          name: 'n',
          prompt: 'p',
          projectId: 'r1',
          enabled: true
        }
      ]
    })
    expect(plan.repos.map((entry) => entry.id)).toEqual(['r1'])
    expect(plan.worktreeMeta.map((entry) => entry.id)).toEqual(['r1::/w/one'])
    expect(plan.sshTargets.map((entry) => entry.id)).toEqual(['s1'])
    expect(plan.settings).toMatchObject({
      theme: 'dark',
      workspaceDir: '/home/owner/quirky/workspaces'
    })
    expect(plan.settings).not.toHaveProperty('httpProxyUrl')
    expect(plan.claudeAccounts).toHaveLength(1)
    expect(plan.claudeAccounts[0]).toMatchObject({
      managedAuthPath: '/quirky-user-data/claude-accounts/a1'
    })
    expect(plan.claudeAccounts[0]).not.toHaveProperty('wslLinuxAuthPath')
    expect(plan.automations.map((entry) => entry.id)).toEqual(['auto1'])
  })

  it('does not copy runtime domains and lists unknown ones by name', () => {
    const source = {
      schemaVersion: 1,
      repos: [],
      workspaceSession: { tabsByWorktree: {} },
      githubCache: {},
      automationRuns: [{ id: 'run' }],
      orcadMigrationReceipts: [],
      someFutureDomain: { a: 1 },
      anotherNewDomain: []
    }
    expect(unlistedDomains(source)).toEqual(['anotherNewDomain', 'someFutureDomain'])
    expect(planFor(source).notImported).toEqual(['anotherNewDomain', 'someFutureDomain'])
  })

  it('normalizes away items that name a removed provider or host kind', () => {
    const plan = planFor({
      repos: [
        repo('keep'),
        repo('wsl-repo', { wslDistro: 'Ubuntu' }),
        repo('bb', { provider: 'bitbucket' })
      ],
      worktreeMeta: {
        'keep::/w/a': { displayName: 'a' },
        'wsl-repo::/w/b': { displayName: 'b' }
      },
      automations: [{ id: 'x', name: 'n', prompt: 'p', projectId: 'wsl-repo' }],
      settings: { theme: 'light', azureDevOpsToken: 'x', gitea: { url: 'u' } }
    })
    expect(plan.repos.map((entry) => entry.id)).toEqual(['keep'])
    expect(plan.worktreeMeta.map((entry) => entry.id)).toEqual(['keep::/w/a'])
    expect(plan.automations).toEqual([])
    expect(plan.settings).toMatchObject({ theme: 'light' })
    expect(plan.settings).not.toHaveProperty('azureDevOpsToken')
    expect(plan.settings).not.toHaveProperty('gitea')
    expect(plan.normalizedAway.repos).toBe(2)
    expect(plan.normalizedAway.settings).toBe(2)
  })

  it('skips ids already known and leaves settings alone once imported', () => {
    const plan = planFor(
      { repos: [repo('old'), repo('new')], settings: { theme: 'dark' }, ui: { a: 1 } },
      { repos: ['old'], settings: ['settings'], ui: ['ui'] }
    )
    expect(plan.repos.map((entry) => entry.id)).toEqual(['new'])
    expect(plan.settings).toBeNull()
    expect(plan.ui).toBeNull()
  })

  it('rewrites managed paths into userData and detects removed names', () => {
    expect(rewriteManagedPath('/a/orca/codex-accounts/c1/home', '/u')).toBe(
      '/u/codex-accounts/c1/home'
    )
    expect(rewriteManagedPath('/elsewhere/auth', '/u')).toBeNull()
    expect(namesRemovedProvider({ wslDistro: null })).toBe(false)
    expect(namesRemovedProvider({ executionHostId: 'wsl:Ubuntu' })).toBe(true)
  })
})
