# Provider account preparation

`quirky.accounts/prepare` prepares a real user launch. Its session and worktree identities are persisted so later status and usage work can resolve the actual account home.

`quirky.accounts/prepareProviderEnv` is for a short-lived provider-owned process or API probe such as Codex or Claude model discovery. It accepts only `agent`, `cwd`, and both provider home overrides; it rejects `sessionId`, `worktreeId`, `resume`, and other extra fields. It uses the same explicit, inherited, injected, absent, selected-account, and System default resolution as `prepare`, including managed-home ownership/authentication checks and Codex config-warning synchronization. Any Codex config synchronization writes only to the verified managed profile; the System default config is read-only. Its result has `shellInit: null` and never creates, updates, or fabricates an `account_sessions` row or resume transcript.

`account.authKind` is non-secret selected-account metadata (`oauth`, `api-key`, `none`, or `unknown`). Provider API probes use it to distinguish API-key access from OAuth sign-in; OAuth tokens are never used as model-list API keys.

The returned `env` is an environment patch, not credentials. String values are applied; `null` means delete that variable from the child environment. The CLI command reports the resolved account and environment variable names without printing environment values:

```sh
quirky accounts prepare-provider-env --agent codex --cwd "$PWD" --home-overrides '{"claude":{"value":null,"source":"absent"},"codex":{"value":null,"source":"absent"}}'
```

## Paired-owner Accounts

When a window shows a registered remote workspace, Accounts and Usage read that workspace's full-owner host. The window keeps its last actual workspace owner when Accounts settings replaces the workspace view; settings itself is not a local workspace. An offline or replaced owner is unavailable, never a source of local fallback data.

Account selection, inactive-account usage, and usage refresh operate on the selected owner. Presentation and Claude restart preferences remain local. Remote sign-in, reauthentication, pending-link actions, account removal, session restart/keep, meter-credential editing, and Codex reset redemption are unavailable; credential status remains read-only.

`quirky accounts owner-call` exposes the scoped API through the generated CLI group. `--owner` takes an exact owner reference derived from a current `quirky.worktree/remoteHostList` registration. Choose one `--operation`: `list`, `usage`, `refresh`, `inactiveUsage`, `select`, `credentialStatus`, `agentsList`, or `agentsRefresh`; `--operation-params` supplies that operation's JSON object. The route cannot forward an arbitrary method or use a phone-scoped runtime.

## Usage and sign-in controls

The Usage status bar measures the rendered chip container, gaps and overflow-button widths. Its preferred width comes from all configured, visible provider chips, so it uses free status-bar space and restores collapsed chips when space returns. It keeps an exact visible prefix and a `+N` button for the omitted providers; the button's tooltip names that suffix. Compact, Detailed, Remaining and badge-only changes remeasure, and hidden measurement elements do not enlarge the status bar. Escape closes the Usage popover and returns focus to the status-bar trigger; outside-pointer dismissal only closes it.

Refreshing usage does not add chips for unconfigured providers. Providers with account, credential or cached-usage evidence remain visible while fetching.

Each provider chip opens that provider's usage details; Claude and Codex details include the account switcher. Chips support click, Enter and Space, and their accessible names include the provider and current usage or status, plus reset timing when available.

Codex's **Open** sign-in action invokes the existing public `quirky.terminal/openExternal` method with the validated displayed authorize URL. It does not rely on a webview pop-up or complete/select the account; invocation failures leave Copy and Cancel available. Actual system-browser and OAuth completion are separate from an accepted opener call.

Declared CLI commands dispatch by their existing stable IDs, including `login-status`, `cancel-login`, `session-home`, `inactive-usage`, `ui-state`, `credential-status` and `reset-credit`:

```sh
quirky accounts add --provider codex --json
quirky accounts login-status --id <pending-login-id> --json
quirky accounts cancel-login --id <pending-login-id> --json
```

## Native sign-in links

Codex sign-in's **Open** button sends the displayed, approved authorize URL through the public `quirky.terminal/openExternal` system-handler API rather than a webview popup. While the handoff is pending, **Copy link** and **Cancel** remain available. A failed handoff shows a recoverable error; retrying does not restart sign-in or change the URL.

If cancelling sign-in fails, the pending login remains visible and status polling continues. A later native sign-in completion can still add the account; a successful cancellation or a superseding login cannot be undone by a delayed status response.

## Account-switch restart eligibility

Usage and pane restart controls apply only to terminal sessions. Background and structured runners keep their recorded account identity, but are not offered a terminal restart they cannot execute. Their original account home remains available through `quirky.accounts/sessionHome`; selecting a new account does not relabel a running process.

Codex continuation carries the accumulated native rollout into the selected managed home before replacing the old terminal. Removing an earlier account after a successful continuation does not make a later account depend on that removed home's transcript path.

## Inactive account usage

Expanding Claude or Codex account choices loads usage for the inactive accounts without selecting them. `UsageState.inactive` uses `provider:accountId` keys, matching the identity in each snapshot; desktop and mobile consumers must not look up a bare account ID.

## Reset-credit responses

Public `quirky.accounts/consumeResetCredit` returns `{ outcome, state }` for both completion and durable replay. `outcome` is `reset`, `nothingToReset`, `noCredit`, or `alreadyRedeemed`; `state` is the current cached `UsageState`, not an implicit forced provider refresh. Scalar public replies are not supported.

Changed account/offer authority returns a public Conflict before provider redemption. Unknown provider outcomes remain retryable with the same captured scope and request ID; a retry cannot migrate that ID to a different offer.

## Queued Claude restarts

Always queues busy restarts without an Ask modal. Under Ask, accepting Restart closes the choice dialog once the restart is queued; the pane accessory and usage details retain nonmodal progress until idle. If policy changes to Ask or Never before the next selection, the old queued intent is invalidated and cannot authorize a restart on the newly selected account.

## Desktop presentation

Accounts uses the public `@quirky/ui` graphite components and shared dark/light tokens for its settings, Usage status item and popover, session accessory and account-switch dialog. Its existing contribution IDs and account/usage APIs are unchanged; the host still owns placement and settings navigation.

Accounts and Vault are both opted into `scripts/ui-lint-plugins.json`. Run `bun run typecheck` to enforce the shared design system as well as TypeScript contracts. Neither plugin injects its own stylesheet. The restyle's scope and acceptance scenarios are recorded in [`ui-restyle-accounts/logic.md`](../../../docs/quirk/specs/2026-10-28-ui-restyle-accounts/logic.md); the approved reference is the [desktop redesign](../../../docs/quirk/specs/2026-10-28-ui-redesign/logic.md).

The lint gate checks tracked source and nonignored new source; ignored generated bundles are not source inputs. A tracked file is still checked even if an ignore pattern also matches it. The gate never rewrites generated phone assets or relaxes token/CSS rules.

## Isolated account regressions

Run `bun scripts/suite.ts plugins/quirky.accounts` for the account lifecycle and UI regressions. They use fresh private homes and synthetic provider/security boundaries; they do not establish native Keychain, real provider authentication, or packaged desktop acceptance.

The model-discovery fixture configures the absolute owned provider executable through `quirky.agents/configure` and uses the running Bun executable as its interpreter. Prepending a fixture directory to `PATH`, or adding it to `QUIRKY_AGENT_SEARCH_DIRS`, is insufficient: a login-shell executable can take precedence. The regression checks selected-account model/effort resolution and preservation of the last usable catalog after failed discovery. Removal and continuation regressions check credential/history bytes and surviving account selection rather than private markup, command inventories, or copied process arguments.
