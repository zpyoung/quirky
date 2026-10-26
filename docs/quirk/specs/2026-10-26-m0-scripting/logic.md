# Scripting surface: schemas for every contribution, CLI generated from them, quirky api --json, generated agent skill

## Status & amendments

**Status:** Approved (headless build loop; decisions in [m0-scripting.md](../../../loop/decisions/m0-scripting.md)). Tech spec: requested.

**Amendments:**
- 2026-10-26, tech-spec authoring: root help and help for kernel groups stay offline, as an existing test requires, and point to `quirky api` for plugin commands (SC-16, decision D28).
- 2026-10-26, before approval: Codex adversarial review. The CLI checks a generated command's whole params object against the schema, `--params` included (SC-11, SC-19); a kernel command shadows generated commands that extend its words (SC-13); a valued flag followed by `--...` is missing its value (SC-11, SC-18); catalog commands list every method they may call (SC-20); enums need a type (SC-2); SC-23 enables a plugin instead of installing one, since discovery runs at startup.

## Conceptual model

The roadmap promises that an agent can drive anything a person can through the daemon API or the
`quirky` CLI, and that every plugin gets a namespaced CLI command group without writing CLI code
([roadmap.md](../../../roadmap.md#m0-plugin-kernel-with-v1-moved-onto-it)). Until now a plugin's
`method` contribution had a name and a description and nothing else, so neither the CLI nor an
agent could tell what it takes. This item gives every method, event and UI command a **schema**,
and builds three things from those schemas: the CLI's commands, a catalog agents read with
`quirky api --json`, and an agent skill.

**Schemas.** A schema is a flat subset of JSON Schema: `type`, `description`, `enum`, `items`,
`properties`, `required`, a boolean `additionalProperties`, `minimum`, `maximum` and a
documentation-only `default`, with `{}` meaning any value. An `enum` needs a `type` of `string`,
`integer` or `number`, and every listed value must have that type ([D4](../../../loop/decisions/m0-scripting.md)).
Contributions declare them in the manifest, beside the fields they already have ([D5](../../../loop/decisions/m0-scripting.md)):

| Kind | New fields | Omitted means |
|---|---|---|
| `method` | `params` (an object schema), `result` | takes no parameters; result of any shape |
| `event` | `data` | carries no data |
| `command` (UI) | `args` | takes no arguments |

The kernel's own 47 methods and its events get schemas too, kept in one table that the type
checker holds complete ([D7](../../../loop/decisions/m0-scripting.md)).

**Validation.** The daemon checks every method call's params against the method's schema before it
activates or runs any plugin code, for kernel and plugin methods alike. Nothing is coerced, and
properties the schema doesn't declare are refused unless it allows them. Results and event data
are documentation and are not checked ([D6](../../../loop/decisions/m0-scripting.md)).

**The catalog.** A new kernel method, `api.describe`, returns every in-effect method and event with
its schema, and every UI command with its `args`. The CLI adds its own commands to that and prints
the whole thing as `quirky api --json` ([D17](../../../loop/decisions/m0-scripting.md)).

**Generated commands.** Each in-effect plugin method `<pluginId>/<name>` is a CLI command
`quirky <group> <name>`. The group is the plugin ID, without the reserved `quirky.` prefix for a
built-in ([D10](../../../loop/decisions/m0-scripting.md)). Each top-level param is a kebab-case flag,
and `--params` takes the whole params object as JSON ([D12](../../../loop/decisions/m0-scripting.md)).
The CLI reads the catalog from the daemon whenever it needs plugin commands, so it never lags behind
the plugins that are installed ([D20](../../../loop/decisions/m0-scripting.md)).

**One command table.** The kernel's hand-written commands (`repo add`, `wt create`, ...) keep their
code and output, but each now declares its positionals and typed flags with descriptions. Usage
lines, help, parsing, typo suggestions and the catalog are all produced from those declarations,
for kernel and generated commands alike ([D9](../../../loop/decisions/m0-scripting.md)).

**The skill.** `quirky skill show` prints a `SKILL.md` generated from the catalog, and
`quirky skill install --dir <dir>` writes it where an agent loads skills ([D19](../../../loop/decisions/m0-scripting.md)).

All of this is kernel: validation sits in the dispatch path every plugin method takes, and the
generator is the CLI itself ([D21](../../../loop/decisions/m0-scripting.md)).

## Data flow

**Declaring.** When the daemon reads a manifest, it checks each `params`, `result`, `data` and
`args` schema along with the rest of the contribution. A schema that uses an unsupported keyword or
is malformed makes the plugin `invalid`, with a diagnostic naming the contribution and the problem,
as any other manifest error does.

**Calling a method.** A call arrives from a client or from a plugin's `context.call`. The dispatcher
finds the method's in-effect declaration, checks the params against its schema, and only then
activates the plugin (if lazy) and runs its handler. A failed check is an InvalidParams error naming
the first failing path, such as `params.count must be an integer`, and the plugin stays inactive.
Kernel methods go through the same check before their own handler runs.

**Running a CLI command.** The CLI splits the leading words of the command line.
1. If they name a kernel command, the CLI parses its flags from the command's declaration and runs
   it. The catalog isn't fetched. A kernel command owns its words as a prefix: a generated command
   whose words start with a kernel command's full words (`status list` when `status` is a kernel
   command) is shadowed by it.
2. Otherwise the CLI calls `api.describe`, builds the generated commands from it and looks again.
   A generated command's flags are parsed strictly against the method's schema, and the assembled
   params are checked against the whole schema; then the CLI calls the method and prints the result.
3. If nothing matches, the CLI prints suggestions drawn from both kinds of command and exits 2.

**Discovery.** `quirky api --json` prints the catalog: `api.describe`'s methods, events and UI
commands, plus every CLI command, kernel and generated, with its flags and the methods it may call.
`quirky skill show` renders the same catalog as a skill file.

## Key decisions

- **Schemas in the manifest, read at run time** ([D24](../../../loop/decisions/m0-scripting.md)). Listing,
  help and validation never run plugin code, which keeps lazy activation (m0-registry D23). Building
  CLI code at build time would miss plugins installed later, which is how Orca's CLI ended up
  calling `ledger list` an unknown command.
- **Strict in, tolerant out** ([D6](../../../loop/decisions/m0-scripting.md), [D13](../../../loop/decisions/m0-scripting.md)).
  Params are checked twice, by the CLI for a friendly flag error and by the daemon as the authority,
  with no coercion. Results aren't checked, so a plugin's sloppy result degrades documentation
  rather than breaking its callers.
- **Precedence on shared words** ([D11](../../../loop/decisions/m0-scripting.md)). Kernel commands win
  over built-in plugins' generated commands, which win over installed plugins'. The loser is
  reported, never silently dropped, and stays callable through `quirky api call`. A kernel command
  also shadows any generated command whose words extend its own.
- **JSON errors for scripts** ([D15](../../../loop/decisions/m0-scripting.md)). Under `--json` an error is
  a JSON document on stdout. Exit codes stay 0 (ok), 1 (runtime error) and 2 (usage error).
- **A generic caller** ([D18](../../../loop/decisions/m0-scripting.md)). `quirky api call <method>`
  reaches every method, including kernel methods with no command of their own.

## Behavior & scenarios

Fixtures are illustrative. Every scenario runs against a fresh temporary `QUIRKY_HOME` with a real
`quirkyd` and a fake PTY host, and is driven through the `quirky` CLI or the daemon API, as each says.

Most scenarios use the installed plugin `acme.notes`, with lazy activation and these contributions:

| Contribution | Schema |
|---|---|
| method `add` | params: `title` string (required), `body` string, `tags` array of strings, `pinned` boolean, `priority` integer 1 to 5, `color` enum `red`/`blue`, `meta` object; result: object with `id` and `title` |
| method `list` | params: `limit` integer; result: array of note objects |
| method `count` | no params; result: integer |
| event `added` | data: object with `id` |
| command `open` (UI) | args: object with `noteId` string (required) |

### Schemas and validation

1. **SC-1: a plugin method's schema is in the catalog, and listing it loads nothing** (CLI, API)
   - **Given** `acme.notes` is installed and inactive
   - **When** the agent runs `quirky api --json`
   - **Then** the catalog lists method `acme.notes/add` with its description, its `params` and `result` schemas and source `acme.notes`; event `acme.notes/added` with its `data` schema; UI command `command:acme.notes/open` with its `args` schema; and the command `acme.notes add` calling `acme.notes/add`. `acme.notes` is still inactive.
   - **Data before:** **acme.notes**: inactive
   - **Walkthrough:**
     1. The agent runs `quirky api --json`
     2. The CLI calls `api.describe`, then adds its commands
   - **Data after:** **Catalog**: ✓ method `acme.notes/add`; ✓ event `acme.notes/added`; ✓ UI command `command:acme.notes/open`; ✓ command `acme.notes add`; **acme.notes**: ✓ still inactive

2. **SC-2: a malformed schema makes the plugin invalid** (API)
   - **Given** one installed plugin per problem below
   - **When** the daemon starts
   - **Then** each is `invalid` with a diagnostic naming the contribution and the problem, and the other plugins work
   - **Diagnostics:**

     | Problem | Diagnostic says |
     |---|---|
     | method `m` with `params: { "type": "string" }` | `method m: params must be an object schema` |
     | method `m` whose params use `oneOf` | `method m: params: unsupported keyword oneOf` |
     | method `m` with a property of `type: "date"` | `method m: params.properties.when: unknown type date` |
     | method `m` with `required: ["x"]` and no property `x` | `method m: params: required names undeclared property x` |
     | method `m` with `enum: []` | `method m: params.properties.color: enum must be a non-empty list` |
     | method `m` with `enum: ["1", 1]` and no `type` | `method m: params.properties.choice: enum needs type string, integer or number` |
     | method `m` with `type: "string"` and `enum: ["a", 2]` | `method m: params.properties.choice: enum values must be strings` |
     | method `m` with properties `fooBar` and `foo-bar` | `method m: params fooBar and foo-bar both map to --foo-bar` |
     | event `e` with `data: "object"` | `event e: data must be a schema object` |
     | UI command `c` with `args: { "type": "array" }` | `command c: args must be an object schema` |

3. **SC-3: bad params are refused before the plugin activates** (API)
   - **Given** `acme.notes` is inactive
   - **When** a client calls `acme.notes/add` with each set of params below
   - **Then** each call fails with InvalidParams and the message shown, and `acme.notes` is still inactive
   - **Rejections:**

     | Params | Message |
     |---|---|
     | `{}` | `params.title is required` |
     | `{"title": 5}` | `params.title must be a string` |
     | `{"title": "a", "priority": "3"}` | `params.priority must be an integer` |
     | `{"title": "a", "priority": 9}` | `params.priority must be at most 5` |
     | `{"title": "a", "color": "green"}` | `params.color must be one of red, blue` |
     | `{"title": "a", "tags": ["x", 1]}` | `params.tags[1] must be a string` |
     | `{"title": "a", "colour": "red"}` | `params.colour is not allowed` |

4. **SC-4: a method with no declared params takes none** (API)
   - **Given** `acme.notes/count` declares no `params`
   - **When** a client calls it with `{}`, then with `{"verbose": true}`
   - **Then** the first returns its result; the second fails with InvalidParams `params.verbose is not allowed`

5. **SC-5: `additionalProperties: true` lets undeclared properties through** (API)
   - **Given** method `acme.notes/import` declares params with property `source` and `additionalProperties: true`
   - **When** a client calls it with `{"source": "a", "extra": 1}`
   - **Then** the handler receives both properties

6. **SC-6: kernel methods have schemas, and the daemon checks them** (API, CLI)
   - **Given** the daemon is running
   - **When** the agent runs `quirky api --json`, and a client calls `repo.add` with `{"path": 5}`
   - **Then** every kernel method, `api.describe` included, is in the catalog with source `kernel` and a `params` schema; the call fails with InvalidParams `params.path must be a string`
   - Calls the existing desktop window, CLI and tests make keep working: a kernel schema accepts everything its handler accepts.

7. **SC-7: results and event data are not checked** (API)
   - **Given** `acme.notes/add` declares a result object with `id` and `title`, and its handler returns `{"id": 1}` and emits `added` with `{"noteId": 1}`
   - **When** a subscribed client calls `acme.notes/add` with `{"title": "a"}`
   - **Then** the call returns `{"id": 1}` and the client receives the `acme.notes/added` event with `{"noteId": 1}`

8. **SC-8: an override brings its own schema** (API, CLI)
   - **Given** installed `acme.better` overrides `method:acme.notes/add` with params that also allow `color: "green"`
   - **When** the agent runs `quirky api --json` and a client calls `acme.notes/add` with `{"title": "a", "color": "green"}`
   - **Then** the catalog shows the override's schema, with source `acme.better`, and the call reaches `acme.better`'s handler

### Generated commands

9. **SC-9: a plugin method is a CLI command** (CLI)
   - **Given** `acme.notes` is installed
   - **When** the agent runs `quirky acme.notes add --title "Groceries" --tags home --tags weekly --pinned --priority 2 --meta '{"src":"cli"}' --json`
   - **Then** the CLI calls `acme.notes/add` with the params below and prints the result as one JSON document; exit 0
   - **Walkthrough:**
     1. The agent runs the command
     2. The CLI fetches the catalog and finds `acme.notes add`
     3. The CLI parses the flags against the method's schema
     4. The CLI calls `acme.notes/add`
   - **Data after:** **Params sent**: ✓ `{"title": "Groceries", "tags": ["home", "weekly"], "pinned": true, "priority": 2, "meta": {"src": "cli"}}`; **Output**: ✓ `{"id":7*,"title":"Groceries"}`

10. **SC-10: each schema type has one flag form** (CLI)
    - **Given** `acme.notes add`
    - **When** the agent passes each flag form below
    - **Then** the param gets the value shown
    - **Flag forms:**

      | Param schema | Flag | Param value |
      |---|---|---|
      | `title` string | `--title 42` | `"42"` (stays a string) |
      | `priority` integer | `--priority 3` or `--priority=3` | `3` |
      | `pinned` boolean | `--pinned` / `--pinned=false` | `true` / `false` |
      | `color` enum | `--color blue` | `"blue"` |
      | `tags` array of strings | `--tags a --tags b` | `["a", "b"]` |
      | `meta` object | `--meta '{"k":1}'` | `{"k": 1}` |
      | any property `fooBar` | `--foo-bar` | sets `fooBar` |

11. **SC-11: a bad flag value is a usage error, and the method isn't called** (CLI)
    - **Given** `acme.notes` is inactive
    - **When** the agent runs each command below
    - **Then** each prints the error shown on stderr and exits 2, and `acme.notes` is still inactive
    - **Usage errors:**

      | Command | Error |
      |---|---|
      | `quirky acme.notes add --title a --priority high` | `--priority must be an integer, got "high"` |
      | `quirky acme.notes add --title a --color green` | `--color must be one of red, blue, got "green"` |
      | `quirky acme.notes add --title a --pinned=yes` | `--pinned is a switch; got "yes"` |
      | `quirky acme.notes add --title a --meta '{oops'` | `--meta must be JSON: ...` |
      | `quirky acme.notes add --title a --priority 9` | `--priority must be at most 5` |
      | `quirky acme.notes add --title` | `--title requires a value` |
      | `quirky acme.notes add --title --pinned` | `--title requires a value; write --title=<value> for a value starting with --` |
      | `quirky acme.notes add --params '{"title":1}'` | `params.title must be a string` |
      | `quirky acme.notes add` | `missing required flag --title` |
      | `quirky acme.notes add --title a extra` | `unexpected argument "extra"` |

12. **SC-12: `--params` gives the whole params object** (CLI)
    - **Given** `acme.notes add`, and method `acme.notes/raw` with a param named `json`
    - **When** the agent runs (a) `quirky acme.notes add --params '{"title":"a","tags":["x"]}'`, (b) `quirky acme.notes add --params '{"title":"a"}' --title b`, (c) `quirky acme.notes raw --params '{"json":true}'`
    - **Then** (a) calls the method with `{"title": "a", "tags": ["x"]}`, after checking the object against the schema as SC-11 does; (b) exits 2 with `title is given by both --params and --title`; (c) calls `acme.notes/raw` with `{"json": true}`, since `--json` stays the global switch

13. **SC-13: a built-in's group drops `quirky.`, and kernel commands win on shared words** (CLI)
    - **Given** built-in `quirky.repo` declares methods `list` and `rename`, installed plugin `job` declares method `list`, and installed plugin `status` declares method `list`
    - **When** the agent runs `quirky repo rename --repo-id r1 --name x`, `quirky repo list`, `quirky job list`, `quirky status list` and `quirky api --json`
    - **Then** `repo rename` calls `quirky.repo/rename`; `repo list` and `job list` run the kernel commands; `status list` runs the kernel `status` command, which refuses the extra word (`unexpected argument "list"`, exit 2); the catalog lists command `repo list` from `quirky.repo`, `job list` from `job` and `status list` from `status`, each marked as shadowed by the kernel command, and `quirky api call quirky.repo/list` still calls the built-in's method
    - **Data after:** **Commands**: ✓ `repo rename` → `quirky.repo/rename`; ✓ `repo list` → kernel; `repo list` (quirky.repo) shadowed by kernel; `job list` (job) shadowed by kernel; `status list` (status) shadowed by kernel `status`

14. **SC-14: a generated command prints a readable text form** (CLI)
    - **Given** methods returning each result below
    - **When** the agent runs the command without `--json`
    - **Then** the output is as shown
    - **Text forms:**

      | Result | Printed |
      |---|---|
      | `"done"` or `3` | `done` or `3` |
      | `null` or `{"ok": true}` | `ok` |
      | `{"id": 7, "title": "Groceries", "tags": ["home"]}` | `id: 7`, `title: Groceries`, `tags: ["home"]`, one per line |
      | `[{"id": 7, "title": "A"}, {"id": 8, "title": "B"}]` | a table with columns `ID` and `TITLE` |
      | `[]` | `none` |
      | `["a", {"b": 1}]` | `"a"` and `{"b":1}`, one per line |

15. **SC-15: a plugin method can be disabled and enabled without touching the CLI** (CLI)
    - **Given** `acme.notes` is installed
    - **When** the agent runs `quirky plugin disable method:acme.notes/add`, then `quirky acme.notes add --title a`, then `quirky plugin enable method:acme.notes/add` and the same command again
    - **Then** while disabled, the command is unknown (exit 2, with `acme.notes list` among the suggestions) and is missing from `quirky api --json`; after enabling, it runs and is listed again. Orca's CLI rejected commands its own app served when the CLI bundle was older than the app ([cli.md](../../../../research/orca-features/cli.md#verified-in-the-app)); Quirky's can't fall behind.

### Help and errors

16. **SC-16: help covers kernel and plugin commands from their declarations** (CLI)
    - **Given** `acme.notes` is installed
    - **When** the agent runs `quirky --help`, `quirky acme.notes --help`, `quirky acme.notes add --help` and `quirky wt create --help`
    - **Then** root help lists the kernel commands and ends with `run 'quirky api' to list every command, including plugins'`, without contacting the daemon; group help for `acme.notes` lists `add`, `count`, `list` with their descriptions; command help shows a usage line, the description, and one line per flag with its type, whether it is required, its enum values and its description; `wt create --help` has the same shape, from its declaration. Help for a kernel command or a group that has kernel commands never contacts the daemon, as today; help for a plugin-only group or command reads the catalog.
    - **Command help:**

      ```
      usage: quirky acme.notes add --title <string> [--body <string>] [--tags <string>]... [--pinned] [--priority <integer>] [--color red|blue] [--meta <json>]

      Add a note.

      options:
        --title <string>      required  The note's title
        --body <string>                 The note text
        --tags <string>...              Tags; repeat the flag
        --pinned                        Pin the note
        --priority <integer>            1 to 5
        --color red|blue
        --meta <json>
        --params <json>                 all params as one JSON object

      global: --json prints machine-readable JSON
      ```

17. **SC-17: an unknown command gets suggestions** (CLI)
    - **Given** `acme.notes` is installed
    - **When** the agent runs `quirky wt lst`, `quirky acme.note add` and `quirky zzz`
    - **Then** each exits 2; the first prints `unknown command "wt lst"` and `did you mean: quirky wt list`; the second `did you mean: quirky acme.notes add`; the third has no suggestion line
    - **Data after:** **stderr** (first): ✓ `quirky: unknown command "wt lst"`, `did you mean: quirky wt list`

18. **SC-18: an unknown flag names the valid ones, and a valued flag needs its value** (CLI)
    - **Given** the daemon is running
    - **When** the agent runs `quirky wt list --bogus`, `quirky session new --agent claude --worktree w1 --prompt` with nothing after `--prompt`, and the same with `--prompt --json`
    - **Then** the first exits 2 with `unknown flag --bogus for wt list` and `valid flags: --repo, --json, --help`; the second and third exit 2 with `--prompt requires a value` (the third adds `write --prompt=<value> for a value starting with --`) and start no session. A value that starts with `--` is passed as `--prompt=--x`. Orca made a missing value an error because a shell-eaten value once sent a prompt twice ([cli.md](../../../../research/orca-features/cli.md#global-flags-every-command-srcsharedcli-argument-boundaryts1-2)).

19. **SC-19: under `--json`, an error is JSON on stdout** (CLI)
    - **Given** the daemon is running, and separately one that isn't reachable
    - **When** the agent runs each command below with `--json`
    - **Then** stdout holds one JSON document as shown, stderr is empty, and the exit code is as shown
    - **JSON errors:**

      | Command | stdout | Exit |
      |---|---|---|
      | `quirky wt lst --json` | `{"error":{"code":"usage","message":"unknown command \"wt lst\"","suggestions":["wt list"]}}` | 2 |
      | `quirky acme.notes add --json` | `{"error":{"code":"usage","message":"missing required flag --title"}}` | 2 |
      | `quirky plugin enable nope --json` | `{"error":{"code":"not-found","message":"..."}}` | 1 |
      | `quirky acme.notes add --params '{"title":1}' --json` | `{"error":{"code":"usage","message":"params.title must be a string"}}` | 2 |
      | `quirky api call repo.add --path '' --json` | `{"error":{"code":"invalid-params","message":"path must be a non-empty string"}}` | 1 |
      | any command, daemon unreachable | `{"error":{"code":"daemon-unavailable","message":"..."}}` | 1 |

    - The CLI catches what the schema rules out before calling (exit 2); a daemon InvalidParams, from a check the schema can't express, exits 1.
    - Without `--json`, errors stay as today: `quirky: <message>` on stderr, plus `run 'quirky help' for usage` for usage errors.

### Discovery and the skill

20. **SC-20: `quirky api` lists everything; `--json` is the catalog** (CLI)
    - **Given** `acme.notes` is installed
    - **When** the agent runs `quirky api` and `quirky api --json`
    - **Then** the text form lists commands by group with their summaries and ends with the number of methods and events; the JSON form is the catalog below, every list sorted by name
    - **Catalog:**

      ```json
      {
        "schemaVersion": 1,
        "daemonVersion": "0.1.0*",
        "protocolVersion": 1,
        "methods": [
          { "name": "acme.notes/add", "source": "acme.notes", "description": "Add a note.",
            "params": { "type": "object", "properties": { "title": { "type": "string" } }, "required": ["title"] },
            "result": { "type": "object" } },
          { "name": "repo.add", "source": "kernel", "params": { "...": "..." }, "result": { "...": "..." } }
        ],
        "events": [ { "name": "acme.notes/added", "source": "acme.notes", "data": { "type": "object" } } ],
        "uiCommands": [ { "id": "command:acme.notes/open", "source": "acme.notes", "args": { "type": "object" } } ],
        "commands": [
          { "command": "acme.notes add", "source": "acme.notes", "methods": ["acme.notes/add"],
            "summary": "Add a note.", "usage": "acme.notes add --title <string> ...",
            "positionals": [],
            "flags": [ { "name": "title", "type": "string", "required": true, "repeatable": false, "description": "The note's title" } ] },
          { "command": "repo add", "source": "kernel", "methods": ["repo.add"],
            "positionals": [ { "name": "path", "required": true } ], "flags": [] }
        ]
      }
      ```

    - `methods` lists every method a command may call: one for a generated command, two for `session new` (`session.create`, or `session.createStructured` with `--background`), and none for commands that call no method, such as `open` and `help`.

21. **SC-21: `quirky api call` reaches any method** (CLI)
    - **Given** a repo has been added
    - **When** the agent runs `quirky api call git.status --worktree-id w1 --json`, `quirky api call acme.notes/count`, `quirky api call terminal.attach` and `quirky api call nope.nothing`
    - **Then** the first prints the git status as JSON; the second prints the count; the third exits 2 with `terminal.attach needs a live connection and can't be called from the CLI`; the fourth exits 2 with `unknown method nope.nothing`

22. **SC-22: the skill is generated from the catalog** (CLI)
    - **Given** `acme.notes` is installed
    - **When** the agent runs `quirky skill show`
    - **Then** it prints a skill file: frontmatter with `name: quirky` and a one-line description, how to discover commands (`quirky api --json`, `--help`), the `--json`, error and exit-code conventions, and one line per command grouped by group, including `quirky acme.notes add --title <string> ...  Add a note.`. Running it twice prints the same bytes.

23. **SC-23: the skill installs into a folder and reports when it is stale** (CLI)
    - **Given** an empty folder `skills/`, and installed plugin `acme.extra`, which declares methods and is disabled
    - **When** the agent runs `quirky skill status --dir skills`, `quirky skill install --dir skills`, `status` again, then `quirky plugin enable acme.extra` and runs `status` and `install` once more
    - **Then** status reads `missing`, install writes `skills/quirky/SKILL.md` and prints `installed`, status reads `up-to-date`; after `acme.extra` is enabled, status reads `stale` and install prints `installed` again, after which status is `up-to-date`. A second install with nothing changed prints `up-to-date` and leaves the file untouched.
    - **Data before:** **skills/**: empty
    - **Walkthrough:**
      1. `skill status` → `missing`
      2. `skill install` → `installed`
      3. `skill status` → `up-to-date`
      4. The agent enables `acme.extra`
      5. `skill status` → `stale`
      6. `skill install` → `installed`
    - **Data after:** **skills/quirky/SKILL.md**: ✓ lists `acme.extra`'s commands

## Scope & non-goals

In scope: schemas on methods, events and UI commands; the daemon's param checks; kernel method and
event schemas; `api.describe`; generated plugin commands; declared kernel commands; help,
suggestions and JSON errors; `quirky api`, `quirky api call` and `quirky skill`.

Not in this item:
- Running a UI command from the CLI, and checking its `args` in the window: m0-ui-bridge ([D8](../../../loop/decisions/m0-scripting.md)).
- Finding and authenticating to the daemon over a unix socket, selectors, `--version`, idempotent request IDs, `status` and `open`: m0-cli-core.
- Confirmation of irreversible actions with `--yes`, and a `destructive` marker on commands: m0-distros.
- Moving v1's command groups into built-in plugins: m0-port-v1.
- cli.md's other flows: remote runtimes, environments and pairing; registering the shell command and the Settings card, including its skill row; caller identity variables; passthrough commands (`claude-teams`) and streamed output; each feature's own command group, which lands with its milestone ([D23](../../../loop/decisions/m0-scripting.md)).
- Positionals on generated commands, and plugin-declared text formatters.
- Installing the skill into an agent's skill folder automatically.

## Decisions Locked

- **Schema language:** flat JSON Schema subset; unsupported keywords make the contribution invalid (D4).
- **Which contributions:** method `params`/`result`, event `data`, UI command `args`; omitted fields have defined meanings (D5).
- **Error responses:** every call's params checked by the daemon, no coercion, undeclared properties refused; results and event data unchecked (D6); kernel schemas enforced the same way (D7).
- **Naming:** `quirky <group> <method>`, group = plugin ID without `quirky.` (D10).
- **Duplicate handling:** kernel, then built-in, then installed; the loser is reported and reachable via `api call` (D11).
- **Flag design:** kebab-case flags, repeatable arrays, JSON for objects, `--params` for the whole object, no positionals (D12); strict parsing with required checks before calling (D13).
- **Output format:** raw result under `--json`, a generic text form otherwise (D14).
- **Error recovery and exit codes:** suggestions for unknown commands, valid flags for unknown flags (D16); JSON errors on stdout under `--json`, exit codes 0/1/2 (D15).
- **Response format and versioning:** one catalog with `schemaVersion: 1` (D17), read fresh on each invocation that needs it (D20).
- **Scope additions:** `quirky api call` (D18) and `quirky skill` (D19).
- **Fast-tracked defaults** (assumed — fast-tracked): D25 covers every remaining default above that no drill-in question changed.

## Industry Insights

- **Static declarations keep discovery cheap.** oclif's manifest cut a CLI's `--version` from 0.65 s to 0.05 s by not importing 3,105 command modules, and VS Code shows contributed commands before their extension activates ([vercel/workflow #4376](https://github.com/vercel/workflow/pull/4376), [VS Code activation events](https://code.visualstudio.com/api/references/activation-events)).
- **Flat schemas map to flags; composed ones don't.** Jargon maps string, integer, number, boolean, array and enum directly and flattens `allOf` with the last definition winning, losing constraints silently ([trans/jargon](https://github.com/trans/jargon)).
- **Don't coerce.** Restish validates only on request and never rewrites input; a value's type comes from how it was written ([rest.sh](https://rest.sh/blog/turn-an-openapi-spec-into-a-cli-without-generating-code/)).
- **Strict requests, tolerant responses.** Speakeasy passes responses through unvalidated by default so drift doesn't break callers ([Speakeasy](https://www.speakeasy.com/mcp/tool-design/generate-mcp-tools-from-openapi)).
- **Large tool lists cost agents context.** Generated MCP tool sets over a few dozen tools degrade model choice, and verbose descriptions cost tokens on every call; the skill lists one line per command for that reason ([Speakeasy](https://www.speakeasy.com/mcp/tool-design/generate-mcp-tools-from-openapi)).
- **Runtime catalogs cache because their servers are remote.** Restish and Google's Workspace CLI cache discovery documents and need an explicit sync; a local daemon makes the cache unnecessary ([Restish](https://rest.sh/docs/reference/openapi-cli-integration/), [googleworkspace/cli](https://github.com/googleworkspace/cli)).
- **Whole-object JSON flags are common.** Google's Workspace CLI takes `--params '<json>'` for request params ([googleworkspace/cli](https://github.com/googleworkspace/cli)).
- **Silent name collisions bite.** Two plugins' bare `analyze` commands collided with the last install winning ([microsoft/apm #1120](https://github.com/microsoft/apm/issues/1120)).
- **One schema, one discovery call.** OpenRPC's `rpc.discover` and MCP's `tools/list` return the same schemas the server enforces ([OpenRPC](https://spec.open-rpc.org/), [MCP tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)).

## Deferred Ideas

- [tech-spec] Where the schema validator lives (protocol, so the CLI and daemon share it) and how kernel schemas are typed against `Methods`.
- [tech-spec] How kernel commands' declarations replace `FlagDefs` and the hand-written `usage` strings without changing their run code.
- [tech-spec] The edit-distance rule and where the suggestion list comes from when the daemon can't be reached.
- Positionals for generated commands, declared per method.
- Plugin-declared text formatters for generated commands.
- A default skill folder and automatic installation for agents launched by Quirky.

## Glossary

- **Schema:** a JSON Schema subset document describing a method's params or result, an event's data, or a UI command's args.
- **Catalog:** what `quirky api --json` prints: every in-effect method, event, UI command and CLI command with its schema or flags.
- **Kernel command:** a CLI command written by hand in the CLI package, such as `wt create`.
- **Generated command:** a CLI command the CLI builds at run time from a plugin method in the catalog.
- **Group:** the first word of a command; for a generated command, the plugin ID without `quirky.`.
- **Shadowed:** a generated command whose words a higher-precedence command already uses.
- **Connection-bound method:** one of `client.hello`, `events.subscribe`, `terminal.attach`, `terminal.detach`, which only make sense on a live connection.
