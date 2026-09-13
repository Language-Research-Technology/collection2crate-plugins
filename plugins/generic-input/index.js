// The baseline builder: scans every file in the picked folder and builds
// RepositoryObject/RepositoryCollection/File entities from it (crate.js's
// buildFileMetadata + buildCrate).
//
// This is an ordinary plugin — there is no separate input-plugin registry and
// no input mode. What makes it a *builder* is that it taps crate:build inside
// the builder band (priority <= 10) and sets ctx.crate; annotating taps start
// at 20 and assume ctx.crate already exists. At most one builder runs per
// build: the active one with the lowest priority wins, and every tap of a
// builder that lost is skipped for that build — which is what lets this
// plugin's files:prepare scan sit alongside a specialised builder's taps
// without either having to know the other exists.
//
// It carries no option of its own, so it is always active and therefore the
// fallback: it builds unless a gated builder with a lower priority (e.g.
// docx-input at 5) is switched on for the run.
//
// Core collection2crate functions arrive via createPlugin(deps) — see this repo's
// README.
import { confirmNewFiles } from "./new-files-confirm.js";

let buildFileMetadata, buildCrate, readJsonFromFolder, openModal;

export function createPlugin(deps) {
  ({ buildFileMetadata, buildCrate, readJsonFromFolder, openModal } = deps);
  return plugin;
}

// The flat file list every files:prepare tap reads. Priority 0 puts it below
// the annotating taps (austlang at 10, file-format-identify at 20, …), which
// is what guarantees ctx.filesWithMeta exists before any of them run. A
// builder that reads the folder some other way simply doesn't produce one —
// and, having won the band, this tap never runs.
function scanFiles(ctx) {
  ctx.files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  ctx.filesWithMeta = buildFileMetadata(ctx.files);
  ctx.log(`Scanned ${ctx.filesWithMeta.length} file(s).`, "info");
  ctx.sourceCount = ctx.filesWithMeta.length;
}

// If the folder already has a crate, this build reconciles against it
// (SPEC.md §6.1a) instead of replacing it — buildCrate() (crate.js) only
// needs the parsed JSON to know that; everything else is unchanged.
// "Existing crate" here means the file this same JSON output plugin
// writes, not xlsx-crate-input's additional-ro-crate-metadata.xlsx (a
// deliberately separate, opt-in source — see that plugin's own hooks).
//
// A file the scan found with no matching entity in that existing crate
// isn't added silently — the person building the crate confirms it first
// (new-files-confirm.js's checkbox tree), since reconcileFileEntities'
// fallback for one with no obvious home is to attach it straight to the
// root dataset, and that's exactly the kind of guess a human should sign
// off on rather than discover after the fact in the build log.
async function buildFromFolder(ctx) {
  const existingJson = await readJsonFromFolder(ctx.dirHandle, "ro-crate-metadata.json");
  let filesToBuild = ctx.filesWithMeta;

  if (existingJson) {
    const existingIds = new Set((existingJson["@graph"] || []).map((e) => e["@id"]));
    const newPaths = ctx.filesWithMeta.map((f) => f.id).filter((id) => !existingIds.has(id));

    if (newPaths.length) {
      ctx.log(`${newPaths.length} file(s) not in the existing crate — asking which to add.`, "info");
      const confirmed = await confirmNewFiles({ newPaths, openModal });
      if (confirmed === null) throw new Error("Build cancelled: new files were not confirmed.");

      const confirmedSet = new Set(confirmed);
      const skipped = newPaths.filter((id) => !confirmedSet.has(id));
      if (confirmed.length) ctx.log(`Adding ${confirmed.length} confirmed new file(s).`, "ok");
      if (skipped.length) ctx.log(`Skipping ${skipped.length} file(s) this build (not added to the crate): ${skipped.join(", ")}`, "warn");

      filesToBuild = ctx.filesWithMeta.filter((f) => existingIds.has(f.id) || confirmedSet.has(f.id));
    }
  }

  ctx.crate = buildCrate(filesToBuild, ctx.config, ctx.log, {
    topLevelFolderType: ctx.options.topLevelFolderType,
    // ctx.xlsxCrate is set at crate:prepare, before this runs: a spreadsheet
    // already describes the entries and what belongs to what, so the folder
    // scan shouldn't invent a parallel structure alongside it.
    structureFromMetadata: !!ctx.xlsxCrate,
    existingJson,
  });
}

const plugin = {
  name: "generic-input",
  hooks: {
    "files:prepare": {
      priority: 0,
      weight: 1,
      handler: scanFiles,
    },
    "crate:build": {
      priority: 10,
      weight: 3,
      handler: buildFromFolder,
    },
  },
};
