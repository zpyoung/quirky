import { chmodSync, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  HOOK_TOKEN_HEADER,
  type PtyFact,
  type QuirkyClient,
  type QuirkyEvent,
  type Repo,
  type Session,
  type Worktree,
  type WorktreeCreateResult
} from '@quirky/protocol'
import { createFakeGit, useTestGit, type FakeGit } from '@quirky/git/testing'
import { builtinsDir, makeTempHome, startHarness, waitFor, type Harness } from '../../../packages/daemon/test/helpers'
import { makeTempDir, removeTempDirs } from '../../../packages/daemon/test/plugins/fixtures'
import { addFakeRepo, fakeRegistrations } from '../../quirky.worktree/test/fixtures/fake-git'

export const WORKTREE_VIEW = 'view:quirky.session/worktree'

export type NotifyEvent = Extract<QuirkyEvent, { type: 'notify' }>
export type Decided = { source: string; sessionId: string | null; worktreeId: string | null; result: string }
export type Status = {
  badge: number
  label: string
  unreadWorktrees: { id: string; name: string }[]
  unreadSessions: { id: string; worktreeId: string; reason: string }[]
  pendingAsks: number
  sound: { ok: boolean; reason?: string }
}

const ENV_KEYS = ['HOME', 'QUIRKY_SOUND_PLAYER', 'QUIRKY_TEST_SOUNDS', 'QUIRKY_NOTIFICATION_COOLDOWN_MS'] as const

/** A window client: reports focus, input, the open view and the sessions it shows, like the real window. */
export class FakeWindow {
  constructor(readonly client: QuirkyClient) {}

  focus = () => this.client.callAny('ui.window.focused', { focused: true })
  blur = () => this.client.callAny('ui.window.focused', { focused: false })
  input = () => this.client.callAny('ui.window.activity', {})

  /** Opens the session view on a worktree, shows `visible` sessions in it and reports them. */
  async open(worktree: string, visible: string[] = [], options: { session?: string } = {}): Promise<void> {
    await this.client.callAny('ui.view.open', {
      id: WORKTREE_VIEW,
      input: options.session === undefined ? { worktree } : { worktree, session: options.session }
    })
    await this.report(worktree, visible)
  }

  report = (worktree: string, visible: string[]) =>
    this.client.callAny('ui.report', {
      slot: WORKTREE_VIEW,
      state: { worktree, tabs: [], active: visible[0] ?? null, visibleSessions: visible }
    })

  close = () => this.client.callAny('ui.view.close', {})
}

/**
 * A daemon with every built-in plugin over a fake git and a fake PTY host, a repo `quirky` with
 * worktrees on demand, a window client, and a recorder in place of the sound player.
 */
export class Rig {
  events: QuirkyEvent[] = []
  worktrees: Record<string, Worktree> = {}
  win!: FakeWindow
  private readonly saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {}
  private soundLog = ''
  repo!: Repo
  root = ''

  private constructor(
    readonly h: Harness,
    readonly client: QuirkyClient,
    readonly git: FakeGit
  ) {}

  static async start(options: { awayMs?: number; cooldownMs?: number; home?: string; keepEnv?: boolean } = {}): Promise<Rig> {
    const git = createFakeGit()
    useTestGit(git)
    fakeRegistrations(git)
    const soundLog = join(makeTempDir('qn-sound-'), 'played.log')
    const player = join(makeTempDir('qn-player-'), 'player.sh')
    writeFileSync(player, '#!/bin/sh\necho "$1 $2" >> "$QUIRKY_TEST_SOUNDS"\n')
    chmodSync(player, 0o755)
    const saved: Rig['saved'] = {}
    for (const key of ENV_KEYS) saved[key] = process.env[key]
    process.env.HOME = realpathSync(makeTempDir('qn-home-'))
    process.env.QUIRKY_SOUND_PLAYER = player
    process.env.QUIRKY_TEST_SOUNDS = soundLog
    if (options.cooldownMs !== undefined) process.env.QUIRKY_NOTIFICATION_COOLDOWN_MS = String(options.cooldownMs)
    else delete process.env.QUIRKY_NOTIFICATION_COOLDOWN_MS

    const h = await startHarness({
      home: options.home ?? makeTempHome('qn-'),
      builtinPluginsDir: builtinsDir(),
      ...(options.awayMs === undefined ? {} : { desktopAwayMs: options.awayMs })
    })
    const { client, events } = await h.connectWithEvents('cli')
    const rig = new Rig(h, client, git)
    Object.assign(rig.saved, saved)
    rig.soundLog = soundLog
    rig.events = events
    rig.win = new FakeWindow(await h.connect('ui', 'window'))
    rig.root = realpathSync(makeTempDir('qn-root-'))
    await client.callAny('setting.set', { id: 'setting:quirky.worktree/worktreesRoot', value: rig.root })
    const dir = addFakeRepo(git, 'quirky')
    rig.repo = (await client.callAny('quirky.repo/add', { path: dir })) as Repo
    const main = ((await client.callAny('quirky.worktree/list', {})) as Worktree[]).find((worktree) => worktree.isMain)!
    rig.worktrees.main = main
    return rig
  }

  async cleanup(): Promise<void> {
    useTestGit(null)
    await this.h.cleanup()
    removeTempDirs()
    for (const key of ENV_KEYS) {
      if (this.saved[key] === undefined) delete process.env[key]
      else process.env[key] = this.saved[key]
    }
  }

  async worktree(name: string): Promise<Worktree> {
    const existing = this.worktrees[name]
    if (existing) return existing
    const created = (await this.client.callAny('quirky.worktree/create', { repo: this.repo.id, name })) as WorktreeCreateResult
    this.worktrees[name] = created.worktree
    return created.worktree
  }

  async session(worktree: string, agent = 'shell'): Promise<Session> {
    return (await this.client.callAny('quirky.session/create', { worktree: (await this.worktree(worktree)).id, agent })) as Session
  }

  async getSession(id: string): Promise<Session> {
    return (await this.client.callAny('quirky.session/get', { session: id })) as Session
  }

  async getWorktree(name: string): Promise<Worktree> {
    return (await this.client.callAny('quirky.worktree/show', { worktree: `id:${this.worktrees[name]!.id}` })) as Worktree
  }

  status = async () => (await this.client.callAny('quirky.notifications/status', {})) as Status

  setting = (name: string, value: unknown) => this.client.callAny('setting.set', { id: `setting:quirky.notifications/${name}`, value })

  /** Posts a hook as the agent's shim would. */
  async hook(agent: string, session: string, payload: Record<string, unknown>): Promise<void> {
    const response = await fetch(`http://127.0.0.1:${this.h.runtime.port}/hook/${agent}?${new URLSearchParams({ session })}`, {
      method: 'POST',
      headers: { [HOOK_TOKEN_HEADER]: this.h.runtime.hookToken },
      body: JSON.stringify(payload)
    })
    if (response.status !== 200) throw new Error(`hook answered ${response.status}`)
  }

  /** A Claude turn: prompt, then Stop with `message`. */
  async claudeTurn(session: string, message?: string): Promise<void> {
    await this.hook('claude', session, { hook_event_name: 'UserPromptSubmit', prompt: 'go' })
    await this.hook('claude', session, { hook_event_name: 'Stop', ...(message === undefined ? {} : { last_assistant_message: message }) })
  }

  fact(sessionId: string, fact: PtyFact): void {
    this.h.pty.fact(sessionId, fact)
  }

  bell = (sessionId: string) => this.fact(sessionId, { kind: 'bell' })
  oscNotify = (sessionId: string, title: string | null, body: string, occasion: 'always' | 'unfocused' | 'invisible' = 'always') =>
    this.fact(sessionId, { kind: 'notification', title, body, occasion })

  notifies = () => this.events.filter((event): event is NotifyEvent => event.type === 'notify')
  attentions = () => this.pluginEvents('attention')
  decisions = () => this.pluginEvents('decided') as Decided[]

  pluginEvents(name: string): Record<string, unknown>[] {
    return this.events.filter((event) => event.type === `quirky.notifications/${name}`).map((event) => (event as { data: Record<string, unknown> }).data)
  }

  /** Resolves once `count` decisions have been recorded in total. */
  waitDecided(count: number): Promise<Decided[]> {
    return waitFor(() => (this.decisions().length >= count ? this.decisions() : null), 4000)
  }

  /** The `<file> <volume>` lines the recorder saw. */
  played(): string[] {
    return existsSync(this.soundLog) ? readFileSync(this.soundLog, 'utf8').split('\n').filter(Boolean) : []
  }

  /** Waits until the plugin has caught up with everything sent so far. */
  async settle(ms = 120): Promise<void> {
    await Bun.sleep(ms)
  }
}
