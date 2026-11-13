import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createCodexAppServerFixture } from '../../plugins/quirky.structured/test/fakes/codex-app-server'

export type CliFixtureTools = {
  fixtureBin: string
  ompWrapper: string
  claudeWrapper: string
  codexWrapper: string
  codexExecutable: string
  shell: string
  orcaShim: string
  securityShim: string
  ompLog: string
  ompInputLog: string
  codexLog: string
  codexEnvironmentLog: string
  claudeLoginLog: string
  codexLoginLog: string
  orcaLog: string
  securityLog: string
  egressLog: string
  fetchPreload: string
}

export type CliFixturePaths = CliFixtureTools & {
  repository: string
  folder: string
  fixtureFile: string
  worktreesRoot: string
  askSpec: string
  actorEntry: string
  actorReceipts: string
  actorReceiptManifest: string
  actorIdentity: string
  actorInputLog: string
  codexHooksFile: string
  userHookDocument: string
}

export type FixtureCommandResult = { stdout: string; stderr: string; exitCode: number }
export type FixtureCommand = (argv: string[], cwd: string) => Promise<FixtureCommandResult>

function makeDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
}

function executable(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o700 })
  chmodSync(path, 0o700)
}

function privateEmptyFile(path: string): void {
  writeFileSync(path, '', { mode: 0o600 })
}

export function installCliFixtureTools(home: string): CliFixtureTools {
  const root = resolve(home)
  const fixtureRoot = join(root, 'fixtures')
  const fixtureBin = join(fixtureRoot, 'bin')
  const logs = join(fixtureRoot, 'logs')
  const codexHome = join(fixtureRoot, 'codex')
  makeDirectory(fixtureBin)
  makeDirectory(logs)
  makeDirectory(join(root, 'cli-actor'))
  makeDirectory(join(root, 'codex'))

  const codex = createCodexAppServerFixture(codexHome, { uniqueThreads: true })
  const ompLog = join(logs, 'omp-argv.log')
  const ompInputLog = join(logs, 'omp-stdin.log')
  const claudeLoginLog = join(logs, 'claude-login.log')
  const codexLoginLog = join(logs, 'codex-login.log')
  const orcaLog = join(logs, 'orca.log')
  const securityLog = join(logs, 'security.log')
  const egressLog = join(logs, 'egress.log')
  for (const path of [ompLog, ompInputLog, claudeLoginLog, codexLoginLog, orcaLog, securityLog, egressLog]) privateEmptyFile(path)
  const ompWrapper = join(fixtureBin, 'omp')
  executable(ompWrapper, `#!/bin/sh
set -eu
log="$QUIRKY_HOME/fixtures/logs/omp-argv.log"
printf '%s\\n' "$@" >> "$log"
prompt=''
want_prompt=0
for arg in "$@"; do
  if [ "$want_prompt" = 1 ]; then prompt=$arg; break; fi
  if [ "$arg" = '--prompt' ]; then want_prompt=1; fi
done
if [ -z "$prompt" ]; then
  for arg in "$@"; do case "$arg" in *cli-parity-prompt*) prompt=$arg ;; esac; done
fi
printf 'PROMPT:%s\\n' "$prompt"
`)

  const claudeWrapper = join(fixtureBin, 'claude')
  executable(claudeWrapper, `#!/bin/sh
set -eu
if [ "$#" -eq 1 ] && [ "$1" = '--version' ]; then
  printf '2.1.80 (Claude Code)\\n'
  exit 0
fi
if [ "$#" -eq 3 ] && [ "$1" = 'auth' ] && [ "$2" = 'login' ] && [ "$3" = '--claudeai' ]; then
  mkdir -p "$CLAUDE_CONFIG_DIR"
  umask 077
  printf '%s\\n' '{"oauthAccount":{"emailAddress":"claude-parity@example.invalid","organizationName":"CLI parity fixture"}}' > "$CLAUDE_CONFIG_DIR/.claude.json"
  printf '%s\\n' '{"claudeAiOauth":{"refreshToken":"cli-parity-fixture-refresh"}}' > "$CLAUDE_CONFIG_DIR/.credentials.json"
  chmod 600 "$CLAUDE_CONFIG_DIR/.claude.json" "$CLAUDE_CONFIG_DIR/.credentials.json"
  printf 'login\\n' >> "$QUIRKY_HOME/fixtures/logs/claude-login.log"
  exit 0
fi
printf '%s\\n' 'claude fixture refuses unsupported arguments' >&2
exit 64
`)

  const codexWrapper = join(fixtureBin, 'codex')
  executable(codexWrapper, `#!/bin/sh
set -eu
if [ "$#" -eq 1 ] && [ "$1" = '--version' ]; then
  printf 'codex-cli 0.120.0\\n'
  exit 0
fi
if [ "$#" -eq 1 ] && [ "$1" = 'app-server' ]; then
  exec "$CLI_PARITY_CODEX_FIXTURE" app-server
fi
if [ "$#" -eq 1 ] && [ "$1" = 'login' ]; then
  if ! grep -Fqx 'cli_auth_credentials_store = "file"' "$CODEX_HOME/config.toml" 2>/dev/null; then
    exit 8
  fi
  umask 077
  printf '%s\\n' '{"auth_mode":"chatgpt","tokens":{"id_token":"header.eyJlbWFpbCI6ImNvZGV4LXBhcml0eUBleGFtcGxlLmludmFsaWQifQ.signature","account_id":"cli-parity-codex-workspace"}}' > "$CODEX_HOME/auth.json"
  chmod 600 "$CODEX_HOME/auth.json"
  printf 'login\\n' >> "$QUIRKY_HOME/fixtures/logs/codex-login.log"
  exit 0
fi
printf '%s\\n' 'codex fixture refuses unsupported arguments' >&2
exit 64
`)

  const shell = join(fixtureBin, 'cli-shell')
  executable(shell, `#!/bin/sh
while [ "$#" -gt 0 ] && [ "$1" = '-l' ]; do shift; done
exec /bin/sh "$@"
`)

  const orcaShim = join(fixtureBin, 'orca')
  executable(orcaShim, `#!/bin/sh
printf '%s\\n' "$*" >> "$QUIRKY_HOME/fixtures/logs/orca.log"
exit 97
`)

  const securityShim = join(fixtureBin, 'security')
  executable(securityShim, `#!/bin/sh
printf '%s\\n' "$*" >> "$QUIRKY_HOME/fixtures/logs/security.log"
exit 44
`)

  const fetchPreload = join(fixtureRoot, 'deny-egress.cjs')
  writeFileSync(fetchPreload, `const fs = require('node:fs')
const log = ${JSON.stringify(egressLog)}
const marker = Symbol.for('quirky.cli-parity.fetch-guard')
if (!globalThis[marker]) {
  Object.defineProperty(globalThis, marker, { value: true })
  const upstream = globalThis.fetch
  globalThis.fetch = Object.assign(async (input, init) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    let url
    try { url = new URL(raw) } catch { throw new TypeError('invalid fetch URL refused by CLI parity fixture') }
    const host = url.hostname.toLowerCase()
    const loopback = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || /^127\\./.test(host)
    if (!loopback) {
      fs.appendFileSync(log, url.href + '\\n', { mode: 0o600 })
      throw new TypeError('non-loopback fetch refused by CLI parity fixture')
    }
    return upstream(input, init)
  }, { preconnect: upstream.preconnect })
}
`, { mode: 0o600 })

  return {
    fixtureBin,
    ompWrapper,
    claudeWrapper,
    codexWrapper,
    codexExecutable: codex.executable,
    shell,
    orcaShim,
    securityShim,
    ompLog,
    ompInputLog,
    codexLog: codex.logPath,
    codexEnvironmentLog: codex.environmentLogPath,
    claudeLoginLog,
    codexLoginLog,
    orcaLog,
    securityLog,
    egressLog,
    fetchPreload
  }
}

/** Creates only local, owned fixture data. All Git processes use the caller's bounded scope runner. */
export async function createCliFixtures(options: {
  home: string
  repoRoot: string
  tools: CliFixtureTools
  run: FixtureCommand
}): Promise<CliFixturePaths> {
  const home = resolve(options.home)
  const repoRoot = resolve(options.repoRoot)
  const tools = options.tools
  const repositories = join(home, 'repositories')
  const repository = join(repositories, 'cli parity repository')
  const folder = join(repositories, 'plain project folder')
  const worktreesRoot = join(home, 'worktrees')
  const fixtureFile = join(repository, 'fixture.txt')
  const actorRoot = join(home, 'cli-actor')
  const actorReceipts = join(actorRoot, 'receipts')
  const actorReceiptManifest = join(actorRoot, 'receipt-index.json')
  const actorIdentity = join(actorRoot, 'identity.json')
  const actorInputLog = join(actorRoot, 'input.log')
  const askSpec = join(actorRoot, 'confirm-spec.json')
  const actorEntry = join(repoRoot, 'scripts/parity/cli-actor.ts')

  const codexHooksFile = join(home, 'codex', 'hooks.json')
  const userHookDocument = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo user-owned-hook' }] }] } })
  for (const directory of [repositories, repository, folder, worktreesRoot, actorReceipts, join(home, 'codex')]) makeDirectory(directory)
  writeFileSync(fixtureFile, 'first\nsecond λ\n', { mode: 0o600 })
  writeFileSync(codexHooksFile, userHookDocument, { mode: 0o600 })
  privateEmptyFile(actorInputLog)
  writeFileSync(actorReceiptManifest, '[]\n', { mode: 0o600 })
  writeFileSync(askSpec, JSON.stringify({ questions: [{ id: 'continue', type: 'confirm', question: 'Continue CLI fixture?' }] }) + '\n', { mode: 0o600 })

  const git = async (...args: string[]) => options.run(['git', ...args], repository)
  const init = await git('init', '--initial-branch=main')
  if (init.exitCode !== 0) throw new Error(`fixture git init failed: ${init.stderr || init.stdout}`)
  for (const [key, value] of [
    ['user.name', 'CLI parity fixture'],
    ['user.email', 'cli-parity@example.invalid'],
    ['core.hooksPath', '/dev/null'],
    ['commit.gpgsign', 'false'],
    ['tag.gpgsign', 'false']
  ]) {
    const configured = await git('config', '--local', key, value)
    if (configured.exitCode !== 0) throw new Error(`fixture git config ${key} failed: ${configured.stderr || configured.stdout}`)
  }
  const add = await git('add', '--', 'fixture.txt')
  if (add.exitCode !== 0) throw new Error(`fixture git add failed: ${add.stderr || add.stdout}`)
  const commit = await git('commit', '--no-gpg-sign', '-m', 'CLI parity fixture')
  if (commit.exitCode !== 0) throw new Error(`fixture git commit failed: ${commit.stderr || commit.stdout}`)
  const remotes = await git('remote')
  for (const branch of ['cli-parity-topic', 'cli-parity-both']) {
    const created = await git('branch', branch)
    if (created.exitCode !== 0) throw new Error(`fixture Git branch ${branch} failed: ${created.stderr || created.stdout}`)
  }
  for (const tag of ['cli-parity-v1', 'cli-parity-both']) {
    const created = await git('tag', tag)
    if (created.exitCode !== 0) throw new Error(`fixture Git tag ${tag} failed: ${created.stderr || created.stdout}`)
  }
  if (remotes.exitCode !== 0 || remotes.stdout.trim() !== '') throw new Error('fixture Git repository unexpectedly has a remote')

  return {
    ...tools,
    repository,
    folder,
    fixtureFile,
    worktreesRoot,
    askSpec,
    actorEntry,
    actorReceipts,
    actorReceiptManifest,
    actorIdentity,
    actorInputLog,
    codexHooksFile,
    userHookDocument
  }
}
