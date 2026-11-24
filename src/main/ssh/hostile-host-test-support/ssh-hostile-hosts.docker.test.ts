// Hostile-host matrix: the real client-side managed quirkyd deploy against container SSH targets,
// and against a macOS runner's own loopback sshd, asserting the runtime each host resolves and
// whether quirkyd activates there or fails with the classified reason.
//
// Run: QUIRKY_RUN_SSH_HOSTILE_HOSTS=1 pnpm test src/main/ssh/hostile-host-test-support/ssh-hostile-hosts.docker.test.ts
// Needs an quirkyd template holding each selected cell's slot. Docker cells
// need Linux Docker (the no-egress cell dials an internal bridge directly) and
//   node config/scripts/build-quirkyd-template.mjs --targets linux-x64-glibc,linux-x64-musl
// macOS cells need /usr/sbin/sshd and this runner's slot (`pnpm build:quirkyd-prebuilds`, then
// `--targets darwin-arm64` or `darwin-x64`). Only cells this machine can host run.
// QUIRKY_SSH_HOSTILE_HOST_CELLS=id,id narrows the run. .github/workflows/ssh-hostile-hosts.yml runs it.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getAppPath: () => process.cwd() } }))

import { HOSTILE_HOST_CELLS, selectHostileHostCells } from './ssh-hostile-host-cells'
import { proveManagedQuirkydCell } from './ssh-hostile-host-managed-quirkyd'
import { installHostileHostAppEnvironment } from './ssh-hostile-host-test-harness'
import {
  hostileHostSshTarget,
  startHostileHostTarget,
  stopHostileHostTarget,
  type HostileHostTarget
} from './ssh-hostile-host-test-fixture'

const RUN = process.env.QUIRKY_RUN_SSH_HOSTILE_HOSTS === '1'
const SELECTED = new Set(
  RUN
    ? selectHostileHostCells(process.env.QUIRKY_SSH_HOSTILE_HOST_CELLS).map((cell) => cell.id)
    : []
)
const CELL_TIMEOUT_MS = 15 * 60_000

describe('SSH hostile-host managed quirkyd matrix', () => {
  let cleanupAppEnvironment: (() => void) | null = null
  let executed = 0

  beforeAll(() => {
    cleanupAppEnvironment = installHostileHostAppEnvironment()
  })

  afterAll(() => {
    cleanupAppEnvironment?.()
    // Why: a job whose cells were all skipped would otherwise pass having deployed nothing.
    if (RUN) {
      expect(executed).toBe(SELECTED.size)
    }
  })

  it.runIf(RUN)('selects at least one cell this machine can host', () => {
    expect(SELECTED.size).toBeGreaterThan(0)
  })

  // A fresh host per cell.
  for (const cell of HOSTILE_HOST_CELLS) {
    it.skipIf(!SELECTED.has(cell.id))(
      `${cell.id} deploys managed quirkyd on ${cell.managed.runtime} (${cell.managed.outcome})`,
      async () => {
        executed += 1
        let target: HostileHostTarget | null = null
        try {
          target = await startHostileHostTarget(cell)
          await proveManagedQuirkydCell(cell, target, hostileHostSshTarget(target))
        } finally {
          await stopHostileHostTarget(target)
        }
      },
      CELL_TIMEOUT_MS
    )
  }
})
