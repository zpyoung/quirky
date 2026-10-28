import { bootHosting, type HostingTest, type HostingTestOptions } from '../../quirky.hosting/test/helpers'

export type TasksTest = HostingTest & { repoId: string }

/** Real daemon + registered repository + isolated, stateful upstream executable. */
export async function bootTasks(ghSource: string, options: HostingTestOptions = {}): Promise<TasksTest> {
  const hosting = await bootHosting(ghSource, { ...options, extraBuiltins: ['quirky.tasks', ...(options.extraBuiltins ?? [])] })
  try {
    const worktree = await hosting.client.callAny('quirky.worktree/resolve', { selector: hosting.worktree }) as { repoId: string }
    // Reject invalid fixtures before negative-input assertions can pass on an unknown method.
    await hosting.client.callAny('quirky.tasks/state', { worktree: hosting.worktree })
    return {
      ...hosting,
      repoId: worktree.repoId,
      async call(name, params = {}) {
        const method = name.includes('/') ? name : `quirky.tasks/${name}`
        return hosting.client.callAny(method, { worktree: hosting.worktree, ...params })
      }
    }
  } catch (error) {
    await hosting.cleanup()
    throw error
  }
}
