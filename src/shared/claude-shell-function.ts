/**
 * `claude` re-reads the which-account file on every launch, so a switch reaches open terminals
 * (superset's wrapper rule). Defined only in a pane Quirky routed (pointer env set) where `claude` is
 * a real executable. A missing or empty file is System default, which restores the user's own value
 * Quirky's replaced. The user's own CLAUDE_CONFIG_DIR (QUIRKY_CLAUDE_USER_CONFIG_DIR, e.g. an rc export)
 * follows the selection like System default's folder does; any other value set in the pane wins.
 * Prints nothing: an account folder with no login is created, and Claude's own first run signs in
 * there. The shell's Anthropic auth passes through untouched, as on System default. A pointer that names no absolute folder (never written by Quirky) runs nothing, since any
 * fallback would be another account.
 */
export function getPosixClaudeShellFunction(): string {
  return `__quirky_claude_binary="$(unalias claude 2>/dev/null || :; command -v claude 2>/dev/null || :)"
if [[ -n "\${QUIRKY_CLAUDE_PROFILE_POINTER:-}" && -n "\${__quirky_claude_binary:-}" && -x "\${__quirky_claude_binary}" ]]; then
  function claude {
    local __quirky_claude_home __quirky_claude_pointer="\${QUIRKY_CLAUDE_PROFILE_POINTER:-}"
    # Why: a WSL pane's pointer is relative to the guest home, which the host cannot know at spawn.
    case "$__quirky_claude_pointer" in '~/'*) __quirky_claude_pointer="\${HOME:-}/\${__quirky_claude_pointer#??}" ;; esac
    __quirky_claude_home="$(cat "$__quirky_claude_pointer" 2>/dev/null || :)"
    if [ -n "\${CLAUDE_CONFIG_DIR:-}" ] && [ "$CLAUDE_CONFIG_DIR" != "\${QUIRKY_CLAUDE_INJECTED_CONFIG_DIR:-}" ] &&
      { [ -z "\${QUIRKY_CLAUDE_USER_CONFIG_DIR:-}" ] || [ "\${CLAUDE_CONFIG_DIR%/}" != "\${QUIRKY_CLAUDE_USER_CONFIG_DIR%/}" ]; }; then
      command claude "$@"; return
    fi
    # Why: Quirky's value replaced the user's own at spawn, so System default restores theirs.
    if [ -z "$__quirky_claude_home" ] && [ -n "\${CLAUDE_CONFIG_DIR:-}" ] && [ -n "\${QUIRKY_CLAUDE_USER_CONFIG_DIR:-}" ]; then
      ( unset QUIRKY_CLAUDE_INJECTED_CONFIG_DIR; export CLAUDE_CONFIG_DIR="$QUIRKY_CLAUDE_USER_CONFIG_DIR"; command claude "$@" ); return
    fi
    if [ -z "$__quirky_claude_home" ]; then
      ( unset CLAUDE_CONFIG_DIR QUIRKY_CLAUDE_INJECTED_CONFIG_DIR; command claude "$@" ); return
    fi
    case "$__quirky_claude_home" in /*|[A-Za-z]:*) ;; *) return 1 ;; esac
    # Why -m 700: matches the folder Quirky's setup creates; a credentials folder stays private.
    [ -d "$__quirky_claude_home" ] || mkdir -p -m 700 -- "$__quirky_claude_home" 2>/dev/null
    ( export CLAUDE_CONFIG_DIR="$__quirky_claude_home" QUIRKY_CLAUDE_INJECTED_CONFIG_DIR="$__quirky_claude_home"; command claude "$@" )
  }
fi
unset __quirky_claude_binary
`
}

/** Leading newline: the codex fragment it follows ends without one. */
export function getFishClaudeShellFunction(): string {
  return `
set -l __quirky_claude_type (type -t claude 2>/dev/null)
if test -n "$QUIRKY_CLAUDE_PROFILE_POINTER"; and test "$__quirky_claude_type" = file
  function claude
    # Why: a WSL pane's pointer is relative to the guest home, which the host cannot know at spawn.
    set -l pointer (string replace -r '^~/' "$HOME/" -- "$QUIRKY_CLAUDE_PROFILE_POINTER")
    set -l profile (cat "$pointer" 2>/dev/null)
    set -l own (string trim -r -c / -- "$QUIRKY_CLAUDE_USER_CONFIG_DIR")
    set -l current (string trim -r -c / -- "$CLAUDE_CONFIG_DIR")
    if test -n "$CLAUDE_CONFIG_DIR"; and test "$CLAUDE_CONFIG_DIR" != "$QUIRKY_CLAUDE_INJECTED_CONFIG_DIR"; and begin; test -z "$own"; or test "$current" != "$own"; end
      command claude $argv
      return $status
    end
    if test -z "$profile"; and test -n "$CLAUDE_CONFIG_DIR"; and test -n "$QUIRKY_CLAUDE_USER_CONFIG_DIR"
      env -u QUIRKY_CLAUDE_INJECTED_CONFIG_DIR CLAUDE_CONFIG_DIR="$QUIRKY_CLAUDE_USER_CONFIG_DIR" claude $argv
      return $status
    end
    if test -z "$profile"
      env -u CLAUDE_CONFIG_DIR -u QUIRKY_CLAUDE_INJECTED_CONFIG_DIR claude $argv
      return $status
    end
    if not string match -qr '^(/|[A-Za-z]:)' -- "$profile"
      return 1
    end
    test -d "$profile"; or mkdir -p -m 700 -- "$profile" 2>/dev/null
    env CLAUDE_CONFIG_DIR="$profile" QUIRKY_CLAUDE_INJECTED_CONFIG_DIR="$profile" claude $argv
  end
end
set -e __quirky_claude_type
`
}

export function getPowerShellClaudeShellFunction(): string {
  return `$quirkyClaudeCommand = Get-Command claude -ErrorAction SilentlyContinue | Select-Object -First 1
if ($env:QUIRKY_CLAUDE_PROFILE_POINTER -and $quirkyClaudeCommand -and
    $quirkyClaudeCommand.CommandType -in @("Application", "ExternalScript")) {
function Global:claude {
    $names = @('CLAUDE_CONFIG_DIR', 'QUIRKY_CLAUDE_INJECTED_CONFIG_DIR')
    $saved = @{}
    foreach ($name in $names) { $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
    try {
        $quirkyClaudeHome = ''
        if ($env:QUIRKY_CLAUDE_PROFILE_POINTER -and (Test-Path -LiteralPath $env:QUIRKY_CLAUDE_PROFILE_POINTER -PathType Leaf)) {
            $quirkyClaudeHome = [IO.File]::ReadAllText($env:QUIRKY_CLAUDE_PROFILE_POINTER).TrimEnd()
        }
        # Why the separator swap: Windows names one folder with either separator.
        $own = ("$env:QUIRKY_CLAUDE_USER_CONFIG_DIR" -replace '/', '\\').TrimEnd('\\')
        if ($env:CLAUDE_CONFIG_DIR -and $env:CLAUDE_CONFIG_DIR -ne $env:QUIRKY_CLAUDE_INJECTED_CONFIG_DIR -and
            (-not $own -or ("$env:CLAUDE_CONFIG_DIR" -replace '/', '\\').TrimEnd('\\') -ne $own)) {
            # A value set in this pane, other than the user's own, wins.
        } elseif (-not $quirkyClaudeHome) {
            Remove-Item Env:QUIRKY_CLAUDE_INJECTED_CONFIG_DIR -ErrorAction SilentlyContinue
            if ($env:CLAUDE_CONFIG_DIR -and $env:QUIRKY_CLAUDE_USER_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR = $env:QUIRKY_CLAUDE_USER_CONFIG_DIR }
            else { Remove-Item Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue }
        } elseif (-not [IO.Path]::IsPathRooted($quirkyClaudeHome)) {
            $global:LASTEXITCODE = 1
            return
        } else {
            if (-not [IO.Directory]::Exists($quirkyClaudeHome)) { $null = New-Item -ItemType Directory -Path $quirkyClaudeHome -Force -ErrorAction SilentlyContinue }
            $env:CLAUDE_CONFIG_DIR = $quirkyClaudeHome
            $env:QUIRKY_CLAUDE_INJECTED_CONFIG_DIR = $quirkyClaudeHome
        }
        $binary = Get-Command claude -CommandType Application,ExternalScript -ErrorAction Stop | Select-Object -First 1
        $claudeArgs = @(__QuirkyEscapeNativeArgs $binary.Source $args)
        if ($MyInvocation.ExpectingInput) { $input | & $binary.Source @claudeArgs } else { & $binary.Source @claudeArgs }
        $global:LASTEXITCODE = $LASTEXITCODE
    } catch { $global:LASTEXITCODE = 1; Write-Error $_ -ErrorAction Continue }
    finally {
        # Why Remove-Item: on .NET 9+ a $null value (passed as "") creates the variable empty instead of deleting it.
        foreach ($name in $names) {
            if ($null -eq $saved[$name]) { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue }
            else { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') }
        }
    }
}
}
Remove-Variable quirkyClaudeCommand -ErrorAction SilentlyContinue
`
}
