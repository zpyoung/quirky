import type { ActivityThread } from './activity-types'

export type DashboardBucket = 'attention' | 'working' | 'done' | 'idle'
export type DashboardQuery = {
  text?: string
  project?: string
  workspaceStatus?: string
  reviewStatus?: string
  showIdle?: boolean
}
export type DashboardCard = { thread: ActivityThread; bucket: DashboardBucket }
/** Total includes hidden idle cards; acknowledgment never reclassifies a completion as idle. */
export type DashboardSnapshot = {
  cards: DashboardCard[]
  total: number
  hiddenIdle: number
  unavailable: string[]
}
