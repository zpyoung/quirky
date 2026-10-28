export type HeaderRect = { id: string; left: number; right: number; top: number; bottom: number }

export type MembershipTarget = { kind: 'group' | 'repo'; id: string }

/** Resolves current viewport geometry, giving a group header precedence over an overlapping repo. */
export function resolveMembershipTarget(
  clientX: number,
  clientY: number,
  groups: HeaderRect[],
  repos: HeaderRect[],
  owningRepoId: string
): MembershipTarget | null {
  const contains = (header: HeaderRect) =>
    clientX >= header.left && clientX <= header.right && clientY >= header.top && clientY <= header.bottom
  const group = groups.find(contains)
  if (group) return { kind: 'group', id: group.id }
  const repo = repos.find((header) => header.id === owningRepoId && contains(header))
  return repo ? { kind: 'repo', id: repo.id } : null
}
