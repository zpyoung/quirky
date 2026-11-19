/**
 * Shapes the redesigning-features scripts share with each other and with the files they read and
 * write in a feature's spec folder (goals.json, scores/*.json, comparison-data.json). Types only:
 * every script in scripts/redesign imports its input and output types from here.
 */

export type Theme = 'dark' | 'light'

export type GoalTag = 'fixture' | 'real-app'

/** One user goal replayed before and after the redesign. goals.json is `Goal[]`, ids g1, g2, ... */
export type Goal = { id: string; title: string; tag: GoalTag }

export type SpecFolderStatus = {
  checkout: 'main' | 'worktree'
  branch: string
  folder: string
  exists: boolean
  files: Record<
    'current-state.md' | 'goals.json' | 'seed.sh' | 'logic.md' | 'tech.md' | 'comparison.md',
    boolean
  >
  resumeAt: 'before-pass' | 'brainstorm' | 'build' | 'done'
}

export type Surface = { id: string; kind: string; title: string; scoreable: boolean }

export type SurfaceCandidate = {
  pluginId: string
  pluginName: string
  score: number
  alsoPlugins: string[]
  surfaces: Surface[]
}

export type SurfaceResolution = {
  query: string
  status: 'one' | 'many' | 'none'
  candidates: SurfaceCandidate[]
}

/**
 * A running fixture daemon. `repos.worktrees` maps worktree name (`ui-review-ready`,
 * `ui-review-notes`) to path; `repos.projects` maps project name (`ui-review-fixture`,
 * `harbor-api`, `ledger-web`) to path; `repos.primary` is the primary worktree path.
 */
export type FixtureInfo = {
  url: string
  port: number
  home: string
  pid: number
  repos: {
    primary: string
    worktrees: Record<string, string>
    projects: Record<string, string>
  }
}

export type SurfaceScore = {
  id: string
  plugin: string
  dark: number | null
  light: number | null
}

/** Contents of scores/before.json and scores/after.json, copied out of `score.ts run`'s output. */
export type Scores = {
  createdAt: string
  plugins: string[]
  reportPath: string
  surfaces: SurfaceScore[]
}

export type GateRow = {
  id: string
  before: { dark: number | null; light: number | null } | null
  after: { dark: number | null; light: number | null } | null
  result: 'clears' | 'fails' | 'new' | 'removed'
  reasons: string[]
}

export type GateReport = { passed: boolean; floor: number; rows: GateRow[] }

export type GoalOutcome = {
  id: string
  title: string
  tag: GoalTag
  /** Screenshot paths relative to the spec folder. */
  before: string | null
  after: string | null
  result: 'replayed' | 'failed' | 'cut' | 'not-replayed'
  /** Required unless `result` is `replayed`. */
  reason?: string
}

export type Capability = {
  name: string
  decision: 'kept' | 'moved' | 'cut'
  where?: string
  reason?: string
}

/** Contents of comparison-data.json, committed beside comparison.md so the page can be rebuilt. */
export type ComparisonData = {
  feature: string
  failures: string[]
  goals: GoalOutcome[]
  gate: GateReport
  capabilities: Capability[]
}
