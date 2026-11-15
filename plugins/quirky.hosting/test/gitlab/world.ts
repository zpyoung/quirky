import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bootHosting, type HostingTest } from '../helpers'
import { startGitLab, type GitLabStandIn } from './stand-in'

export type GitLabIdentity = { host: string; owner: string; repo: string }
export type GitLabInvocation = { args: string[]; env: Record<string, string> }
export interface GitLabWorld extends HostingTest {
  server: GitLabStandIn
  identity: GitLabIdentity
  glabInvocations(): GitLabInvocation[]
}
export type BootGitLabOptions = {
  token?: string | null
  glabOutput?: string
  glabExit?: number
  branch?: string
  remote?: string
  ghSource?: string
}


export async function bootGitLab(options: BootGitLabOptions = {}): Promise<GitLabWorld> {
  const originalToken = process.env.GITLAB_TOKEN
  let standIn: GitLabStandIn | undefined
  let hosting: HostingTest | undefined
  let cleaned = false

  const restoreToken = () => {
    if (originalToken === undefined) delete process.env.GITLAB_TOKEN
    else process.env.GITLAB_TOKEN = originalToken
  }
  const cleanup = async () => {
    if (cleaned) return
    cleaned = true
    let cleanupError: unknown
    try {
      standIn?.close()
    } catch (error) {
      cleanupError = error
    }
    try {
      await hosting?.cleanup()
    } catch (error) {
      cleanupError ??= error
    } finally {
      restoreToken()
    }
    if (cleanupError !== undefined) throw cleanupError
  }

  try {
    if (options.token === undefined) process.env.GITLAB_TOKEN = 'dummy-gitlab-token'
    else if (options.token === null) delete process.env.GITLAB_TOKEN
    else process.env.GITLAB_TOKEN = options.token

    standIn = startGitLab()
    const remote = options.remote ?? `http://${standIn.host}/group/sub/proj.git`
    hosting = await bootHosting(options.ghSource ?? 'throw new Error("fake gh must not be invoked")', {
      remote,
      branch: options.branch
    })

    const invocationPath = join(hosting.root, 'glab.jsonl')
    writeFileSync(invocationPath, '')
    const glabPath = join(hosting.root, 'fakebin', 'glab')
    const glabOutput = options.glabOutput ?? ''
    const glabExit = options.glabExit ?? 0
    const glabSource = `#!/usr/bin/env bun\nimport { appendFileSync } from 'node:fs'\nconst args = process.argv.slice(2)\nconst env = Object.fromEntries(Object.entries(process.env))\nappendFileSync(${JSON.stringify(invocationPath)}, JSON.stringify({ args, env }) + '\\n')\nprocess.stdout.write(${JSON.stringify(glabOutput)})\nprocess.exitCode = ${JSON.stringify(glabExit)}\n`
    writeFileSync(glabPath, glabSource)
    chmodSync(glabPath, 0o755)

    await hosting.client.callAny('setting.set', {
      id: 'setting:quirky.hosting/gitlabHosts',
      value: `gitlab.com ${standIn.host}`
    })

    const server = standIn
    const baseHosting = hosting
    const identity: GitLabIdentity = { host: server.host, owner: 'group/sub', repo: 'proj' }
    const glabInvocations = (): GitLabInvocation[] => readFileSync(invocationPath, 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => parseInvocation(JSON.parse(line) as unknown))

    return {
      ...baseHosting,
      server,
      identity,
      glabInvocations,
      cleanup
    }
  } catch (error) {
    try {
      await cleanup()
    } catch {
      // Preserve the initialization failure after attempting every cleanup step.
    }
    throw error
  }
}

function parseInvocation(value: unknown): GitLabInvocation {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('the GitLab fixture invocation log is invalid')
  }
  const record = value as Record<string, unknown>
  if (!Array.isArray(record.args) || record.env === null || typeof record.env !== 'object' || Array.isArray(record.env)) {
    throw new Error('the GitLab fixture invocation log is invalid')
  }
  const args: string[] = []
  for (const arg of record.args) {
    if (typeof arg !== 'string') throw new Error('the GitLab fixture invocation arguments are invalid')
    args.push(arg)
  }
  const env: Record<string, string> = {}
  for (const [name, content] of Object.entries(record.env)) {
    if (typeof content !== 'string') throw new Error('the GitLab fixture invocation environment is invalid')
    env[name] = content
  }
  return { args, env }
}

