# fix-native-m3-accounts-1028 decisions

## D1: Route the Codex sign-in Open action through the existing public system-handler API
- **Question:** Why does the native sign-in card's Open action do nothing, and which boundary should own opening?
- **Options:** add native popup handling for all links; use the existing `quirky.terminal/openExternal` method from this UI action.
- **Chose:** replace the Codex `target="_blank"` action with an explicit public API call using the already approved login URL, preserving Copy and Cancel.
- **Why:** the native run reports Copy and Cancel working and the plain anchor failing; its terminal link popover opens the system browser on the same machine. The terminal public API already validates the target and passes it as a single argument to macOS `open`, without a shell. No new transport or embedded-browser routing is needed.
- **Evidence:** native run `/Users/zpyoung/orca/workspaces/quirky/native-qa/.quirk/using-apps-like-a-user/runs/20261028T060850-9953/report.md:34-50`; `plugins/quirky.accounts/src/window/AccountsSettings.tsx:28-49`; `plugins/quirky.terminal/src/open-external.ts:15-42`; `plugins/quirky.terminal/src/window/pane/TerminalPaneView.tsx:356-358`.
- **Reversibility:** easy (UI action only).
- **Confidence:** high.
- **Revisit if:** a client-local external opener replaces this existing public system-handler contract.
- **Source:** assumed — autonomous

## D2: Keep the repair limited to the named native failure
- **Question:** Should blocked focus/Keychain/restart scenarios or unrelated provider documentation anchors change too?
- **Options:** expand this repair to all native report findings; repair only AC6-AC7-native-link.
- **Chose:** only the named sign-in Open failure, with visible recoverable opening errors. Preserve the existing native report as historical evidence and reset only the repaired scenario to pending.
- **Why:** the claimed queue item names only AC6-AC7-native-link. Other scenarios have separate evidence and owners. A failed browser handoff must leave Copy and Cancel usable, not mark sign-in complete or lose the approved URL.
- **Evidence:** `docs/loop/native/m3-accounts.json`; native report F1/F2/F3.
- **Reversibility:** easy.
- **Confidence:** high.
- **Revisit if:** evidence identifies a shared cause in another flow.
- **Source:** locked by docs/loop/LOOP.md

## D3: Separate isolated handoff evidence from native browser acceptance
- **Question:** What verification is safe and sufficient before the build-first landing gate?
- **Options:** repeat real native sign-in/browser QA; use a bounded isolated surface smoke, author the regression, and leave native revalidation pending.
- **Chose:** production AccountsSettings plus AccountsUiStore in an owned Chromium tab; controlled public-context transport to the real terminal target validator/opener with its existing `QUIRKY_TEST_OPEN_LOG` boundary. No OAuth request, real clipboard operation, native window, or actual browser launch.
- **Why:** the smoke exercised a rejected handoff with usable Copy/Cancel, a successful retry that removed the alert, and Cancel removing the notice. The opener receipt preserved the complete fixture authorize URL including `%2B`, `%3A`, and `%2F`, with reveal=false. This is surface/handler evidence, not packaged native acceptance. The permanent regression covers in-flight controls, failure recovery, retry, and cancellation; no suite was run under build-first.
- **Evidence:** owned smoke `l12-account-link-smoke-r3` served the actual production components; Chromium screenshots and exact one-line opener receipt observed. Initial harness startup failed to resolve React dependencies; corrected only the throwaway dependency resolution. An incorrect smoke `tab.waitFor` selector generated one tool-origin page error; corrected with `page.waitForFunction`, which confirmed retry and cancellation state. `bun run typecheck` exited 0 in 31.06s, including UI lint, root, mobile, and desktop.
- **Reversibility:** easy.
- **Confidence:** high for exercised surface/handler behavior; native browser launch awaits the native run.
- **Revisit if:** the pending native scenario still cannot open the exact approved URL.
- **Source:** assumed — autonomous

## Progress
Public API handoff, recoverable-error UI, permanent regression, README, and native pending reset implemented. Isolated surface/handler smoke complete; owned browser tab released and server stopped. Canonical typecheck passed; no suites or native dogfood run. Next: single roadmap catch-up, read incoming decisions, final typecheck, commit and land.
