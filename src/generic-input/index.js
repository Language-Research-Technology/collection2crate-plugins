// Generic-folder input mode: scans every file in the picked folder and
// builds RepositoryObject/RepositoryCollection/File entities from it
// (crate.js's buildFileMetadata + buildCrate). This is the default input
// mode and every other build plugin's baseline — and the only one with a flat
// file list, so the only one that declares analyzeFiles and therefore the only
// one whose builds emit files:analyze.
//
// Registered as an input-mode plugin (INPUT_PLUGINS, keyed by inputMode) —
// unlike the additive hook-tapping plugins in src/plugins/index.js's
// PLUGINS array, input-mode plugins are mutually exclusive: exactly one
// runs per build, dispatched by pipeline.js on ctx.options.inputMode.
// Core chaos2crate functions arrive via createPlugin(deps) — see this
// repo's README.
import { confirmNewFiles } from "./new-files-confirm.js";

let buildFileMetadata, buildCrate, readJsonFromFolder, openModal;

export function createPlugin(deps) {
  ({ buildFileMetadata, buildCrate, readJsonFromFolder, openModal } = deps);
  return plugin;
}

const plugin = {
  name: "generic-input",
  inputMode: "generic",
  // Declaring this is what makes the pipeline emit files:analyze — see
  // runPipeline. Everything here is still plain data: taps get to annotate
  // ctx.filesWithMeta before buildCrate turns any of it into entities.
  analyzeFiles(ctx) {
    ctx.files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    ctx.filesWithMeta = buildFileMetadata(ctx.files);
    ctx.log(`Scanned ${ctx.filesWithMeta.length} file(s).`, "info");
    ctx.sourceCount = ctx.filesWithMeta.length;
  },

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
  async buildCrate(ctx) {
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
      // ctx.xlsxCrate is set at config:prepare, before this runs: a spreadsheet
      // already describes the entries and what belongs to what, so the folder
      // scan shouldn't invent a parallel structure alongside it.
      structureFromMetadata: !!ctx.xlsxCrate,
      existingJson,
    });
  },
};
