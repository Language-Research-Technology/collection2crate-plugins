# collection2crate-plugins

Build plugins for [collection2crate](https://github.com/Language-Research-Technology/collection2crate) —
split out of that repo's `src/plugins/` so a deployment can pick which
plugins it bundles instead of shipping all of them.

This package has **no runtime dependency on collection2crate**. Every plugin
here is a factory, `createPlugin(deps)`, that collection2crate calls with the
specific functions from its own `crate.js`/`fs_helpers.js`/`github.js`/
`masp.js` that plugin needs. That's what lets this repo be developed,
tested, and version-controlled independently, with no circular package
dependency between the two repos.

## Layout

```
index.js                 REGISTRY — the one registry, keyed by plugin name
plugins/<name>/index.js  one folder per plugin; createPlugin(deps) lives here
src/_progress.js         shared machinery, not a plugin
src/_csv.js              CSV building and download, for visualisation panels
src/_panel.js            the DOM vocabulary those panels share
hooks.test.mjs           the hook/priority/progress contract test
visualisation.test.mjs   the panels' pure seams: matching, counting, scaling
```

One folder per plugin under `plugins/`, named exactly as the plugin names
itself and as `REGISTRY` keys it — that triple agreement is what lets a
consumer resolve `collection2crate-plugins/plugins/<name>/index.js` from a
`PLUGINS` selection without a lookup table, and `hooks.test.mjs` asserts the
registry key and `plugin.name` half of it. Anything shared between plugins
rather than being one stays outside `plugins/`, in `src/`.

## Two kinds of plugin

Most plugins here tap the build pipeline: they declare `hooks`, run when a
person presses Process or Build, and write to `ctx`. The rest declare a
**`visualisation`** panel — `concordance`, `ngrams` and `chart` — which appears
on collection2crate's Visualise page, taps nothing, and does not run at all
until someone opens it:

```js
{
  name: "concordance",
  visualisation: {
    label: "Concordance",                       // names it in the sidebar
    hint: "Search for a word or phrase…",       // one line, shown with it
    render(container, { documents, tables, log }) { /* build DOM here */ },
  },
}
```

One registry holds both, and a plugin may declare either or both: a panel is
something a plugin offers, like an `optionSchema`. A deployment that leaves a
plugin out of its `PLUGINS` selection gets neither its taps nor its panel.

`SPEC-PLUGINS.md` is the full contract — what `documents` and `tables` are,
where they come from, and what each of the three panels does.

## Consuming this package

collection2crate depends on it as `"collection2crate-plugins": "file:../collection2crate-plugins"` (a
sibling checkout) and imports `REGISTRY` from `index.js`, filtering it by
its `PLUGINS` env var before calling each selected factory. See collection2crate's `SPEC.md` and `src/plugins/index.js`
for the consuming side.

## The two conventions every plugin here follows

**1. Hook names are literal strings, not an imported constant.** A plugin's
`hooks` object is keyed by strings like `"crate:build"` or `"crate:write"`
rather than an imported `HOOKS.CRATE_BUILD` — those strings are a stable
contract owned by collection2crate's `src/plugins/hooks.js`, in the order the pipeline emits
them:

| Hook | String | When |
|---|---|---|
| `C2C_LOADED` | `"c2c:loaded"` | startup, once |
| `FOLDER_PICKED` | `"folder:picked"` | a folder is chosen |
| `PROFILE_SELECTED` | `"profile:selected"` | a MASP profile is chosen |
| `FILES_PREPARE` | `"files:prepare"` | per-file analysis |
| `FILES_WRITE` | `"files:write"` | writing files derived from the folder's own — no crate exists yet |
| `METADATA_MERGE` | `"metadata:merge"` | spreadsheet metadata merge |
| `CRATE_PREPARE` | `"crate:prepare"` | the crate's own metadata, immediately before assembly |
| `CRATE_BUILD` | `"crate:build"` | crate assembly and everything that mutates it |
| `CRATE_VALIDATE` | `"crate:validate"` | validation |
| `CRATE_WRITE` | `"crate:write"` | writing to the folder |

Which button runs a tap follows from its stage. collection2crate's **Process**
step emits the file half — `files:prepare → files:write → metadata:merge` — and
its **Build** step emits the crate half — `crate:prepare → crate:build →
crate:validate → crate:write`. Every `crate:` stage belongs to Build. The two
halves are disjoint, and a build continues the `ctx` the Process run finished
with, so a plugin spanning both (prepare files, then describe them in the
crate) writes to `ctx` in a file stage and reads it back at `crate:build`,
exactly as it would within one run.

One caveat for anything seeding `ctx.config`, as `xlsx-crate-input` does at
`crate:prepare`: the host rebuilds that object from the profile and the
Describe form on every run, so a seed only survives to be used because
`crate:prepare` runs in the same step as the assembly that reads it. Plugin-
owned keys on `ctx` (`ctx.xlsxCrate`, `ctx.langById`, anything you invent)
are carried between the two runs untouched.

If collection2crate ever renames one of these, every plugin here keyed to the
old string silently stops firing — there's no import to break loudly. Grep
this repo for the old string when that happens.

These replaced an earlier, smaller set: `"config:prepare"` is now
`"crate:prepare"`, `"files:analyze"` is now `"files:prepare"`, and
`"crate:built"` folded into `"crate:build"` — the old separate
build-then-mutate pair is now one stage ordered by `priority` (below), with
the build's chosen *builder* running ahead of every annotating tap. The write
stage is `"crate:write"`; it was `"output:write"` until the stage names were
made uniform, and collection2crate emits only the new name.

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
without renumbering. Taps on `"crate:build"` start at 20, leaving 0–10 to
the builders — see below.

Current assignments, per stage:

| Stage | Order |
|---|---|
| `folder:picked` | `xlsx-crate-input` 10 |
| `files:prepare` | `generic-input` 0 · `austlang` 10 · `file-format-identify` 20 · `ca-data-prep` 30 · `chat-export` 40 |
| `files:write` | `ca-data-prep` 10 · `chat-export` 20 |
| `crate:prepare` | `xlsx-crate-input` 10 |
| `crate:build` | `docx-input` 5 · `generic-input` 10 · `xlsx-crate-input` 20 · `austlang` 30 · `file-format-identify` 40 · `ca-data-prep` 50 · `chat-export` 60 · `merge` 70 · `roctable` 80 |
| `crate:validate` | `validate-crate` 10 |
| `crate:write` | `docx-input` 5 · `roctable` 10 · `ro-crate-json-output` 20 · `ro-crate-xlsx-output` 30 · `ro-crate-html-output` 40 |

`docx-input` splits the same way for a different reason: it extracts embedded
and referenced media while parsing, because the crate has to name those files,
but writes them at `crate:write` — nothing reads them before the crate they
belong to is written out, and the directory is wiped and rewritten in one go
rather than accumulating stale media from renamed documents. The bytes live on
`ctx` in between.

`ca-data-prep` and `chat-export` each split across two stages on purpose: the
files they derive are written at `files:write`, during Process, and the
entities describing those files are added at `crate:build`, the first point
where a crate exists. Neither half needs the other to have run in the same
run — the records they both read live on `ctx`, which a build carries over
from Process.

These reproduce the execution order `REGISTRY`'s own order used to imply.
Note that `ca-data-prep` replaces `ctx.crate` wholesale at 50, so the two
taps ahead of it (`austlang` 30, `file-format-identify` 40) contribute
nothing on a build where transcript processing is on — preserved as-is
here, since this change was a rename, not a reordering.

### Builders

There is no separate kind of plugin for reading a folder, and no input-mode
setting the host dispatches on. A **builder** is just a plugin whose
`"crate:build"` tap sits in the band `priority <= 10` and assigns
`ctx.crate`; everything at 20 and above annotates the crate a builder
produced, which is why those taps can assume it already exists.

collection2crate runs **exactly one builder per build**: of the builder taps whose
`activeWhen(ctx)` passes, the lowest priority wins, and *every* tap belonging
to a builder that lost is skipped for that build — other stages included. So
a specialised builder doesn't have to coordinate with the baseline one, or
even know it exists:

| Builder | Priority | Gate |
|---|---|---|
| `docx-input` | 5 | `activeWhen: ctx => !!ctx.options.docxInput` |
| `generic-input` | 10 | none — the fallback |

`generic-input` carries no option, so it is always active and always the last
builder standing; switching on `docxInput` puts a builder ahead of it and
stands it down, folder scan (`files:prepare` at 0) included. A new builder
needs a lower priority than the fallback and an option of its own for a
profile to enable — nothing in the host changes. Exactly one builder in the
registry may go ungated; `hooks.test.mjs` enforces that, since a second
unconditional one could never run.

If a build ends with no `ctx.crate`, collection2crate fails it with an error
naming the stage rather than carrying on into validation with nothing.

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
`"… 12/40 file(s)…"` through `ctx.log` and letting collection2crate's host
parse the `done/total` out of the string — is gone. Keep logging what is
worth reading in the transcript; report progress separately.

Always go through `progressFor(ctx)` (`src/_progress.js`) rather than
touching `ctx.progress` directly. It returns the same three-call shape on a
host that has no `ctx.progress` at all, so a plugin from this repo still
runs under an older collection2crate instead of throwing partway through a build.

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

`hooks.test.mjs` constructs every plugin in `REGISTRY` against a stub `deps` and asserts the parts of the contract that fail
*silently* rather than loudly: a tap keyed to a hook name collection2crate no
longer emits never fires, a tap left as a bare function never gets a slice
of the bar, and two taps sharing a priority in one stage quietly fall back
to registration order. It also prints the resolved execution order per
stage, which is the quickest way to see what a priority change actually
did. The list of valid hook names is duplicated there rather than imported
— this package has no runtime dependency on collection2crate, so accepting a
contract change from the other side is a deliberate edit to that list.

**2. Every plugin module exports `createPlugin(deps)`**, not a static
`plugin` object. `deps` is the exact set of collection2crate core functions
that plugin needs, assigned into module-level bindings the plugin's hook
handlers close over. Call it once, before the plugin's hooks can fire.

## Per-plugin dependencies

| Plugin | `deps` keys it needs |
|---|---|
| `xlsx-crate-input` | `readFileBytes`, `readJsonFromFolder`, `loadMasp`, `statFile` (handed to `xlsx_crate.js`'s own `configure(deps)` on each dynamic import) |
| `austlang` | `addLanguageEntities` |
| `file-format-identify` | `graphEntityById` (handed to `matcher.js`'s own `configure(deps)` on each dynamic import, for `getFileHandleAtPath`) |
| `ca-data-prep` | `writeFileAtPath`, `fileExists` |
| `chat-export` | `writeFileAtPath`, `fileExists` (its .docx reading goes through `ca-data-prep`'s own exports rather than `deps`) |
| `merge` | `readJsonFromFolder`, `graphEntityById` |
| `roctable` | `readJsonFromFolder`, `writeFileAtPath`, `getFileHandleAtPath`, `readFileTextFromDirectory`, `loadCrateFromJson` (lets "Configure tables…" inspect the folder's crate without a build running), `openModal` (the table-selection tree, `config-tree-ui.js`) |
| `transcript-grammar` | `writeFileAtPath`, `readFileTextFromDirectory`, `openModal` (the three-step grammar editor and the tester, `ui.js`); its `.docx` reading goes through `ca-data-prep`'s `extractDocumentText`, imported on demand |
| `validate-crate` | `loadMasp` |
| `concordance`, `ngrams`, `chart` (panels) | none — a panel receives its data in `ctx`, and never touches the folder |
| `ro-crate-json-output` | `crateToJsonString`, `writeFile`, `fileExists` |
| `ro-crate-xlsx-output` | `crateToXlsxBytes`, `writeFile`, `fileExists` |
| `ro-crate-html-output` | `crateToPreviewHtml`, `crateToMultiPageHtml`, `writeFile`, `writeFileAtPath`, `readJsonFromFolder`, `readFileTextFromDirectory`, `verifyPermission`, `fileExists`, `bustCacheUrl`, `buildGitHubTreeUrl`, `fetchGitHubTextFile`, `listGitHubFolder` |
| `generic-input` (builder) | `buildFileMetadata`, `buildCrate`, `readJsonFromFolder` (reads the folder's existing crate, if any, to reconcile against rather than replace — collection2crate SPEC.md §6.1a), `openModal` (confirms which newly-found files to add, via `new-files-confirm.js`) |
| `docx-input` (builder) | `writeFileAtPath`, `fileExists` (both handed to `docx_crate.js`'s own `configure(deps)` once its dynamic import resolves) |

`openModal` has one shape, documented in collection2crate SPEC.md §6.2 — a
plugin builds its content in `onMount(body, { close })` and declares its
buttons as `actions`, never drawing its own:

```js
const chosen = await openModal({
  title: "Configure RO-Crate tables",
  onMount(body) { body.append(/* your controls */); },
  actions: [
    { label: "Cancel", value: null },
    // called at click time, so it sees whatever the controls have edited
    { label: "Save configuration", primary: true, value: () => working },
  ],
});
```

Dismissing resolves `null`, which the caller should treat as "no choice was
made" rather than an empty result. Content uses the host's own classes —
`.button`, `.button primary`, `.button subtle`, `.checkbox`, `.field-hint`,
`.data-table` — so a plugin ships no CSS.

`loadMasp` is a thunk — `() => import("../masp.js")` — rather than the
function itself, so `ro-crate-masp` (a heavy validator library) stays
dynamically imported from collection2crate's own tree instead of becoming a
static import anywhere in this package.

`ca-data-prep` (`plugins/ca-data-prep/`) parses transcripts by line shape,
not by Word style, so the authoring convention is the contract:

```
Speakers:
D:→Dora [Dora Leung] (Australian, male) #dora     ← code, then the speaker
…
PRELIMINARIES                                            ← section marker, alone on its line
1→D:→so I'm Dora?                                      ← optional turn number, code, turn
MAIN
D:→hi                                                    ← unnumbered is equally fine
```

A line that is not a turn is folded into the turn above it, which is what
makes wrapped text work — and what makes an unrecognised turn shape fail
silently and completely rather than partially: every following line, section
markers included, collapses into the last line the parser did recognise, and
the CSV comes out as a header and nothing else. `transcript.test.mjs` pins
the shapes that must parse; add to it before touching `SPEAKER_LINE` or
`TURN_LINE` in `process.js`.

`transcript-grammar` (`plugins/transcript-grammar/`) lets a person define that
convention for their own documents instead of accepting it. It taps no build
stage; it offers two Build-panel actions:

- **Define a transcript grammar…** — paste a transcript or choose a `.txt` /
  `.docx`; mark line ranges as **header metadata**, **speaker info** or
  **main** (plus marker lines such as `Speakers:` or `PRELIMINARIES`, and lines
  to ignore); then, in individual rows, select characters and mark them as a
  speaker's code / name / alternate name / affiliation / id, or a turn's
  number / speaker / text. The patterns are generated from that markup
  (`grammar.js`'s `buildGrammar`) and re-run over the whole sample as you go,
  so you see what they parse and what they miss before saving.
- **Test a transcript grammar…** — parse another document with a saved one.

A grammar is saved to `_config/transcript-grammar/<name>.json`: named-group
regular expressions (`speakerRow`, `turnRow`, `headerField`), region start
markers, section names and ignore patterns. Only the shape of the sample is
kept — delimiters, brackets, which fields are optional — never its text,
since the rows marked up are real speaker declarations. `parseWithGrammar(text,
grammar)` is pure and exported for a build-time consumer; nothing reads these
configs during a build yet. `transcript-grammar.test.mjs` covers generation
and parsing.

The `roctable` plugin (`plugins/roctable/`) takes its name from the
[`roctable`](https://github.com/ptsefton/roctable) library it wraps — a WIP
library not yet on npm — installed as a git dependency pinned to a
commit (`"roctable": "github:ptsefton/roctable#<sha>"`), since it isn't
tagged or released. Bump the pinned commit deliberately, not by dropping
the pin — an unpinned GitHub dependency would silently pick up whatever
the repository's default branch has on the next `npm install`. It reuses
the library's own crate-walking functions directly (`ctx.crate` is already
an `ro-crate` `ROCrate` instance, the same shape it expects) — including
`load_text`, via a `fileReader` this plugin injects
(`browserFileReader` in `plugins/roctable/index.js`, wrapping
`readFileTextFromDirectory`) rather than the library's own Node-`fs`-based
default (see its `lib/io.js` and `SPEC.md` §9.0). Its config load/save and
CSV file writing stay this plugin's own job either way — the library's
`lib/config.js`/`lib/csv.js` file I/O is Node-`fs`-only and simply isn't
called from here; see `collection2crate/docs/roctable-spec.md`.

The plugin is split across three files: `index.js` (the plugin itself —
hooks, the `optionSchema`, the `roctableConfigure` action), `discover.js`
(inspect the crate and merge onto whatever config already exists — the one
code path both the build-time hook and the standalone action call, plus the
`ldac:mainText`/`indexableText` default-seeding rule), and `config-tree-ui.js`
(the checkbox-tree editor `openModal` renders — a table heading per `@type`,
unrolling to its properties' include/expand/load_text/join). Config lives at
`_config/roctable/config.json`, output at `_outputs/roctable/` — collection2crate
issue #81's proposed per-plugin directory convention, adopted here ahead of
it becoming repo-wide.

## Writing a new plugin here

```js
// plugins/my-thing/index.js
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
of `{ path, kind }`, `kind` being `"file"` or `"dir"`. collection2crate composes
these across every registered plugin (`composeOutputPaths()` in its
`src/plugins/index.js`, generated alongside `composeOptionSchema`/
`composeSettingsSchema`) for two things: excluding a previous build's own
output from being rescanned as corpus content on the next build (the same job
`GENERATED_FILENAMES` in collection2crate's `crate.js` already does for the core
JSON/xlsx/HTML outputs), and an opt-in Settings toggle that deletes all of it
before a build runs, so stale output from a renamed or removed source file
never lingers.

Rules of thumb:

- **Respect `ctx.options.overwrite`.** It is the person's answer to whether a
  run may replace what is already in their folder, and it covers derived files
  as much as the crate's own: check before writing, and say what you skipped
  (`` `${path} exists and overwrite is off — skipped.` ``) rather than passing
  over it silently. Every writing plugin here does this.
- **Declare every top-level entry you write, even ones gated behind an
  option.** The declaration describes what the plugin *may* produce across
  its lifetime, not just what a specific run's options enable — a stale file
  from a run where the option was on should still be found and skipped/
  cleaned when a later run has it off. `ro-crate-html-output` declares both
  `ro-crate-preview.html` and `ro-crate-preview_html` even though the latter
  only appears for a multipage template.
- **Two plugins writing into the same shared directory both declare it** —
  `chat-export` and `ca-data-prep` both declare `{ path: "c2c-output", kind:
  "dir" }`; collection2crate's composition dedupes by `path`.
- **`kind: "dir"` means collection2crate may delete the whole subtree.** Only
  declare a directory path when the plugin owns everything under it — don't
  declare a directory that content files might also legitimately live in.
- **No `outputPaths` at all is correct for a plugin that never writes to the
  folder** — `merge`, `austlang`, `validate-crate`, and the input-analysis
  half of every plugin all fall here; only the writing side declares.
- **A path under `_config/<slug>/` or `_backup/<slug>/` (collection2crate issue
  #81's proposed per-plugin directories) still gets scan-excluded, but
  collection2crate's "Delete plugin output before rebuilding" skips deleting it**
  — those two are meant to persist across builds (standing configuration,
  changed-file backups), unlike `_outputs/<slug>/`, which is exactly the
  disposable generated content that setting exists to clear.
- **Generated files go under `_outputs/`, standing configuration under
  `_config/`.** Name the folder inside for *what it holds*, not for the plugin
  that writes it: `_outputs/csv/`, `_outputs/logs/`, `_outputs/chat/` — someone
  opening the folder is looking for their CSVs, not for the plugin that made
  them. A plugin whose output has no such name uses its own (`roctable` writes
  `_outputs/roctable/`, configured from `_config/roctable/`).
  Declare each directory you write individually; `_outputs/` is shared, so a
  plugin claiming it whole would hand its own "delete output before rebuilding"
  sweep everybody else's files. The exceptions to all of this are the crate's
  own published artefacts — `ro-crate-metadata.json`, the xlsx, the preview and
  its assets — which belong at the folder root where a reader of the crate
  expects them, not filed under output directories at all.

Then register it in this repo's `index.js` (`REGISTRY` — one registry, for
builders and annotating plugins alike), and in collection2crate's
`src/plugins/index.js`, wire up the `deps` object it's called with.
