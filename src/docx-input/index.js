// Structured Word Documents input mode: parses Heading 1/2/3-structured
// .docx files into Collections/DocumentParts/Chapters (docx_crate.js, in
// this folder) instead of the generic-input plugin's flat file scan.
// Registered as an input-mode plugin (INPUT_PLUGINS, keyed by inputMode) —
// unlike the additive hook-tapping plugins in src/plugins/index.js's
// PLUGINS array, input-mode plugins are mutually exclusive: exactly one
// runs per build, dispatched by pipeline.js on ctx.options.inputMode.
//
// docx_crate.js pulls in mammoth + cheerio (heavy deps), so it's only
// dynamically imported here when this mode actually runs — keeps it out of
// the main bundle and in its own chunk regardless of docx mode ever being
// used in a given session. It also needs one chaos2crate core function
// (writeFileAtPath) — createPlugin(deps) holds onto deps and hands it to
// docx_crate.js's configure() once the dynamic import resolves, rather than
// importing fs_helpers.js directly (see this repo's README).
// Mirrors docx_crate.js's own (module-private) OUTPUT_FILES_DIR_NAME — kept
// as a literal here rather than imported, since importing docx_crate.js
// statically would defeat the whole point of dynamic-importing it below (it
// evaluates its mammoth/cheerio imports regardless of which export is used).
const OUTPUT_FILES_DIR_NAME = "ro-crate-preview_files";

export function createPlugin(deps) {
  return {
    name: "docx-input",
    inputMode: "docx",
    // docx_crate.js already wipes and recreates this directory unconditionally
    // on every build (buildCrateFromDocxFolder), so declaring it here is about
    // scan-exclusion and the folder-wide "delete plugin output" build setting
    // — not about docx-input needing help cleaning up after itself.
    outputPaths: [{ path: OUTPUT_FILES_DIR_NAME, kind: "dir" }],
    async buildCrate(ctx) {
      ctx.log("Parsing structured Word documents (Heading 1/2/3 → Collections/Chapters)…", "info");
      const { buildCrateFromDocxFolder, scanDocxFolder, configure } = await import("./docx_crate.js");
      configure(deps);

    const scan = await scanDocxFolder(ctx.dirHandle);
    if (scan.docxCount === 0) {
      throw new Error(
        "No .docx files found in this folder's sub-folders. Expected one folder per collection " +
        "directly inside the picked folder, each containing structured .docx files."
      );
    }
    if (!scan.hasHeadingStyles) {
      ctx.log(
        "Warning: none of the sampled .docx files use Word's Heading 1/2/3 paragraph styles — " +
        "structure (Collections/Chapters) may come out empty. See the README for the required authoring conventions.",
        "warn"
      );
    }

    const result = await buildCrateFromDocxFolder(ctx.dirHandle, ctx.config, (msg) => ctx.log(msg, "muted"));
    if (!result) {
      throw new Error(
        "No collection sub-folders with .docx files were found. Expected one folder per collection " +
        "directly inside the picked folder, each containing structured .docx files — see " +
        "corpus-tools-person-centred-collections-docx's README for the folder layout."
      );
    }
      ctx.crate = result.crate;
      ctx.sourceCount = result.documentPartCount;
      ctx.log(`Built crate: ${result.collectionCount} collection(s), ${result.documentPartCount} document(s).`, "ok");
    },
  };
}
