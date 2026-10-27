import { randomUUID } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HomeOverride, ManagedProvider } from './types'
import { AccountProfiles } from './profiles'

export type ShellRoutingInput = Record<ManagedProvider, HomeOverride>

export class AccountRouting {
  readonly root: string
  private readonly dataRoot: string
  private readonly profilesRoot: string

  constructor(dataDir: string, private readonly profiles: AccountProfiles) {
    this.dataRoot = realpathSync.native(dataDir)
    this.root = join(this.dataRoot, 'routing')
    this.profilesRoot = join(this.dataRoot, 'profiles')
    this.ensureDirectory(this.root)
  }

  pointerPath(provider: ManagedProvider): string {
    return join(this.root, `${provider}.pointer`)
  }

  shellInitPath(): string {
    return join(this.root, 'accounts-shell.sh')
  }

  readPointerContents(provider: ManagedProvider): string | null {
    const path = this.pointerPath(provider)
    this.ensureDirectory(this.root)
    try {
      const stat = lstatSync(path)
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('The account routing pointer is untrusted.')
      return readFileSync(path, 'utf8')
    } catch (error) {
      if (isMissing(error)) return null
      throw new Error('The account routing pointer could not be read safely.')
    }
  }

  restorePointerContents(provider: ManagedProvider, contents: string | null): void {
    const path = this.pointerPath(provider)
    this.ensureDirectory(this.root)
    if (contents === null) {
      rmSync(path, { force: true })
      return
    }
    this.atomicWrite(path, contents)
  }

  writeInvalidPointer(provider: ManagedProvider): void {
    this.atomicWrite(this.pointerPath(provider), '!untrusted\\n')
  }

  writePointer(provider: ManagedProvider, accountId: string | null): void {
    const home = accountId === null ? '' : this.profiles.ensureOwned(provider, accountId)
    this.atomicWrite(this.pointerPath(provider), home ? `${home}\n` : '')
  }

  writeSelectionPointers(active: Record<ManagedProvider, string | null>): void {
    for (const provider of ['claude', 'codex'] as const) this.writePointer(provider, active[provider])
  }

  createShellInit(): string {
    const path = this.shellInitPath()
    const content = this.shellFunctions()
    try {
      if (readFileSync(path, 'utf8') === content) return path
    } catch {
      // A missing file is generated below; other failures are handled by the atomic write.
    }
    this.atomicWrite(path, content)
    return path
  }

  shellEnvironment(overrides: ShellRoutingInput): Record<string, string | null> {
    const claude = overrides.claude
    const codex = overrides.codex
    return {
      ORCA_CLAUDE_PROFILE_POINTER: this.pointerPath('claude'),
      ORCA_CODEX_HOME_POINTER: this.pointerPath('codex'),
      ORCA_CLAUDE_USER_CONFIG_DIR: claude.source === 'inherited' ? claude.value : '',
      ORCA_CODEX_USER_HOME: codex.source === 'inherited' ? codex.value : '',
      ORCA_CLAUDE_LOCKED_CONFIG: claude.source === 'explicit' ? '1' : null,
      ORCA_CODEX_LOCKED_HOME: codex.source === 'explicit' ? '1' : null
    }
  }

  private shellFunctions(): string {
    const claudeRoot = shellQuote(join(this.profilesRoot, 'claude'))
    const codexRoot = shellQuote(join(this.profilesRoot, 'codex'))
    const claudePointer = shellQuote(this.pointerPath('claude'))
    const codexPointer = shellQuote(this.pointerPath('codex'))
    return [
      '__quirky_accounts_read_home() {',
      '  local pointer_file="$1" profile_root="$2" provider="$3" home physical id marker record',
      '  [ -f "$pointer_file" ] && [ ! -L "$pointer_file" ] || { printf "%s\\n" "Quirky account routing pointer is unavailable." >&2; return 1; }',
      '  home=""; IFS= read -r home < "$pointer_file" || [ -z "$home" ] || return 1',
      '  [ -z "$home" ] && return 0',
      '  case "$home" in /*) ;; *) printf "%s\\n" "Quirky account routing pointer is untrusted." >&2; return 1 ;; esac',
      '  case "$home" in "$profile_root"/*/home) ;; *) printf "%s\\n" "Quirky account routing pointer is untrusted." >&2; return 1 ;; esac',
      '  [ -d "$home" ] && [ ! -L "$home" ] || { printf "%s\\n" "Quirky managed account home is unavailable." >&2; return 1; }',
      '  physical=$(cd "$home" 2>/dev/null && pwd -P) || return 1',
      '  [ "$physical" = "$home" ] || { printf "%s\\n" "Quirky managed account home is untrusted." >&2; return 1; }',
      '  id=$(basename "$(dirname "$home")")',
      '  case "$id" in *[!A-Za-z0-9_-]*|"") printf "%s\\n" "Quirky managed account home is untrusted." >&2; return 1 ;; esac',
      '  marker="$(dirname "$home")/owner.json"',
      '  [ -f "$marker" ] && [ ! -L "$marker" ] || { printf "%s\\n" "Quirky managed account ownership marker is unavailable." >&2; return 1; }',
      '  record=$(cat "$marker" 2>/dev/null) || return 1',
      '  [ "$record" = "$provider:$id:1" ] || { printf "%s\\n" "Quirky managed account ownership marker is invalid." >&2; return 1; }',
      '  printf "%s\\n" "$home"',
      '}',
      '',
      'claude() {',
      '  if [ "${ORCA_CLAUDE_LOCKED_CONFIG+x}" = x ] || { [ "${CLAUDE_CONFIG_DIR+x}" = x ] && [ "${CLAUDE_CONFIG_DIR-}" != "${ORCA_CLAUDE_USER_CONFIG_DIR-}" ]; }; then command claude "$@"; return $?; fi',
      `  local home; home=$(__quirky_accounts_read_home ${claudePointer} ${claudeRoot} claude) || return $?`,
      '  if [ -n "$home" ]; then (export CLAUDE_CONFIG_DIR="$home"; command claude "$@"); else (if [ -n "${ORCA_CLAUDE_USER_CONFIG_DIR-}" ]; then export CLAUDE_CONFIG_DIR="$ORCA_CLAUDE_USER_CONFIG_DIR"; else unset CLAUDE_CONFIG_DIR; fi; command claude "$@"); fi',
      '}',
      '',
      'codex() {',
      '  if [ "${ORCA_CODEX_LOCKED_HOME+x}" = x ] || { [ "${CODEX_HOME+x}" = x ] && [ "${CODEX_HOME-}" != "${ORCA_CODEX_USER_HOME-}" ]; }; then command codex "$@"; return $?; fi',
      `  local home; home=$(__quirky_accounts_read_home ${codexPointer} ${codexRoot} codex) || return $?`,
      '  if [ -n "$home" ]; then (export CODEX_HOME="$home"; command codex "$@"); else (if [ -n "${ORCA_CODEX_USER_HOME-}" ]; then export CODEX_HOME="$ORCA_CODEX_USER_HOME"; else unset CODEX_HOME; fi; command codex "$@"); fi',
      '}',
      ''
    ].join('\n')
  }

  private ensureDirectory(path: string): void {
    mkdirSync(path, { recursive: true, mode: 0o700 })
    const stat = lstatSync(path)
    if (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync.native(path) !== path) {
      throw new Error('The private account routing directory is not canonical.')
    }
    chmodSync(path, 0o700)
  }

  private atomicWrite(path: string, contents: string): void {
    this.ensureDirectory(this.root)
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
    try {
      writeFileSync(temp, contents, { flag: 'wx', mode: 0o600 })
      chmodSync(temp, 0o600)
      this.ensureDirectory(this.root)
      renameSync(temp, path)
    } catch {
      rmSync(temp, { force: true })
      throw new Error('The account routing pointer could not be updated.')
    }
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}
