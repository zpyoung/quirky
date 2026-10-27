import { afterEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isolateGitConfig } from '../../../quirky.repo/test/git-fixtures'
import { buttonText, byLabel, click, dialogNamed, messageBox, primary, q, qa, rowOf, text, toasts, type } from './dom'
import { boot, installHook, shutdown, type World } from './world'

const { scratch } = isolateGitConfig()
const SLOW = 90_000
const saved = { QUIRKY_AGENT_SEARCH_DIRS: process.env.QUIRKY_AGENT_SEARCH_DIRS, HOME: process.env.HOME }
afterEach(async () => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  await shutdown()
})

const REPLY = 'Rename x to count.\n\nClearer name.\n'
const SPARKLE = 'Generate commit message with AI'

type Fakes = {
  /** The recorded `argv`, `stdin` or `runs` of the fake. */
  read(ext: string): string
  /** Makes the daemon launch the fake wherever it would launch `claude`, whatever the machine has installed. */
  use(w: World): Promise<unknown>
}

/**
 * Installs a fake `claude` the daemon booted next detects as installed: `--version` answers, and a
 * run records its arguments and stdin before printing `reply` after `delaySeconds`. HOME points at
 * an empty directory so nothing reads a real agent config. A real `claude` on the machine wins
 * detection, so `use` configures the command to be the fake before anything runs.
 */
function installFakeAgents(reply = REPLY, delaySeconds = 1): Fakes {
  const base = scratch()
  const dir = join(base, 'fake-agents')
  mkdirSync(join(base, 'home'), { recursive: true })
  mkdirSync(dir, { recursive: true })
  const rec = join(base, 'rec-claude')
  writeFileSync(`${rec}.reply`, reply)
  writeFileSync(
    join(dir, 'claude'),
    [
      '#!/bin/sh',
      'if [ "$#" -eq 1 ] && [ "$1" = "--version" ]; then echo "0.0.0 (fake)"; exit 0; fi',
      `R=${JSON.stringify(rec)}`,
      'echo x >> "$R.runs"',
      `: > "$R.argv"; for a in "$@"; do printf '%s\\0' "$a" >> "$R.argv"; done`,
      'cat > "$R.stdin"',
      `sleep ${delaySeconds}`,
      'cat "$R.reply"',
      ''
    ].join('\n')
  )
  chmodSync(join(dir, 'claude'), 0o755)
  process.env.HOME = join(base, 'home')
  process.env.QUIRKY_AGENT_SEARCH_DIRS = dir
  return {
    read: (ext) => (existsSync(`${rec}.${ext}`) ? readFileSync(`${rec}.${ext}`, 'utf8') : ''),
    use: (w) => w.agent.callAny('quirky.agents/configure', { agent: 'claude', command: join(dir, 'claude') })
  }
}

/** Waits until the panel has read the agents and the sparkle can run. */
const readySparkle = (w: World) =>
  w.win.waitFor(() => {
    const button = byLabel(SPARKLE)
    return button && !button.disabled && button.title === 'ai commit msg' ? button : undefined
  })

const stage = (w: World) => {
  w.write('math.ts', 'a\nB\nc\nd\ne\n')
  w.git('add', 'math.ts')
}

test('NA-25: the first generation goes through the Generate dialog and fills the box', async () => {
  const fakes = installFakeAgents()
  const w = await boot(scratch)
  await fakes.use(w)
  stage(w)
  await readySparkle(w)

  await click(byLabel(SPARKLE))
  const dialog = await w.win.waitFor(() => dialogNamed('Generate Commit Message'))
  expect(text(q('.muted', dialog))).toBe('Choose the agent and command template for this run.')
  expect((byLabel('Agent', dialog) as unknown as HTMLSelectElement).value).toBe('claude')
  expect((byLabel('Command template', dialog) as unknown as HTMLTextAreaElement).value).toBe('{basePrompt}')

  await click(buttonText('Generate', dialog))
  await w.win.waitFor(() => q('.scm-ai-sparkle .scm-spinner'))
  expect(byLabel('Stop generating commit message')?.title).toBe('Generating commit message. Click to stop.')
  await w.win.waitFor(() => messageBox().value === 'Rename x to count\n\nClearer name.')
  expect(q('.scm-ai-sparkle .scm-spinner')).toBeNull()

  const argv = fakes.read('argv').split('\0')
  expect(argv).toEqual(expect.arrayContaining(['-p', '--output-format', 'text', '--model', 'sonnet']))
  expect(fakes.read('stdin')).toContain('Branch: zoe/feat')
  expect(fakes.read('stdin')).toContain('M\tmath.ts')
  expect(await w.agent.callAny('quirky.git/aiRecipe', { worktree: w.feat.id, action: 'commitMessage' })).toMatchObject({ agent: null, args: '', template: '{basePrompt}' })

  await type(messageBox(), '')
  await click(byLabel(SPARKLE))
  await w.win.waitFor(() => dialogNamed('Generate Commit Message'))
  expect(fakes.read('runs').split('\n').filter(Boolean)).toHaveLength(1)
  expect(w.problems()).toEqual([])
}, SLOW)

test('NA-30: typing during a run keeps the box, and Stop ends the run', async () => {
  const fakes = installFakeAgents(REPLY, 2)
  const w = await boot(scratch)
  await fakes.use(w)
  stage(w)
  await w.agent.callAny('quirky.git/setAiRecipe', { worktree: w.feat.id, action: 'commitMessage', scope: 'global', agent: 'claude' })
  await readySparkle(w)

  await click(byLabel(SPARKLE))
  await w.win.waitFor(() => q('.scm-ai-sparkle .scm-spinner'))
  await type(messageBox(), 'x')
  await type(messageBox(), '')
  await w.win.waitFor(() => q('.scm-ai-sparkle .scm-spinner') === null, 20_000)
  expect(messageBox().value).toBe('')
  expect(fakes.read('runs').split('\n').filter(Boolean)).toHaveLength(1)

  await click(byLabel(SPARKLE))
  await w.win.waitFor(() => byLabel('Stop generating commit message'))
  await click(byLabel('Stop generating commit message'))
  await w.win.waitFor(() => q('.scm-ai-sparkle .scm-spinner') === null, 20_000)
  expect(messageBox().value).toBe('')
  expect(toasts()).toEqual([])
  expect(w.problems()).toEqual([])
}, SLOW)

test('NA-33: AI Fix on the Commit blocked card opens a Claude tab with the failure prompt', async () => {
  const fakes = installFakeAgents()
  const w = await boot(scratch)
  await fakes.use(w)
  installHook(w, 'pre-commit', 'echo "eslint: 2 problems"\nexit 1')
  stage(w)
  await w.win.waitFor(() => rowOf('math.ts', 'staged'))
  await type(messageBox(), 'Rename x')
  await click(primary())

  const card = await w.win.waitFor(() => q('.scm-card-blocked'))
  expect(text(q('.scm-pill', card))).toBe('Lint')
  expect(text(q('.scm-summary', card))).toBe('Lint failed during commit.')
  const fix = byLabel('Start the default AI agent to fix this commit failure', card)
  expect(text(fix)).toBe('AI Fix')
  expect(fix?.title).toBe('Fix commit failure with AI')
  await click(byLabel('Choose an agent for this commit failure', card))
  expect(qa('[role="menu"] button').map(text)).toEqual(['Customize launch...'])
  await click(buttonText('Customize launch...'))
  const launch = await w.win.waitFor(() => dialogNamed('Fix Commit Failure With AI'))
  const picker = await w.win.waitFor(() => byLabel('Agent', launch))
  expect((picker as unknown as HTMLSelectElement).value).toBe('claude')
  const template = await w.win.waitFor(() => byLabel('Prompt template', launch))
  expect((template as unknown as HTMLTextAreaElement).value).toContain('Fix the failed git commit in this worktree and leave the user ready to retry the commit.')
  await click(buttonText('Cancel', launch))

  await click(buttonText('Details', card))
  const details = await w.win.waitFor(() => dialogNamed('Commit Failed'))
  expect(qa('.dialog-actions button', details).map(text)).toEqual(['Fix with AI', 'Close'])
  await click(buttonText('Close', details))

  await click(fix)
  await w.win.waitFor(() => toasts().some((toast) => toast.title === 'Started an AI agent for the commit failure.'))
  const created = w.harness.pty.requests.filter((request) => request.type === 'create') as Array<{ cwd: string; argv: string[] }>
  const tabs = created.filter((request) => request.argv.join('\n').includes('Fix the failed git commit'))
  expect(tabs).toHaveLength(1)
  expect(tabs[0]!.cwd).toBe(w.feat.path)
  const prompt = tabs[0]!.argv.join('\n')
  expect(prompt).toContain('Fix the failed git commit in this worktree and leave the user ready to retry the commit.')
  expect(prompt).toContain('eslint: 2 problems')
  expect(prompt).toContain('"Rename x"')
  expect(w.problems()).toEqual([])
}, SLOW)

test('NA-40: the command opens the AI defaults view, which saves the global recipe and hides the AI buttons live', async () => {
  const fakes = installFakeAgents()
  const w = await boot(scratch)
  await fakes.use(w)
  stage(w)
  await readySparkle(w)

  await w.run('ai-settings')
  const view = await w.win.waitFor(() => q('.scm-ai-view'))
  expect(text(q('h2', view))).toBe('Source Control AI defaults')
  expect(qa('[data-action] h3', view).map(text)).toEqual(['Commit message', 'Commit failure fixes', 'Push failure fixes', 'Conflict resolution'])

  const agent = await w.win.waitFor(() => {
    const select = byLabel('Commit message agent', view) as unknown as HTMLSelectElement | null
    return select && [...select.options].some((option) => option.value === 'codex') ? select : null
  })
  agent.value = 'codex'
  agent.dispatchEvent(new Event('change', { bubbles: true }))
  await w.win.waitFor(async () => ((await w.agent.callAny('quirky.git/aiRecipe', { worktree: w.feat.id, action: 'commitMessage' })) as { agent: string | null }).agent === 'codex')

  await click(byLabel('Show Source Control AI actions', view))
  await w.win.waitFor(() => byLabel(SPARKLE) === null)
  expect(await w.agent.callAny('setting.get', { id: 'setting:quirky.git/ai-enabled' })).toMatchObject({ value: false })
  await click(byLabel('Show Source Control AI actions', view))
  await readySparkle(w)
  expect(w.problems()).toEqual([])
}, SLOW)
