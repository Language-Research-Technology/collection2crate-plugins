# c2c-plugins

Build plugins for [chaos2crate](https://github.com/Language-Research-Technology/chaos2crate) —
split out of that repo's `src/plugins/` so a deployment can pick which
plugins it bundles instead of shipping all of them.

This package has **no runtime dependency on chaos2crate**. Every plugin
here is a factory, `createPlugin(deps)`, that chaos2crate calls with the
specific functions from its own `crate.js`/`fs_helpers.js`/`github.js`/
`masp.js` that plugin needs. That's what lets this repo be developed,
tested, and version-controlled independently, with no circular package
dependency between the two repos.

## Consuming this package

chaos2crate depends on it as `"c2c-plugins": "file:../c2c-plugins"` (a
sibling checkout) and imports `REGISTRY`/`INPUT_REGISTRY` from `index.js`,
filtering them by its `PLUGINS` env var before calling each selected
factory. See chaos2crate's `SPEC.md` and `src/plugins/index.js`
for the consuming side.

## The two conventions every plugin here follows

**1. Hook names are literal strings, not an imported constant.** A plugin's
`hooks` object is keyed by strings like `"crate:build"` or `"output:write"`
rather than an imported `HOOKS.CRATE_BUILD` — those strings are a stable
contract owned by chaos2crate's `src/plugins/hooks.js`:

| Hook | String | When |
|---|---|---|
| `C2C_LOADED` | `"c2c:loaded"` | startup, once |
| `FOLDER_PICKED` | `"folder:picked"` | a folder is chosen |
| `PROFILE_SELECTED` | `"profile:selected"` | a MASP profile is chosen |
| `CRATE_PREPARE` | `"crate:prepare"` | after the Describe step, before the crate exists |
| `FILES_PREPARE` | `"files:prepare"` | per-file analysis |
| `METADATA_MERGE` | `"metadata:merge"` | spreadsheet metadata merge |
| `CRATE_BUILD` | `"crate:build"` | crate assembly and everything that mutates it |
| `CRATE_VALIDATE` | `"crate:validate"` | validation |
| `OUTPUT_WRITE` | `"output:write"` | writing to the folder |

If chaos2crate ever renames one of these, every plugin here keyed to the
old string silently stops firing — there's no import to break loudly. Grep
this repo for the old string when that happens.

These replaced an earlier, smaller set: `"config:prepare"` is now
`"crate:prepare"`, `"files:analyze"` is now `"files:prepare"`, and
`"crate:built"` folded into `"crate:build"` — the old separate
build-then-mutate pair is now one stage ordered by `priority` (below), with
chaos2crate's own assembly running ahead of every plugin tap.

**Every tap declares its `priority`.** A tap is an object, not a bare
function:

```js
hooks: {
  "files:prepare": {
    priority: 20,                                       // 0–100, lower runs earlier
    weight: 4,                                          // share of the progress bar (default 0)
    activeWhen: (ctx) => !!ctx.options.enableMyThing,   // omit for "always"
    handler: async (ctx) => { /* ... */ },
  },
},
```

`priority` is explicit on every tap in this repo rather than left to the
default (10) plus stable-sort registration order, so a plugin's position in
a stage is a property of the plugin itself and survives being filtered out
of, or reordered in, a deployment's `PLUGINS` selection. The numbers are
spaced 10 apart so a new plugin can be slotted between two existing ones
without renumbering. Plugin taps on `"crate:build"` start at 20, leaving
0–10 to chaos2crate's own crate assembly, which has to run first.

Current assignments, per stage:

| Stage | Order |
|---|---|
| `folder:picked` | `xlsx-crate-input` 10 |
| `crate:prepare` | `xlsx-crate-input` 10 |
| `files:prepare` | `austlang` 10 · `file-format-identify` 20 · `ca-data-prep` 30 · `chat-export` 40 |
| `crate:build` | `xlsx-crate-input` 20 · `austlang` 30 · `file-format-identify` 40 · `ca-data-prep` 50 · `chat-export` 60 · `merge` 70 · `roctable` 80 |
| `crate:validate` | `validate-crate` 10 |
| `output:write` | `roctable` 10 · `ro-crate-json-output` 20 · `ro-crate-xlsx-output` 30 · `ro-crate-html-output` 40 |

These reproduce the execution order `REGISTRY`'s own order used to imply.
Note that `ca-data-prep` replaces `ctx.crate` wholesale at 50, so the two
taps ahead of it (`austlang` 30, `file-format-identify` 40) contribute
nothing on a build where transcript processing is on — preserved as-is
here, since this change was a rename, not a reordering.

### Progress

Progress is **declared and weighted**, not inferred from log text. A tap
that does visible work sets `weight` (default 0 — no slice of the bar) and,
if it only runs conditionally, `activeWhen(ctx)`. Before a build the host
sums `weight` across every tap whose `activeWhen` passes and gives each an
ordered `[start%, end%]` slice of the main bar; the handler then reports
only its own position inside that slice:

```js
import { progressFor } from "../_progress.js";

handler: async (ctx) => {
  const progress = progressFor(ctx);
  progress.start("Identifying file formats…");
  for (let i = 0; i < total; i++) {
    // ...
    progress.report((i + 1) / total, `Format identification: ${i + 1}/${total} file(s)…`);
  }
  progress.done();
}
```

`report(fraction, label)` drives the main bar (scaled into the tap's slice)
and the secondary bar (the raw fraction) from one call — the secondary bar
appears by itself the first time a tap reports more than once before
`done()`, and stays hidden for a tap that only brackets `start()`/`done()`
around a single label. `done()` snaps the main bar to the slice end.

`ctx.log` and `ctx.progress` are **independent channels**: no log message
drives bar state any more. The old convention — emitting
`"… 12/40 file(s)…"` through `ctx.log` and letting chaos2crate's host
parse the `done/total` out of the string — is gone. Keep logging what is
worth reading in the transcript; report progress separately.

Always go through `progressFor(ctx)` (`src/_progress.js`) rather than
touching `ctx.progress` directly. It returns the same three-call shape on a
host that has no `ctx.progress` at all, so a plugin from this repo still
runs under an older chaos2crate instead of throwing partway through a build.

`countedProgress(ctx, total, label)` from the same module wraps the common
"loop over N things" case: it starts the tap, hands back a `tick(index,
label)` that takes the zero-based index of the item just finished, and
`tick.done()` closes it out. Tick on the skipped paths too (a `continue`
inside the loop), or the bar comes up short on a run where half the inputs
were unreadable.

### Testing

```bash
npm test          # hooks.test.mjs — the hook/priority/progress contract
npm run test:pronom
```

`hooks.test.mjs` constructs every plugin in `REGISTRY`/`INPUT_REGISTRY`
against a stub `deps` and asserts the parts of the contract that fail
*silently* rather than loudly: a tap keyed to a hook name chaos2crate no
longer emits never fires, a tap left as a bare function never gets a slice
of the bar, and two taps sharing a priority in one stage quietly fall back
to registration order. It also prints the resolved execution order per
stage, which is the quickest way to see what a priority change actually
did. The list of valid hook names is duplicated there rather than imported
— this package has no runtime dependency on chaos2crate, so accepting a
contract change from the other side is a deliberate edit to that list.

**2. Every plugin module exports `createPlugin(deps)`**, not a static
`plugin` object. `deps` is the exact set of chaos2crate core functions
that plugin needs, assigned into module-level bindings the plugin's hook
handlers close over. Call it once, before the plugin's hooks can fire.

## Per-plugin dependencies

| Plugin | `deps` keys it needs |
|---|---|
| `xlsx-crate-input` | `readFileBytes`, `readJsonFromFolder`, `loadMasp`, `statFile` (handed to `xlsx_crate.js`'s own `configure(deps)` on each dynamic import) |
| `austlang` | `addLanguageEntities` |
| `file-format-identify` | `graphEntityById` (handed to `matcher.js`'s own `configure(deps)` on each dynamic import, for `getFileHandleAtPath`) |
| `ca-data-prep` | `writeFileAtPath` |
| `merge` | `readJsonFromFolder`, `graphEntityById` |
| `roctable` | `readJsonFromFolder`, `writeFileAtPath`, `getFileHandleAtPath`, `readFileTextFromDirectory`, `loadCrateFromJson` (lets "Configure tables…" inspect the folder's crate without a build running), `openModal` (the table-selection tree, `config-tree-ui.js`) |
| `validate-crate` | `loadMasp` |
| `ro-crate-json-output` | `crateToJsonString`, `writeFile`, `fileExists` |
| `ro-crate-xlsx-output` | `crateToXlsxBytes`, `writeFile`, `fileExists` |
| `ro-crate-html-output` | `crateToPreviewHtml`, `crateToMultiPageHtml`, `writeFile`, `writeFileAtPath`, `readJsonFromFolder`, `readFileTextFromDirectory`, `verifyPermission`, `fileExists`, `bustCacheUrl`, `buildGitHubTreeUrl`, `fetchGitHubTextFile`, `listGitHubFolder` |
| `generic-input` (input mode) | `buildFileMetadata`, `buildCrate`, `readJsonFromFolder` (reads the folder's existing crate, if any, to reconcile against rather than replace — chaos2crate SPEC.md §6.1a), `openModal` (confirms which newly-found files to add, via `new-files-confirm.js`) |
| `docx-input` (input mode) | `writeFileAtPath` (handed to `docx_crate.js`'s own `configure(deps)` once its dynamic import resolves) |

`loadMasp` is a thunk — `() => import("../masp.js")` — rather than the
function itself, so `ro-crate-masp` (a heavy validator library) stays
dynamically imported from chaos2crate's own tree instead of becoming a
static import anywhere in this package.

The `roctable` plugin (`src/roctable/`) takes its name from the
[`roctable`](https://github.com/ptsefton/roctable) library it wraps — a WIP
The `roctable` plugin (`src/roctable/`) takes its name from the
[`roctable`](https://github.com/ptsefton/roctable) library it wraps — a WIP
library not yet on npm — installed as a git dependency pinned to a
commit (`"roctable": "github:ptsefton/roctable#<sha>"`), since it isn't
tagged or released. Bump the pinned commit deliberately, not by dropping
the pin — an unpinned GitHub dependency would silently pick up whatever
the repository's default branch has on the next `npm install`. It reuses
the library's own crate-walking functions directly (`ctx.crate` is already
an `ro-crate` `ROCrate` instance, the same shape it expects) — including
`load_text`, via a `fileReader` this plugin injects
(`browserFileReader` in `src/roctable/index.js`, wrapping
`readFileTextFromDirectory`) rather than the library's own Node-`fs`-based
default (see its `lib/io.js` and `SPEC.md` §9.0). Its config load/save and
CSV file writing stay this plugin's own job either way — the library's
`lib/config.js`/`lib/csv.js` file I/O is Node-`fs`-only and simply isn't
called from here; see `chaos2crate/docs/roctable-spec.md`.

The plugin is split across three files: `index.js` (the plugin itself —
hooks, the `optionSchema`, the `roctableConfigure` action), `discover.js`
(inspect the crate and merge onto whatever config already exists — the one
code path both the build-time hook and the standalone action call, plus the
`ldac:mainText`/`indexableText` default-seeding rule), and `config-tree-ui.js`
(the checkbox-tree editor `openModal` renders — a table heading per `@type`,
unrolling to its properties' include/expand/load_text/join). Config lives at
`_config/roctable/config.json`, output at `_outputs/roctable/` — chaos2crate
issue #81's proposed per-plugin directory convention, adopted here ahead of
it becoming repo-wide.

## Writing a new plugin here

```js
// src/my-thing/index.js
let someCoreFn;

export function createPlugin(deps) {
  ({ someCoreFn } = deps);
  return plugin;
}

const plugin = {
  name: "my-thing",
  optionSchema: { key: "enableMyThing", label: "…", default: false },
  // Declare every file/directory this plugin may write directly into the
  // picked folder (root-relative path; "/" for one nested under a directory
  // this plugin owns outright, e.g. "my-thing-output/report.csv" — not for a
  // single file buried inside someone else's tree). See "Declaring output
  // paths" below.
  outputPaths: [{ path: "my-thing-output", kind: "dir" }],
  hooks: {
    "crate:build": {
      priority: 20,
      weight: 1,
      activeWhen: (ctx) => !!ctx.options.enableMyThing,
      handler: (ctx) => { /* ... */ },
    },
  },
};
```

### Declaring output paths

A plugin that writes into the picked folder (rather than only reading from it,
or only mutating `ctx.crate` in memory) should declare `outputPaths`: an array
of `{ path, kind }`, `kind` being `"file"` or `"dir"`. chaos2crate composes
these across every registered plugin (`composeOutputPaths()` in its
`src/plugins/index.js`, generated alongside `composeOptionSchema`/
`composeSettingsSchema`) for two things: excluding a previous build's own
output from being rescanned as corpus content on the next build (the same job
`GENERATED_FILENAMES` in chaos2crate's `crate.js` already does for the core
JSON/xlsx/HTML outputs), and an opt-in Settings toggle that deletes all of it
before a build runs, so stale output from a renamed or removed source file
never lingers.

Rules of thumb:

- **Declare every top-level entry you write, even ones gated behind an
  option.** The declaration describes what the plugin *may* produce across
  its lifetime, not just what a specific run's options enable — a stale file
  from a run where the option was on should still be found and skipped/
  cleaned when a later run has it off. `ro-crate-html-output` declares both
  `ro-crate-preview.html` and `ro-crate-preview_html` even though the latter
  only appears for a multipage template.
- **Two plugins writing into the same shared directory both declare it** —
  `chat-export` and `ca-data-prep` both declare `{ path: "c2c-output", kind:
  "dir" }`; chaos2crate's composition dedupes by `path`.
- **`kind: "dir"` means chaos2crate may delete the whole subtree.** Only
  declare a directory path when the plugin owns everything under it — don't
  declare a directory that content files might also legitimately live in.
- **No `outputPaths` at all is correct for a plugin that never writes to the
  folder** — `merge`, `austlang`, `validate-crate`, and the input-analysis
  half of every plugin all fall here; only the writing side declares.
- **A path under `_config/<slug>/` or `_backup/<slug>/` (chaos2crate issue
  #81's proposed per-plugin directories) still gets scan-excluded, but
  chaos2crate's "Delete plugin output before rebuilding" skips deleting it**
  — those two are meant to persist across builds (standing configuration,
  changed-file backups), unlike `_outputs/<slug>/`, which is exactly the
  disposable generated content that setting exists to clear. `roctable`
  is the first plugin here to use this: config at `_config/roctable/`,
  CSVs at `_outputs/roctable/`.

Then register it in this repo's `index.js` (`REGISTRY` for an additive
plugin, `INPUT_REGISTRY` for a mutually-exclusive input mode), and in
chaos2crate's `src/plugins/index.js`, wire up the `deps` object it's
called with.
