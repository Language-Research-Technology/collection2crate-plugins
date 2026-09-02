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
| `crate2tables` | `readJsonFromFolder`, `writeFileAtPath`, `getFileHandleAtPath` |
| `validate-crate` | `loadMasp` |
| `ro-crate-json-output` | `crateToJsonString`, `writeFile`, `fileExists` |
| `ro-crate-xlsx-output` | `crateToXlsxBytes`, `writeFile`, `fileExists` |
| `ro-crate-html-output` | `crateToPreviewHtml`, `crateToMultiPageHtml`, `writeFile`, `writeFileAtPath`, `readJsonFromFolder`, `readFileTextFromDirectory`, `verifyPermission`, `fileExists`, `bustCacheUrl`, `buildGitHubTreeUrl`, `fetchGitHubTextFile`, `listGitHubFolder` |
| `generic-input` (input mode) | `buildFileMetadata`, `buildCrate` |
| `docx-input` (input mode) | `writeFileAtPath` (handed to `docx_crate.js`'s own `configure(deps)` once its dynamic import resolves) |

`loadMasp` is a thunk — `() => import("../masp.js")` — rather than the
function itself, so `ro-crate-masp` (a heavy validator library) stays
dynamically imported from chaos2crate's own tree instead of becoming a
static import anywhere in this package.

`crate2tables` depends on [`roctable`](https://github.com/ptsefton/roctable),
a WIP library not yet on npm — installed here as a git dependency
(`"roctable": "github:ptsefton/roctable"`). It reuses roctable's own
crate-walking functions directly (`ctx.crate` is already an `ro-crate`
`ROCrate` instance, the same shape roctable expects), but not its config/CSV
file I/O, which is Node-`fs`-only — see `src/crate2tables/index.js` and
`chaos2crate/docs/crate2tables-spec.md` for what's adapted and what's
deliberately unsupported for now (`load_text`).

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

Then register it in this repo's `index.js` (`REGISTRY` for an additive
plugin, `INPUT_REGISTRY` for a mutually-exclusive input mode), and in
chaos2crate's `src/plugins/index.js`, wire up the `deps` object it's
called with.
