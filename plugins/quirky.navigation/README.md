# quirky.navigation

`quirky.navigation` answers go-to-definition and find-references for TypeScript, JavaScript, and Python files. It reads files from disk; unsaved editor buffers are not included.

## CLI and daemon API

Run these commands from a registered worktree. Paths are worktree-relative or absolute paths inside that worktree.

```sh
quirky nav definition src/use.ts --line 4 --column 27 [--json]
quirky navigation references src/use.ts --line 4 --column 27 [--json]
quirky nav status [--json]
quirky nav stop [--worktree SELECTOR] [--language typescript] [--json]
```

The daemon methods are `quirky.navigation/definition`, `quirky.navigation/references`, `quirky.navigation/status`, and `quirky.navigation/stop`. Definition and reference calls take `path`, `line`, and `column`, with an optional `worktree`; without one, the caller's current worktree is used. Results include the worktree ID, language, locations, and a `truncated` flag. Each location has an absolute path, a worktree-relative path when applicable, a preview, and start/end positions.

Lines and columns are 1-based. Columns and end columns count UTF-16 code units. Results are limited to 1,000 locations; `truncated` reports when that limit cuts off results.

## Servers and limits

Navigation starts one TypeScript server per worktree on first use. It prefers `<worktree>/node_modules/typescript/lib/tsserver.js`, then TypeScript resolvable from this plugin in the repository. If neither is available, the call fails with `NotFound`. The server runs with `node` from `PATH` when available, otherwise with Bun.

At most two TypeScript servers run at once. When both are busy, another worktree's request fails with a conflict; when capacity is needed, the least-recently-used idle server is stopped. Servers also stop after 10 idle minutes. A request that does not answer within 120 seconds stops its server. `status` lists running servers, including their PID, runtime, server path, request count, and in-flight count. `stop` stops all servers, or filters by worktree and language.

## Python

Python navigation supports `.py` and `.pyi` files through the bundled standard-library resolver. It needs Python 3.8 or newer, found as `python3` on the daemon's `PATH`, and runs it in isolated mode. It answers from disk and never imports or runs worktree code.

Definitions follow imports and re-exports, lexical bindings, classes, methods, and statically inferred instance attributes. Import lookup checks the parent of the file's outermost package, the worktree root, then `<worktree>/src`. Only worktree files are resolved; an unavailable import points to its own import name. This is navigation, not a type checker: string annotations and flow-sensitive inference are not supported.

References include declarations and scan `.py` and `.pyi` files, skipping hidden directories, `node_modules`, `__pycache__`, `site-packages`, directories containing `pyvenv.cfg`, symlinks, and files larger than 2 MiB. Unparseable files are skipped. Renamed import uses are not references of the original spelling.

At most four Python servers run at once, one per worktree. They share the 10-minute idle stop and 120-second request timeout described above. Use `quirky nav stop --language python` to stop them.
