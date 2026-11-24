/**
 * Entry point for the multi-workspace typing-latency bench
 * (tests/e2e/terminal-multi-workspace-typing-latency.spec.ts).
 *
 * Usage:
 *   pnpm bench:multi-workspace-typing [-- --panes 8 --rate-kbps 512 \
 *     --keys 48 --cadence-ms 250 --cpu-workers 4 --worktrees 870 \
 *     --repositories 27 --terminal-tabs 1410 --unified-tabs 2000 --label before-fix]
 *
 * Results land in tests/tools/benchmarks/results/multi-workspace-typing-*.json.
 * Run once per build/config with distinct --label values, then diff the
 * totalMs/inputHalfMs/echoHalfMs percentiles.
 */
import { spawn } from 'node:child_process'

const npxCommand = process.platform === 'win32' ? 'npx.cmd' : 'npx'

const knobByFlag = {
  '--visited-workspaces': 'QUIRKY_TYPING_BENCH_VISITED_WORKSPACES',
  '--load-workspaces': 'QUIRKY_TYPING_BENCH_LOAD_WORKSPACES',
  '--panes': 'QUIRKY_TYPING_BENCH_LOAD_PANES',
  '--rate-kbps': 'QUIRKY_TYPING_BENCH_RATE_KBPS',
  '--keys': 'QUIRKY_TYPING_BENCH_KEYS',
  '--cadence-ms': 'QUIRKY_TYPING_BENCH_KEY_CADENCE_MS',
  '--cpu-workers': 'QUIRKY_TYPING_BENCH_CPU_WORKERS',
  '--git-churn-repos': 'QUIRKY_TYPING_BENCH_GIT_CHURN_REPOS',
  '--git-churn-files': 'QUIRKY_TYPING_BENCH_GIT_CHURN_FILES',
  '--git-churn-concurrency': 'QUIRKY_TYPING_BENCH_GIT_CHURN_CONCURRENCY',
  '--codex-frame-rows': 'QUIRKY_TYPING_BENCH_CODEX_FRAME_ROWS',
  '--codex-split-delay-ms': 'QUIRKY_TYPING_BENCH_CODEX_SPLIT_DELAY_MS',
  '--worktrees': 'QUIRKY_TYPING_BENCH_METADATA_WORKTREES',
  '--repositories': 'QUIRKY_TYPING_BENCH_METADATA_REPOSITORIES',
  '--terminal-tabs': 'QUIRKY_TYPING_BENCH_METADATA_TERMINAL_TABS',
  '--unified-tabs': 'QUIRKY_TYPING_BENCH_METADATA_UNIFIED_TABS',
  '--sleepers': 'QUIRKY_TYPING_BENCH_METADATA_SLEEPERS',
  '--live-statuses': 'QUIRKY_TYPING_BENCH_METADATA_LIVE_STATUSES',
  '--panes-per-tab': 'QUIRKY_TYPING_BENCH_METADATA_PANES',
  '--status-history': 'QUIRKY_TYPING_BENCH_METADATA_STATUS_HISTORY',
  '--status-interval-ms': 'QUIRKY_TYPING_BENCH_METADATA_STATUS_INTERVAL_MS',
  '--agent-rows': 'QUIRKY_TYPING_BENCH_AGENT_ROWS',
  '--title-change-ms': 'QUIRKY_TYPING_BENCH_TITLE_CHANGE_MS',
  '--lifecycle-ms': 'QUIRKY_TYPING_BENCH_LIFECYCLE_MS',
  '--cpu-profile': 'QUIRKY_TYPING_BENCH_CPU_PROFILE',
  '--pty-metadata': 'QUIRKY_TYPING_BENCH_PTY_METADATA',
  '--metadata-status': 'QUIRKY_TYPING_BENCH_METADATA_STATUS',
  '--metadata-titles': 'QUIRKY_TYPING_BENCH_METADATA_TITLES',
  '--instrumentation': 'QUIRKY_TYPING_BENCH_INSTRUMENTATION',
  '--graph-probe': 'QUIRKY_TYPING_BENCH_GRAPH_PROBE',
  '--cpu-throttle': 'QUIRKY_TYPING_BENCH_CPU_THROTTLE',
  '--label': 'QUIRKY_TYPING_BENCH_LABEL'
}

const env = { ...process.env, QUIRKY_BACKGROUND_LAUNCH: '1', QUIRKY_TYPING_BENCH: '1' }
const passthroughArgs = []
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--') {
    continue
  }
  const knob = knobByFlag[argv[i]]
  if (knob) {
    env[knob] = argv[++i]
  } else {
    passthroughArgs.push(argv[i])
  }
}

const child = spawn(
  npxCommand,
  [
    'playwright',
    'test',
    'tests/e2e/terminal-multi-workspace-typing-latency.spec.ts',
    '--config',
    'tests/playwright.config.ts',
    '--project',
    'electron-headless',
    '--workers=1',
    ...passthroughArgs
  ],
  { stdio: 'inherit', env }
)

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
})
