# Provider account preparation

`quirky.accounts/prepare` prepares a real user launch. Its session and worktree identities are persisted so later status and usage work can resolve the actual account home.

`quirky.accounts/prepareProviderEnv` is for a short-lived provider-owned process or API probe such as Codex or Claude model discovery. It accepts only `agent`, `cwd`, and both provider home overrides; it rejects `sessionId`, `worktreeId`, `resume`, and other extra fields. It uses the same explicit, inherited, injected, absent, selected-account, and System default resolution as `prepare`, including managed-home ownership/authentication checks and Codex config-warning synchronization. Any Codex config synchronization writes only to the verified managed profile; the System default config is read-only. Its result has `shellInit: null` and never creates, updates, or fabricates an `account_sessions` row or resume transcript.

`account.authKind` is non-secret selected-account metadata (`oauth`, `api-key`, `none`, or `unknown`). Provider API probes use it to distinguish API-key access from OAuth sign-in; OAuth tokens are never used as model-list API keys.

The returned `env` is an environment patch, not credentials. String values are applied; `null` means delete that variable from the child environment. The CLI command reports the resolved account and environment variable names without printing environment values:

```sh
orca accounts prepare-provider-env --agent codex --cwd "$PWD" --home-overrides '{"claude":{"value":null,"source":"absent"},"codex":{"value":null,"source":"absent"}}'
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
