import { bootHosting, type HostingTest, type HostingTestOptions } from '../../quirky.hosting/test/helpers'

/** Real daemon/client/CLI/hosting transport; only gh itself is the test's stateful upstream fixture. */
export async function bootReviews(ghSource: string, options: HostingTestOptions = {}): Promise<HostingTest> {
  const host = await bootHosting(ghSource, {
    ...options,
    extraBuiltins: [...new Set(['quirky.reviews', 'quirky.tasks', 'quirky.git', 'quirky.agents', 'quirky.session', 'quirky.terminal', ...options.extraBuiltins ?? []])]
  })
  const description = await host.client.call('api.describe', {}).catch(async (error: unknown) => { await host.cleanup(); throw error })
  const scoped = new Set(description.methods.filter((method) => method.params.properties?.worktree !== undefined).map((method) => method.name))
  return {
    ...host,
    call(name, params = {}) {
      const method = name.includes('/') || name.includes('.') ? name : `quirky.reviews/${name}`
      return host.client.callAny(method, scoped.has(method) ? { worktree: host.worktree, ...params } : params)
    }
  }
}
