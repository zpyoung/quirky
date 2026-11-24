import { execFileSync } from 'node:child_process'
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from '../helpers/quirky-app'
import { waitForSessionReady } from '../helpers/store'
import type { Page } from '@stablyai/playwright-test'

const tempRoots: string[] = []

function initializeGitRepo(repoPath: string): void {
  mkdirSync(repoPath, { recursive: true })
  execFileSync('git', ['init'], { cwd: repoPath, stdio: 'pipe' })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], {
    cwd: repoPath,
    stdio: 'pipe'
  })
  execFileSync('git', ['config', 'user.name', 'E2E Test'], { cwd: repoPath, stdio: 'pipe' })
  writeFileSync(path.join(repoPath, 'README.md'), `# ${path.basename(repoPath)}\n`)
  execFileSync('git', ['add', 'README.md'], { cwd: repoPath, stdio: 'pipe' })
  execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: repoPath, stdio: 'pipe' })
}

function addSecondaryWorktree(repoPath: string, branch: string): void {
  const worktreePath = path.join(repoPath, '..', `${path.basename(repoPath)}-${branch}`)
  execFileSync('git', ['worktree', 'add', worktreePath, '-b', branch], {
    cwd: repoPath,
    stdio: 'pipe'
  })
}

type RepoFixtureSpec = { name: string; secondaryBranch?: string }
type SeededRepoPath = { path: string; expectedWorktreeCount: number }

// Why: a repo needs >=2 worktrees before the sidebar's own reorder-drag gate
// (rects.length > 1) lets a pointer drag start on any of its worktree rows.
async function createRepoFixture(specs: readonly RepoFixtureSpec[]): Promise<SeededRepoPath[]> {
  const root = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'quirky-e2e-cross-repo-group-')))
  tempRoots.push(root)
  return specs.map((spec) => {
    const repoPath = path.join(root, spec.name)
    initializeGitRepo(repoPath)
    if (spec.secondaryBranch) {
      addSecondaryWorktree(repoPath, spec.secondaryBranch)
    }
    return { path: repoPath, expectedWorktreeCount: spec.secondaryBranch ? 2 : 1 }
  })
}

async function createFolderBackedWorkspaceFixture(): Promise<{
  parentPath: string
  folderPath: string
}> {
  const parentPath = realpathSync(
    await mkdtemp(path.join(os.tmpdir(), 'quirky-e2e-folder-workspace-'))
  )
  tempRoots.push(parentPath)
  const folderPath = path.join(parentPath, 'task-alpha')
  mkdirSync(folderPath, { recursive: true })
  return { parentPath, folderPath }
}

test.afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

type SeededRepo = {
  repoId: string
  mainWorktreeId: string
  secondaryWorktreeId: string | null
}

async function seedRepos(page: Page, repos: readonly SeededRepoPath[]): Promise<SeededRepo[]> {
  return page.evaluate(async (repos) => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    const state = store.getState()
    state.setActiveView('terminal')
    state.setSidebarOpen(true)
    state.setGroupBy('repo')
    state.setProjectOrderBy('manual')

    for (const repo of repos) {
      await window.api.repos.add({ path: repo.path })
    }

    // Why: repos.add's repos:changed echo can race the renderer's own
    // fetchRepos() (#7020), leaving the store transiently missing a seeded
    // repo. Re-fetch until every seeded repo is present rather than racing.
    const findSeededRepos = () =>
      repos.map((repo) => store.getState().repos.find((candidate) => candidate.path === repo.path))
    let foundRepos = findSeededRepos()
    const repoDeadline = Date.now() + 10_000
    while (foundRepos.some((repo) => !repo) && Date.now() < repoDeadline) {
      await state.fetchRepos({ runtimeEnvironmentId: null, throwOnError: true })
      foundRepos = findSeededRepos()
      if (foundRepos.every((repo) => repo)) {
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }

    const results: SeededRepo[] = []
    for (const [index, repoSpec] of repos.entries()) {
      const repo = foundRepos[index]
      if (!repo) {
        throw new Error(`Expected repo to be loaded: ${repoSpec.path}`)
      }
      // Why: worktrees that already exist when a repo is added are detected as
      // hidden externals, and only the UI add-project handoff reveals them
      // (openProjectDefaultCheckout). repos.add() skips that, so mirror its
      // reveal here or the secondary worktree never reaches worktreesByRepo.
      if (repoSpec.expectedWorktreeCount > 1) {
        await store.getState().updateRepo(repo.id, { externalWorktreeVisibility: 'show' })
      }

      let worktrees = store.getState().worktreesByRepo[repo.id] ?? []
      const worktreeDeadline = Date.now() + 10_000
      while (worktrees.length < repoSpec.expectedWorktreeCount && Date.now() < worktreeDeadline) {
        await store.getState().fetchWorktrees(repo.id, { requireAuthoritative: true })
        worktrees = store.getState().worktreesByRepo[repo.id] ?? []
        if (worktrees.length >= repoSpec.expectedWorktreeCount) {
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      const main = worktrees.find((worktree) => worktree.isMainWorktree)
      const secondary = worktrees.find((worktree) => !worktree.isMainWorktree) ?? null
      if (!main) {
        throw new Error(`Expected main worktree for repo: ${repoSpec.path}`)
      }
      // Why: without this, a missing secondary silently becomes null and
      // surfaces far downstream as a parseWorkspaceKey(null) crash.
      if (repoSpec.expectedWorktreeCount > 1 && !secondary) {
        const seen = worktrees.map((worktree) => worktree.path).join(', ')
        throw new Error(
          `Expected a secondary worktree for repo ${repoSpec.path}, saw ${worktrees.length}: ${seen}`
        )
      }
      results.push({
        repoId: repo.id,
        mainWorktreeId: main.id,
        secondaryWorktreeId: secondary ? secondary.id : null
      })
    }
    return results
  }, repos)
}

async function createProjectGroup(page: Page, name: string): Promise<string> {
  return page.evaluate(async (name) => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    const group = await store.getState().createProjectGroup(name, 'local')
    if (!group) {
      throw new Error(`Failed to create project group: ${name}`)
    }
    return group.id
  }, name)
}

async function setWorktreeProjectGroup(
  page: Page,
  worktreeId: string,
  groupId: string | null
): Promise<void> {
  await page.evaluate(
    async (args) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      await store.getState().updateWorktreeMeta(args.worktreeId, { projectGroupId: args.groupId })
    },
    { worktreeId, groupId }
  )
}

async function seedFolderWorkspace(
  page: Page,
  args: { parentPath: string; folderPath: string; groupName: string; workspaceName: string }
): Promise<{ groupId: string; folderWorktreeId: string }> {
  return page.evaluate(async (args) => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    store.getState().setGroupBy('repo')
    const group = await window.api.projectGroups.create({
      name: args.groupName,
      parentPath: args.parentPath
    })
    await store.getState().fetchProjectGroups({ runtimeEnvironmentId: null, throwOnError: true })
    const workspace = await window.api.folderWorkspaces.create({
      projectGroupId: group.id,
      name: args.workspaceName,
      folderPath: args.folderPath
    })
    await store.getState().fetchFolderWorkspaces({ runtimeEnvironmentId: null, throwOnError: true })
    return { groupId: group.id, folderWorktreeId: `folder:${workspace.id}` }
  }, args)
}

type SidebarHeaderMarker = { kind: 'repo-header' | 'group-header'; id: string }
type SidebarRowMarker = SidebarHeaderMarker | { kind: 'worktree'; id: string }

// Why: reads the same top-to-bottom visual order a user sees, rather than
// store internals, so section-membership assertions track the render tree.
async function getSidebarRowMarkers(page: Page): Promise<SidebarRowMarker[]> {
  const rows = await page
    .locator('[data-worktree-sidebar] [data-worktree-virtual-row]')
    .evaluateAll((elements) =>
      elements.map((element) => ({
        top: element.getBoundingClientRect().top,
        repoHeaderId:
          element.getAttribute('data-repo-header-id') ??
          element.querySelector('[data-repo-header-id]')?.getAttribute('data-repo-header-id') ??
          null,
        groupHeaderId:
          element.getAttribute('data-project-group-header-id') ??
          element
            .querySelector('[data-project-group-header-id]')
            ?.getAttribute('data-project-group-header-id') ??
          null,
        worktreeId:
          element.getAttribute('data-worktree-id') ??
          element.querySelector('[data-worktree-id]')?.getAttribute('data-worktree-id') ??
          null
      }))
    )
  const markers: (SidebarRowMarker & { top: number })[] = []
  for (const row of rows) {
    if (row.repoHeaderId) {
      markers.push({ kind: 'repo-header', id: row.repoHeaderId, top: row.top })
    } else if (row.groupHeaderId) {
      markers.push({ kind: 'group-header', id: row.groupHeaderId, top: row.top })
    } else if (row.worktreeId) {
      markers.push({ kind: 'worktree', id: row.worktreeId, top: row.top })
    }
  }
  return markers.sort((a, b) => a.top - b.top)
}

function findNearestHeaderAbove(
  markers: readonly SidebarRowMarker[],
  worktreeId: string
): SidebarHeaderMarker | null {
  const index = markers.findIndex(
    (marker) => marker.kind === 'worktree' && marker.id === worktreeId
  )
  if (index === -1) {
    return null
  }
  for (let i = index - 1; i >= 0; i -= 1) {
    const marker = markers[i]!
    if (marker.kind !== 'worktree') {
      return { kind: marker.kind, id: marker.id }
    }
  }
  return null
}

function countWorktreeRowsUnderHeader(
  markers: readonly SidebarRowMarker[],
  header: SidebarHeaderMarker
): number {
  const index = markers.findIndex(
    (marker) => marker.kind === header.kind && marker.id === header.id
  )
  if (index === -1) {
    return -1
  }
  let count = 0
  for (let i = index + 1; i < markers.length && markers[i]!.kind === 'worktree'; i += 1) {
    count += 1
  }
  return count
}

// Why: a repo header can sit anywhere inside its enclosing group's contiguous
// block; this walks forward from the group header until the next group
// header (a sibling section) instead of assuming direct adjacency.
function isRepoUnderGroupSection(
  markers: readonly SidebarRowMarker[],
  groupId: string,
  repoId: string
): boolean {
  const startIndex = markers.findIndex(
    (marker) => marker.kind === 'group-header' && marker.id === groupId
  )
  if (startIndex === -1) {
    return false
  }
  for (let i = startIndex + 1; i < markers.length; i += 1) {
    const marker = markers[i]!
    if (marker.kind === 'group-header') {
      break
    }
    if (marker.kind === 'repo-header' && marker.id === repoId) {
      return true
    }
  }
  return false
}

async function openWorktreeContextMenu(page: Page, worktreeId: string): Promise<void> {
  const row = page.locator(`[data-worktree-id="${worktreeId}"]`).first()
  await row.scrollIntoViewIfNeeded()
  await row.click({ button: 'right' })
}

async function chooseFromSubmenu(page: Page, triggerName: string, itemName: string): Promise<void> {
  const trigger = page.getByRole('menuitem', { name: triggerName, exact: true })
  await trigger.hover()
  await trigger.click()
  const item = page.getByRole('menuitem', { name: itemName, exact: true })
  await expect(item).toBeVisible()
  await item.click()
}

async function addWorktreeToGroupViaMenu(
  page: Page,
  worktreeId: string,
  groupName: string
): Promise<void> {
  await openWorktreeContextMenu(page, worktreeId)
  await chooseFromSubmenu(page, 'Add worktree to group', groupName)
}

async function createGroupFromWorktreeViaMenu(
  page: Page,
  worktreeId: string,
  groupName: string
): Promise<string> {
  await openWorktreeContextMenu(page, worktreeId)
  await page.getByRole('menuitem', { name: 'New group from worktree', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'New Project Group', exact: true })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('textbox', { name: 'Group Name', exact: true }).fill(groupName)
  await dialog.getByRole('button', { name: 'Create', exact: true }).click()
  // Why: the dialog only closes once the underlying createProjectGroup +
  // updateWorktreeMeta awaits resolve, so this is also the store-settled gate.
  await expect(dialog).toBeHidden()
  return page.evaluate(async (name) => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    const findGroup = () =>
      store.getState().projectGroups.find((candidate) => candidate.name === name)
    let group = findGroup()
    const deadline = Date.now() + 10_000
    while (!group && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      group = findGroup()
    }
    if (!group) {
      throw new Error(`Expected project group to exist: ${name}`)
    }
    return group.id
  }, groupName)
}

async function removeWorktreeFromGroupViaMenu(page: Page, worktreeId: string): Promise<void> {
  await openWorktreeContextMenu(page, worktreeId)
  await page.getByRole('menuitem', { name: 'Remove worktree from group', exact: true }).click()
}

async function moveRepoToGroupViaMenu(
  page: Page,
  anyWorktreeIdOfRepo: string,
  groupName: string
): Promise<void> {
  await openWorktreeContextMenu(page, anyWorktreeIdOfRepo)
  // Why: the worktree row's repo-scoped items name their scope, so this is
  // "Move project to group" — the project header keeps the unqualified label.
  await chooseFromSubmenu(page, 'Move project to group', groupName)
}

async function deleteProjectGroupViaMenu(
  page: Page,
  args: { groupId: string; groupName: string }
): Promise<void> {
  // Why: the actions button is opacity-0/max-w-0 until group-hover
  // (REPO_HEADER_ACTION_REVEAL_CLASS), so hover the header row to reveal it.
  await page.locator(`[data-project-group-header-id="${args.groupId}"]`).hover()
  // Why: exact — the group header row itself is a button whose accessible name
  // contains the group name, so a substring match is ambiguous.
  await page
    .getByRole('button', { name: `Group actions for ${args.groupName}`, exact: true })
    .click()
  await page.getByRole('menuitem', { name: 'Delete group', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: /Delete Project Group/i })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Delete Group', exact: true }).click()
  await expect(dialog).toBeHidden()
}

async function dragWorktreeOntoHeader(args: {
  page: Page
  worktreeId: string
  targetSelector: string
}): Promise<void> {
  const source = args.page.locator(`[data-worktree-id="${args.worktreeId}"]`).first()
  const target = args.page.locator(args.targetSelector)
  await source.scrollIntoViewIfNeeded()
  await target.scrollIntoViewIfNeeded()
  const sourceBox = await source.boundingBox()
  const targetBox = await target.boundingBox()
  if (!sourceBox || !targetBox) {
    throw new Error('Worktree drag bounding box was not available')
  }
  await args.page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2)
  await args.page.mouse.down()
  await args.page.mouse.move(
    targetBox.x + targetBox.width / 2,
    targetBox.y + targetBox.height / 2,
    {
      steps: 8
    }
  )
  await args.page.mouse.up()
}

test.describe('Cross-repo worktree groups', () => {
  test('does not offer group-membership actions on a folder-workspace row', async ({
    quirkyPage
  }) => {
    await waitForSessionReady(quirkyPage)
    const { parentPath, folderPath } = await createFolderBackedWorkspaceFixture()
    const { folderWorktreeId } = await seedFolderWorkspace(quirkyPage, {
      parentPath,
      folderPath,
      groupName: 'E2E XRepo Folder Group',
      workspaceName: 'E2E XRepo Folder Task'
    })

    await expect(quirkyPage.locator(`[data-worktree-id="${folderWorktreeId}"]`)).toBeVisible({
      timeout: 10_000
    })
    await openWorktreeContextMenu(quirkyPage, folderWorktreeId)

    // Sanity: the menu actually opened, so the absence below is the gate — not a no-op menu.
    await expect(quirkyPage.getByRole('menuitem', { name: 'Copy Path', exact: true })).toBeVisible()
    await expect(
      quirkyPage.getByRole('menuitem', { name: 'Add worktree to group', exact: true })
    ).toHaveCount(0)
    await expect(
      quirkyPage.getByRole('menuitem', { name: 'Remove worktree from group', exact: true })
    ).toHaveCount(0)
  })

  test('adding a worktree to a group via the context menu moves it out of its repo section', async ({
    quirkyPage
  }) => {
    await waitForSessionReady(quirkyPage)
    const [repo] = await createRepoFixture([
      { name: 'e2e-xrepo-alpha', secondaryBranch: 'feature-a' }
    ])
    const [{ repoId, mainWorktreeId, secondaryWorktreeId }] = await seedRepos(quirkyPage, [repo!])
    const secondaryId = secondaryWorktreeId!
    const groupName = 'E2E XRepo Group Alpha'
    const groupId = await createProjectGroup(quirkyPage, groupName)

    await expect
      .poll(
        async () => findNearestHeaderAbove(await getSidebarRowMarkers(quirkyPage), secondaryId),
        {
          timeout: 10_000
        }
      )
      .toEqual({ kind: 'repo-header', id: repoId })

    // Under its repo header the row needs no origin cue; the header supplies it.
    const originChip = quirkyPage.locator(
      `[data-worktree-id="${secondaryId}"] [aria-label^="Project "]`
    )
    await expect(originChip).toHaveCount(0)

    await addWorktreeToGroupViaMenu(quirkyPage, secondaryId, groupName)

    await expect
      .poll(
        async () => findNearestHeaderAbove(await getSidebarRowMarkers(quirkyPage), secondaryId),
        {
          timeout: 10_000
        }
      )
      .toEqual({ kind: 'group-header', id: groupId })

    await expect(originChip).toHaveCount(1)

    await expect(quirkyPage.locator(`[data-repo-header-id="${repoId}"]`)).toBeVisible()
    await expect
      .poll(
        async () => findNearestHeaderAbove(await getSidebarRowMarkers(quirkyPage), mainWorktreeId),
        { timeout: 10_000 }
      )
      .toEqual({ kind: 'repo-header', id: repoId })
  })

  test('deleting a group releases its worktree back to its repo without destroying it', async ({
    quirkyPage
  }) => {
    await waitForSessionReady(quirkyPage)
    const [repo] = await createRepoFixture([
      { name: 'e2e-xrepo-bravo', secondaryBranch: 'feature-b' }
    ])
    const [{ repoId, secondaryWorktreeId }] = await seedRepos(quirkyPage, [repo!])
    const secondaryId = secondaryWorktreeId!
    const groupName = 'E2E XRepo Group Bravo'
    const groupId = await createProjectGroup(quirkyPage, groupName)
    await setWorktreeProjectGroup(quirkyPage, secondaryId, groupId)

    await expect
      .poll(
        async () => findNearestHeaderAbove(await getSidebarRowMarkers(quirkyPage), secondaryId),
        {
          timeout: 10_000
        }
      )
      .toEqual({ kind: 'group-header', id: groupId })

    await deleteProjectGroupViaMenu(quirkyPage, { groupId, groupName })

    await expect(quirkyPage.locator(`[data-project-group-header-id="${groupId}"]`)).toHaveCount(0)
    await expect(quirkyPage.locator(`[data-worktree-id="${secondaryId}"]`)).toBeVisible()
    await expect
      .poll(
        async () => findNearestHeaderAbove(await getSidebarRowMarkers(quirkyPage), secondaryId),
        {
          timeout: 10_000
        }
      )
      .toEqual({ kind: 'repo-header', id: repoId })
  })

  test("grouping away a repo's only worktree leaves an empty placeholder for the repo", async ({
    quirkyPage
  }) => {
    await waitForSessionReady(quirkyPage)
    const [repo] = await createRepoFixture([{ name: 'e2e-xrepo-charlie' }])
    const [{ repoId, mainWorktreeId }] = await seedRepos(quirkyPage, [repo!])
    const groupId = await createProjectGroup(quirkyPage, 'E2E XRepo Group Charlie')

    await expect
      .poll(
        async () =>
          countWorktreeRowsUnderHeader(await getSidebarRowMarkers(quirkyPage), {
            kind: 'repo-header',
            id: repoId
          }),
        { timeout: 10_000 }
      )
      .toBe(1)

    await setWorktreeProjectGroup(quirkyPage, mainWorktreeId, groupId)

    await expect(quirkyPage.locator(`[data-repo-header-id="${repoId}"]`)).toBeVisible()
    await expect
      .poll(
        async () =>
          countWorktreeRowsUnderHeader(await getSidebarRowMarkers(quirkyPage), {
            kind: 'repo-header',
            id: repoId
          }),
        { timeout: 10_000 }
      )
      .toBe(0)
    await expect
      .poll(
        async () => findNearestHeaderAbove(await getSidebarRowMarkers(quirkyPage), mainWorktreeId),
        { timeout: 10_000 }
      )
      .toEqual({ kind: 'group-header', id: groupId })
  })

  test('moving a repo to a different group does not move a worktree already grouped independently', async ({
    quirkyPage
  }) => {
    await waitForSessionReady(quirkyPage)
    const [repo] = await createRepoFixture([
      { name: 'e2e-xrepo-delta', secondaryBranch: 'feature-d' }
    ])
    const [{ repoId, mainWorktreeId, secondaryWorktreeId }] = await seedRepos(quirkyPage, [repo!])
    const secondaryId = secondaryWorktreeId!
    const groupBName = 'E2E XRepo Group B'
    const groupBId = await createProjectGroup(quirkyPage, groupBName)
    const groupCId = await createProjectGroup(quirkyPage, 'E2E XRepo Group C')
    await setWorktreeProjectGroup(quirkyPage, secondaryId, groupCId)

    await expect
      .poll(
        async () =>
          isRepoUnderGroupSection(await getSidebarRowMarkers(quirkyPage), groupBId, repoId),
        { timeout: 10_000 }
      )
      .toBe(false)

    await moveRepoToGroupViaMenu(quirkyPage, mainWorktreeId, groupBName)

    await expect
      .poll(
        async () =>
          isRepoUnderGroupSection(await getSidebarRowMarkers(quirkyPage), groupBId, repoId),
        { timeout: 10_000 }
      )
      .toBe(true)
    await expect
      .poll(
        async () => findNearestHeaderAbove(await getSidebarRowMarkers(quirkyPage), secondaryId),
        {
          timeout: 10_000
        }
      )
      .toEqual({ kind: 'group-header', id: groupCId })
  })

  test('removing a worktree from its group via the context menu returns it to its repo section', async ({
    quirkyPage
  }) => {
    await waitForSessionReady(quirkyPage)
    const [repo] = await createRepoFixture([
      { name: 'e2e-xrepo-echo', secondaryBranch: 'feature-e' }
    ])
    const [{ repoId, secondaryWorktreeId }] = await seedRepos(quirkyPage, [repo!])
    const secondaryId = secondaryWorktreeId!
    const groupId = await createProjectGroup(quirkyPage, 'E2E XRepo Group Echo')
    await setWorktreeProjectGroup(quirkyPage, secondaryId, groupId)

    await expect
      .poll(
        async () => findNearestHeaderAbove(await getSidebarRowMarkers(quirkyPage), secondaryId),
        {
          timeout: 10_000
        }
      )
      .toEqual({ kind: 'group-header', id: groupId })

    await removeWorktreeFromGroupViaMenu(quirkyPage, secondaryId)

    await expect
      .poll(
        async () => findNearestHeaderAbove(await getSidebarRowMarkers(quirkyPage), secondaryId),
        {
          timeout: 10_000
        }
      )
      .toEqual({ kind: 'repo-header', id: repoId })
  })

  test('dragging a worktree onto a group header joins it, and onto its repo header releases it', async ({
    quirkyPage
  }) => {
    await waitForSessionReady(quirkyPage)
    const [repo] = await createRepoFixture([
      { name: 'e2e-xrepo-foxtrot', secondaryBranch: 'feature-f' }
    ])
    const [{ repoId, secondaryWorktreeId }] = await seedRepos(quirkyPage, [repo!])
    const secondaryId = secondaryWorktreeId!
    const groupId = await createProjectGroup(quirkyPage, 'E2E XRepo Group Foxtrot')

    await expect
      .poll(
        async () => findNearestHeaderAbove(await getSidebarRowMarkers(quirkyPage), secondaryId),
        {
          timeout: 10_000
        }
      )
      .toEqual({ kind: 'repo-header', id: repoId })

    await dragWorktreeOntoHeader({
      page: quirkyPage,
      worktreeId: secondaryId,
      targetSelector: `[data-project-group-header-id="${groupId}"]`
    })

    await expect
      .poll(
        async () => findNearestHeaderAbove(await getSidebarRowMarkers(quirkyPage), secondaryId),
        {
          timeout: 10_000
        }
      )
      .toEqual({ kind: 'group-header', id: groupId })

    await dragWorktreeOntoHeader({
      page: quirkyPage,
      worktreeId: secondaryId,
      targetSelector: `[data-repo-header-id="${repoId}"]`
    })

    await expect
      .poll(
        async () => findNearestHeaderAbove(await getSidebarRowMarkers(quirkyPage), secondaryId),
        {
          timeout: 10_000
        }
      )
      .toEqual({ kind: 'repo-header', id: repoId })
  })

  test('releasing a drag outside the sidebar does not join a group at the same height', async ({
    quirkyPage
  }) => {
    // Regression: the membership hit-test is vertical-only and pointerup is a
    // window-capture listener, so a release far to the right of the sidebar used
    // to still commit a join whenever it shared a group header's y.
    await waitForSessionReady(quirkyPage)
    const [repo] = await createRepoFixture([
      { name: 'e2e-xrepo-golf', secondaryBranch: 'feature-g' }
    ])
    const [{ repoId, secondaryWorktreeId }] = await seedRepos(quirkyPage, [repo!])
    const secondaryId = secondaryWorktreeId!
    const groupId = await createProjectGroup(quirkyPage, 'E2E XRepo Group Golf')

    await expect
      .poll(
        async () => findNearestHeaderAbove(await getSidebarRowMarkers(quirkyPage), secondaryId),
        {
          timeout: 10_000
        }
      )
      .toEqual({ kind: 'repo-header', id: repoId })

    const source = quirkyPage.locator(`[data-worktree-id="${secondaryId}"]`).first()
    const groupHeader = quirkyPage.locator(`[data-project-group-header-id="${groupId}"]`)
    await source.scrollIntoViewIfNeeded()
    await groupHeader.scrollIntoViewIfNeeded()
    const sourceBox = await source.boundingBox()
    const headerBox = await groupHeader.boundingBox()
    if (!sourceBox || !headerBox) {
      throw new Error('Worktree drag bounding box was not available')
    }
    const viewport = quirkyPage.viewportSize()
    const outsideX = Math.max(
      headerBox.x + headerBox.width + 240,
      (viewport?.width ?? headerBox.x + headerBox.width + 400) - 40
    )

    await quirkyPage.mouse.move(
      sourceBox.x + sourceBox.width / 2,
      sourceBox.y + sourceBox.height / 2
    )
    await quirkyPage.mouse.down()
    await quirkyPage.mouse.move(outsideX, headerBox.y + headerBox.height / 2, { steps: 8 })
    await quirkyPage.mouse.up()

    await expect
      .poll(
        async () => findNearestHeaderAbove(await getSidebarRowMarkers(quirkyPage), secondaryId),
        {
          timeout: 10_000
        }
      )
      .toEqual({ kind: 'repo-header', id: repoId })
  })

  test('creating a group from a worktree via the context menu does not move its repo', async ({
    quirkyPage
  }) => {
    // Regression guard: the old create action built a group from the whole
    // repo, so this worktree-scoped one must leave the sibling worktree put.
    await waitForSessionReady(quirkyPage)
    const [repo] = await createRepoFixture([
      { name: 'e2e-xrepo-hotel', secondaryBranch: 'feature-h' }
    ])
    const [{ repoId, mainWorktreeId, secondaryWorktreeId }] = await seedRepos(quirkyPage, [repo!])
    const secondaryId = secondaryWorktreeId!

    await expect
      .poll(
        async () => findNearestHeaderAbove(await getSidebarRowMarkers(quirkyPage), secondaryId),
        {
          timeout: 10_000
        }
      )
      .toEqual({ kind: 'repo-header', id: repoId })

    const groupId = await createGroupFromWorktreeViaMenu(
      quirkyPage,
      secondaryId,
      'E2E XRepo Group Hotel'
    )

    await expect
      .poll(
        async () => findNearestHeaderAbove(await getSidebarRowMarkers(quirkyPage), secondaryId),
        {
          timeout: 10_000
        }
      )
      .toEqual({ kind: 'group-header', id: groupId })

    await expect(quirkyPage.locator(`[data-repo-header-id="${repoId}"]`)).toBeVisible()
    await expect
      .poll(
        async () => findNearestHeaderAbove(await getSidebarRowMarkers(quirkyPage), mainWorktreeId),
        { timeout: 10_000 }
      )
      .toEqual({ kind: 'repo-header', id: repoId })
  })

  test("creating a group from a repo's only worktree via the context menu leaves an empty placeholder for the repo", async ({
    quirkyPage
  }) => {
    await waitForSessionReady(quirkyPage)
    const [repo] = await createRepoFixture([{ name: 'e2e-xrepo-india' }])
    const [{ repoId, mainWorktreeId }] = await seedRepos(quirkyPage, [repo!])

    await expect
      .poll(
        async () =>
          countWorktreeRowsUnderHeader(await getSidebarRowMarkers(quirkyPage), {
            kind: 'repo-header',
            id: repoId
          }),
        { timeout: 10_000 }
      )
      .toBe(1)

    const groupId = await createGroupFromWorktreeViaMenu(
      quirkyPage,
      mainWorktreeId,
      'E2E XRepo Group India'
    )

    await expect(quirkyPage.locator(`[data-repo-header-id="${repoId}"]`)).toBeVisible()
    await expect
      .poll(
        async () =>
          countWorktreeRowsUnderHeader(await getSidebarRowMarkers(quirkyPage), {
            kind: 'repo-header',
            id: repoId
          }),
        { timeout: 10_000 }
      )
      .toBe(0)
    await expect
      .poll(
        async () => findNearestHeaderAbove(await getSidebarRowMarkers(quirkyPage), mainWorktreeId),
        { timeout: 10_000 }
      )
      .toEqual({ kind: 'group-header', id: groupId })
  })

  test('a folder-workspace row with no repo offers no group-creation action', async ({
    quirkyPage
  }) => {
    await waitForSessionReady(quirkyPage)
    const { parentPath, folderPath } = await createFolderBackedWorkspaceFixture()
    const { folderWorktreeId } = await seedFolderWorkspace(quirkyPage, {
      parentPath,
      folderPath,
      groupName: 'E2E XRepo Folder Group Juliet',
      workspaceName: 'E2E XRepo Folder Task Juliet'
    })

    await expect(quirkyPage.locator(`[data-worktree-id="${folderWorktreeId}"]`)).toBeVisible({
      timeout: 10_000
    })
    await openWorktreeContextMenu(quirkyPage, folderWorktreeId)

    // Sanity: the menu actually opened, so the absence below is the gate — not a no-op menu.
    await expect(quirkyPage.getByRole('menuitem', { name: 'Copy Path', exact: true })).toBeVisible()
    await expect(
      quirkyPage.getByRole('menuitem', { name: 'New group from worktree', exact: true })
    ).toHaveCount(0)
    // Why: this fixture's folder workspace has no associated repo (a plain
    // directory, never git-initialized), so showProjectCreate's hasRepo gate
    // is also false — there is no project to move, so neither create action
    // applies (unlike a folder workspace or folder-mode repo backed by a
    // real repo, which would show the project-scoped "New group from
    // project" action instead).
    await expect(
      quirkyPage.getByRole('menuitem', { name: 'New group from project', exact: true })
    ).toHaveCount(0)
  })
})
