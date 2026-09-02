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
`hooks` object is keyed by strings like `"crate:built"` or `"output:write"`
rather than an imported `HOOKS.CRATE_BUILT` — those strings are a stable
contract owned by chaos2crate's `src/plugins/hooks.js`:

| Hook | String |
|---|---|
| `FOLDER_PICKED` | `"folder:picked"` |
| `PROFILE_SELECTED` | `"profile:selected"` |
| `CONFIG_PREPARE` | `"config:prepare"` |
| `FILES_ANALYZE` | `"files:analyze"` |
| `CRATE_BUILT` | `"crate:built"` |
| `CRATE_VALIDATE` | `"crate:validate"` |
| `OUTPUT_WRITE` | `"output:write"` |

If chaos2crate ever renames one of these, every plugin here keyed to the
old string silently stops firing — there's no import to break loudly. Grep
this repo for the old string when that happens.

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
| `crate2tables` | `readJsonFromFolder`, `writeFileAtPath`, `getFileHandleAtPath`, `readFileTextFromDirectory`, `loadCrateFromJson` (lets "Configure tables…" inspect the folder's crate without a build running), `openModal` (the table-selection tree, `config-tree-ui.js`) |
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

`crate2tables` depends on [`roctable`](https://github.com/ptsefton/roctable),
a WIP library not yet on npm — installed as `"roctable": "file:../roctable"`
while both are under active development (swap to a `github:ptsefton/roctable`
git dependency, pinned to a commit, once roctable's own PR lands). It reuses
roctable's own crate-walking functions directly (`ctx.crate` is already an
`ro-crate` `ROCrate` instance, the same shape roctable expects) — including
`load_text`, via a `fileReader` this plugin injects
(`browserFileReader` in `src/crate2tables/index.js`, wrapping
`readFileTextFromDirectory`) rather than roctable's own Node-`fs`-based
default (see roctable's `lib/io.js` and its `SPEC.md` §9.0). Its config
load/save and CSV file writing stay this plugin's own job either way —
roctable's `lib/config.js`/`lib/csv.js` file I/O is Node-`fs`-only and simply
isn't called from here; see `chaos2crate/docs/crate2tables-spec.md`.

`crate2tables` is split across three files: `index.js` (the plugin itself —
hooks, the `optionSchema`, the `crate2tablesConfigure` action), `discover.js`
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
    "crate:built": (ctx) => { /* ... */ },
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
  disposable generated content that setting exists to clear. `crate2tables`
  is the first plugin here to use this: config at `_config/roctable/`,
  CSVs at `_outputs/roctable/`.

Then register it in this repo's `index.js` (`REGISTRY` for an additive
plugin, `INPUT_REGISTRY` for a mutually-exclusive input mode), and in
chaos2crate's `src/plugins/index.js`, wire up the `deps` object it's
called with.
