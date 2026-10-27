import { join } from 'node:path'
import type { ClientRole, QuirkyClient, Repo, Worktree } from '@quirky/protocol'
import { runCli as runCliProcess, type CliResult } from '../../../packages/cli/test/fixtures/fake-daemon'
import { makeRepo, git } from '../../quirky.repo/test/git-fixtures'
import { startPluginHarness, type PluginHarness } from '../../quirky.repo/test/harness'

const LEDGER_PLUGINS = ['quirky.repo', 'quirky.worktree', 'quirky.ledger', 'quirky.ask']

export type LedgerProject = { repo: Repo; workspace: Worktree; path: string }

export type LedgerHarness = {
  plugins: PluginHarness
  client: QuirkyClient
  home: string
  project: LedgerProject
  connectAs(role?: ClientRole, project?: LedgerProject): Promise<QuirkyClient>
  request(params: Record<string, unknown>, client?: QuirkyClient): Promise<unknown>
  operation(operation: string, params: Record<string, unknown>, client?: QuirkyClient): Promise<unknown>
  addProject(name: string, options?: { files?: Record<string, string>; origin?: string }): Promise<LedgerProject>
  runCli(args: string[], options?: { cwd?: string; env?: Record<string, string> }): Promise<CliResult>
  restart(): Promise<void>
  cleanup(): Promise<void>
}

/** A real daemon with the real owner, ledger, and confirmation plugins on isolated local git repos. */
export async function startLedgerHarness(): Promise<LedgerHarness> {
  const plugins = await startPluginHarness({ plugins: LEDGER_PLUGINS, realGit: true })
  const home = plugins.h.home

  const addProject = async (
    name: string,
    options: { files?: Record<string, string>; origin?: string } = {}
  ): Promise<LedgerProject> => {
    const path = makeRepo(join(home, 'projects', name), options.files)
    if (options.origin) git(path, 'remote', 'add', 'origin', options.origin)
    const repo = (await plugins.client.callAny('quirky.repo/add', { path })) as Repo
    const worktrees = (await plugins.client.callAny('quirky.worktree/list', { repo: repo.id })) as Worktree[]
    const workspace = worktrees.find((item) => item.path === path)
    if (!workspace) throw new Error(`missing primary worktree for ${repo.id}`)
    return { repo, workspace, path }
  }

  try {
    await plugins.client.callAny('setting.set', {
      id: 'setting:quirky.worktree/worktreesRoot',
      value: join(home, 'worktrees')
    })
    const project = await addProject('alpha', {
      files: { 'src/main.ts': 'export const answer = 42\n' },
      origin: 'https://github.com/acme/alpha.git'
    })

    const harness: LedgerHarness = {
      plugins,
      client: plugins.client,
      home,
      project,
      async connectAs(role = 'cli', currentProject = project) {
        return plugins.connectAs({ cwd: currentProject.path, worktreeId: currentProject.workspace.id }, role)
      },
      request(params, client = plugins.client) {
        return client.callAny('quirky.ledger/request', params)
      },
      operation(operationName, params, client = plugins.client) {
        return client.callAny(`quirky.ledger/${operationName}`, params)
      },
      addProject,
      runCli(args, options = {}) {
        return runCliProcess(args, {
          home,
          cwd: options.cwd ?? project.path,
          ...(options.env ? { env: options.env } : {})
        })
      },
      async restart() {
        const { client } = await plugins.restart()
        harness.client = client
      },
      async cleanup() {
        await plugins.cleanup()
      }
    }
    return harness
  } catch (error) {
    await plugins.cleanup()
    throw error
  }
}

export const workspaceTarget = (project: LedgerProject) => ({ workspaceId: project.workspace.id })
export const projectTarget = (project: LedgerProject) => ({ owner: { tier: 'project', id: project.repo.id } })
