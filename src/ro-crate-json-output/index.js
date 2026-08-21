// Always-on: writes ro-crate-metadata.json. No optionSchema — matches the
// current unconditional behavior (gated only by the overwrite/file-exists
// check every output plugin already respects).
//
// Hook names are literal strings (a stable chaos2crate contract, see
// this repo's README) rather than an imported HOOKS constant, and the core
// chaos2crate functions this plugin needs (crate.js/fs_helpers.js) are
// injected via createPlugin(deps) rather than imported by relative path —
// that's what keeps this package free of any runtime dependency back on
// chaos2crate.
let crateToJsonString, writeFile, fileExists;

const JSON_FILE = "ro-crate-metadata.json";

export function createPlugin(deps) {
  ({ crateToJsonString, writeFile, fileExists } = deps);
  return plugin;
}

const plugin = {
  name: "ro-crate-json-output",
  outputPaths: [{ path: JSON_FILE, kind: "file" }],
  hooks: {
    "output:write": async (ctx) => {
      const { dirHandle, options, crate, log } = ctx;
      if (options.overwrite || !(await fileExists(dirHandle, JSON_FILE))) {
        await writeFile(dirHandle, JSON_FILE, crateToJsonString(crate));
        log(`Wrote ${JSON_FILE}.`, "ok");
      } else {
        log(`${JSON_FILE} exists and overwrite is off — skipped.`, "warn");
      }
    },
  },
};
