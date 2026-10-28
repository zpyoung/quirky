# fix-desktop-startup-imports decisions

## D1: Restore the missing runtime and route imports without changing startup behavior
- **Question:** What caused the reported packaged startup failure?
- **Options:** restore imports; redesign startup/error handling
- **Chose:** restore the `electrobun/main` runtime/type imports and `./desktop-window-route` function imports.
- **Why:** The startup module uses `app.isPackaged` before constructing the window, and commit 35b193b5 removed its Electrobun import while adding route helper calls without importing them. Undefined bindings are the cause, not a daemon timeout.
- **Evidence:** apps/desktop/src/bun/index.ts:1-39; git show 35b193b5 -- apps/desktop/src/bun/index.ts; queue item failure report.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** prepared desktop typechecking exposes a changed Electrobun API.
- **Source:** assumed — autonomous

## D2: Make public root build and typecheck commands own desktop preparation
- **Question:** How should clean checkouts obtain the Electrobun generated package before building or typechecking desktop?
- **Options:** require a manual prepare step; compose preparation into existing root commands
- **Chose:** use existing Hutch/Electrobun preparation in the root command dependency chain and include the desktop TypeScript project.
- **Why:** The reported root build failure and omitted desktop diagnostics share an unowned preparation prerequisite; land must reject unresolved desktop names.
- **Evidence:** queue item fix-desktop-startup-imports; build/typecheck command investigation by DesktopBuildGate.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Hutch package resolution or generated Electrobun package layout changes.
- **Source:** assumed — autonomous

## D3: Verify the requested packaged native window with an isolated runtime
- **Question:** Does build-first policy permit the explicitly requested native startup check?
- **Options:** defer all runtime verification; perform the exact requested build and native launch
- **Chose:** build the app and launch its executable with fresh HOME/QUIRKY_HOME/provider homes; inspect its actual native window and stop only owned processes.
- **Why:** This repair item's explicit acceptance criterion is a visible packaged window. No broad suite, dogfood campaign or review round is needed.
- **Evidence:** queue item title; docs/loop/NATIVE.md:16-18,34-39.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** native observation permissions prevent proving the window.
- **Source:** assumed — autonomous

## D4: Use the desktop compiler gate as the import-regression check
- **Question:** Which regression guard catches undefined desktop bindings without source-text assertions or mocking the native SDK?
- **Options:** assert import source strings; add fake native startup tests; include the prepared real desktop project in root typecheck
- **Chose:** compiler coverage plus a disposable missing-import mutation and actual packaged native launch.
- **Why:** In the isolated snapshot, removing both imports made the root command exit 2 with 28 desktop diagnostics, including missing `app`, `folderPickerResult`, and `desktopWindowRouteUrl`; restoring them made the same command exit 0. This checks the actual public command, not implementation text.
- **Evidence:** root typecheck mutation receipt, 28.30s failure / 27.57s restored success; apps/desktop/tsconfig.json includes src, test, scripts and configuration.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the root command stops invoking the prepared desktop project.
- **Source:** assumed — autonomous

## Progress
Implemented the two startup imports, root desktop typecheck inclusion, automatic desktop build preparation, and desktop README updates. DesktopBuildGate returned; no agent remains running.

Verification completed before catch-up:
- Copied source into a disposable snapshot with no `.git`, `node_modules`, `.hutch`, desktop outputs/resources or package dist directories. `bun install --frozen-lockfile` installed 1074 packages; the SDK remained absent until the root build invoked preparation.
- Root `bun run build` exited 0 in 18.42s and produced the unpacked `apps/desktop/build/Quirky.app`, bundling all 30 built-in plugins. Existing icon-source and release.baseUrl warnings did not prevent packaging.
- Deleted only the snapshot's generated `.hutch` directory; root `bun run typecheck` prepared the SDK and passed all root/mobile/desktop projects in 27.98s.
- Packaged launcher PID32462 spawned native shell PID32594, daemon PID32617 and PTY host PID32619 under `/tmp/qfix6-r8cp7D`, with HOME/provider/config isolation and inherited Git/runtime pointers removed. Native computer observation captured visible nonminimized window42541, titled Quirky, 1054×932; its screenshot showed the real empty-workspace UI, not an error screen.
- Launcher printed `BootstrapInstallFailed` / install integration FileNotFound before continuing to the rendered window; no install/bootstrap correctness claim is made by this startup repair.
- Stopped the owned launch service; it exited 0, process-scope cleanup completed, the temporary home was removed, and `ps` returned no rows for all four owned PIDs. Existing user's Quirky PID16698 was not targeted.
- Disposable missing-import mutation: root typecheck exited 2 with 28 desktop diagnostics in 28.30s; restoring imports passed in 27.57s. No permanent suite, review round or broader native scenario campaign ran.

Catch-up `git merge build/roadmap` reported already up to date; no incoming decisions to reconcile. Final root `bun run typecheck` on the actual item branch passed all root/mobile/desktop projects, including preparation, in 27.91s. Native screenshot, owned-process receipt and compact verification metadata are preserved beside the lane's loop notes as `desktop-startup-fix-evidence.tgz`. Ready to detach and land through the canonical queue; remove the owned temporary snapshot after land.
