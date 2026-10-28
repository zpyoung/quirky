# Browser/mobile sweep technical specification

Status: approved autonomously 2026-10-28. Behavior: sibling logic.md. Parent owns integration; no new public RPC/schema is needed for terminal links.

## Architecture and contracts
Reuse MobilePreferences.terminalLinkMode ('desktop'|'phone'), createMobileRpc, route/grant bridge and quirky.mobile/browserWatchCreate({worktree:string,url?:string}) returning {tab:MobileWorkspaceTab,watchId:string}. A SessionPage link handler selects only that returned real tab in the current worktree. TerminalView receives an owner callback for desktop links; it must not introduce a second preference or directly create a lease. Normalize/validate safe http(s) URL before any launch; no inferred Native conversion or phone fallback. Settings labels the mode Chrome Watch and saves the existing enum; keep Phone default. Guard duplicate pending creation and stale route/connection/unmount completion. Never release a foreign consumer lease.

## Always / never
Keep public browser/mobile method allowlists, route metadata/grants and exact worktree/tab/watch/connection identity. Never widen generic page browser authority, weaken bundle route validation, infer origin from createdBy=api, suppress runtime errors, replace production consent with fixtures, write real homes, or edit protected LOOP/scripts/build-loop/shared queue/index. Tests deleting incidental wording assertions must retain surrounding behavioral coverage. Native missing capabilities are not implementation stubs to fill with alternate engines.

## Components and write scopes
One wave,3 components, no semantic edges after this shared contract commit:
1. PhoneLinks owns apps/mobile/src/native/SettingsScreen.tsx, src/pages/TerminalView.tsx, src/pages/SessionPage.tsx, any focused new terminal-link helper/test, and apps/mobile/test/session-tabs.test.tsx. Reuse unchanged backend APIs. No other component edits these files. Implement S1–S3 and functional regression coverage; no tests/build/lint/formatters mid-flight.
2. MobileContracts owns the remaining apps/mobile/test files and necessary apps/mobile/src/shell or src/panels producer-consumer fixes, plus plugins/quirky.mobile/test files EXCEPT browser-watch.test.ts (BrowserAcceptance owns that), and plugins/quirky.mobile/src/daemon changes only after a concrete observed failure/contract diagnosis. Fix baseline missing helper/imports/route manifests/scope/automation provenance and consent pin regressions without loosening production safety. It must not edit PhoneLinks files; report any test fixture issue requiring them to parent.
3. BrowserAcceptance owns plugins/quirky.browser source/tests and plugins/quirky.mobile/test/browser-watch.test.ts. Fix baseline browser UI incidental assertions and any actual Chrome API/interaction failures after root-cause evidence. Add genuine repeated annotation defect coverage where absent. No blanket skips, fake Chrome or production timeout changes to hide failures.
Parent owns specs/logs/README, scripts/test-on-macos.txt runner placement (not protected build-loop scripts), any shared declarations and final native handoffs/review/runtime smoke.

## Verification
Workers write tests but do not run checks during the wave; parent runs checks once after integration. Root command bun run typecheck includes ui lint/root/mobile/desktop. Run bun scripts/suite.ts plugins/quirky.browser plugins/quirky.mobile apps/mobile and affected imports using remote suite routing, with Chrome-dependent files explicitly assigned to macOS where Chrome is installed. Run bun test scripts. Actual production daemon+real PTY+encrypted phone plus built web page drives both terminal-link destinations; Browser harness may use isolated --use-mock-keychain only, and proof is labeled as such rather than default-keychain/real-phone proof. UI dogfood uses visible controls through likeuser web only; no foreground/native run. All owned processes and scratch homes are cleaned before land.

## Migration and cleanup
No durable schema migration. Both existing enum values remain valid; Phone default stays unchanged. Obsolete unavailable-copy removed. Root owner merges components then removes their /tmp worktrees immediately. Catch up once before final review and land; read incoming binding decisions. No test-only or review-only queue item.
