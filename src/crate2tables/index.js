// Exports a built RO-Crate as one CSV per configured @type, using roctable
// (https://github.com/ptsefton/roctable) — a WIP, git-installed library that
// flattens an `ro-crate` ROCrate graph into tables according to a JSON
// config. chaos2crate's own crate.js builds its ROCrate with the same
// `ro-crate` package version roctable depends on, so ctx.crate can be handed
// straight to roctable's crate-walking functions with no adapter needed.
//
// roctable's own CLI is a two-step workflow: `roctable inspect` discovers
// every @type/property in a crate and writes/updates a config (new fields
// default to unselected, existing choices are preserved); `roctable csv`
// then extracts tables for whatever the config's "tables" section selects.
// This plugin runs the same two steps on every build instead of requiring a
// separate CLI pass: it always re-discovers against the current crate and
// rewrites crate2tables-config.json (non-destructively — see
// roctable/lib/inspect.js's mergeDiscovered), then extracts+writes CSV for
// whatever the config's "tables" section already selects. A first build
// against a fresh folder therefore selects nothing and only seeds the
// config; a person edits that file (moving a type from "potential_tables" to
// "tables", setting "include"/"expand"/"load_text" on its properties) and
// reruns the build to get output. See docs/crate2tables-spec.md.
//
// load_text (roctable's "read this property's referenced file into the row"
// feature) reads through an injected fileReader (ptsefton/roctable#1) rather
// than roctable's own Node-fs default — browserFileReader below wraps
// chaos2crate's readFileTextFromDirectory, which already returns null for
// "not found", matching what extractTables' loadText expects from a reader.
import { inspectCrate, mergeDiscovered, discoverExpandedProperties } from "roctable/lib/inspect.js";
import { extractTables } from "roctable/lib/extract.js";
import { tablesToCsvStrings } from "roctable/lib/csv.js";
import { defaultConfig } from "roctable/lib/config.js";

const CONFIG_FILE = "crate2tables-config.json";
const OUTPUT_DIR = "crate2tables-output";

// Hook names are literal strings and core chaos2crate functions arrive via
// createPlugin(deps) — see this repo's README.
let readJsonFromFolder, writeFileAtPath, getFileHandleAtPath, readFileTextFromDirectory;

export function createPlugin(deps) {
  ({ readJsonFromFolder, writeFileAtPath, getFileHandleAtPath, readFileTextFromDirectory } = deps);
  return plugin;
}

function browserFileReader(dirHandle) {
  return { readFile: (relPath) => readFileTextFromDirectory(dirHandle, relPath) };
}

async function existsAtPath(dirHandle, relativePath) {
  return !!(await getFileHandleAtPath(dirHandle, relativePath));
}

const plugin = {
  name: "crate2tables",
  optionSchema: {
    key: "enableCrate2Tables",
    label: "Export RO-Crate tables",
    default: false,
    hint: 'Flattens the crate into one CSV per entity type, using crate2tables-config.json — written to the folder on the first build with every discovered type/property, unselected. Move a type from "potential_tables" to "tables" and set "include": true on the properties you want, then rebuild. See docs/crate2tables-spec.md.',
    children: [
      { key: "crate2tablesConfigUpload", type: "file", label: "Table config (JSON)",
        accept: "application/json,.json",
        hint: "Overrides crate2tables-config.json from the folder, if present." },
    ],
  },
  outputPaths: [
    { path: CONFIG_FILE, kind: "file" },
    { path: OUTPUT_DIR, kind: "dir" },
  ],
  hooks: {
    "crate:built": async (ctx) => {
      if (!ctx.options.enableCrate2Tables) return;
      const { crate, dirHandle, options, log } = ctx;

      let existingConfig = null;
      let configSource = "none — starting fresh";
      if (options.crate2tablesConfigUpload) {
        const text = await options.crate2tablesConfigUpload.file.text();
        try { existingConfig = JSON.parse(text); }
        catch (e) { throw new Error(`uploaded table config "${options.crate2tablesConfigUpload.name}" is not valid JSON: ${e.message}`); }
        configSource = `uploaded (${options.crate2tablesConfigUpload.name})`;
      } else {
        const folderConfig = await readJsonFromFolder(dirHandle, CONFIG_FILE);
        if (folderConfig) { existingConfig = folderConfig; configSource = CONFIG_FILE; }
      }

      let config;
      try {
        config = discoverExpandedProperties(crate, mergeDiscovered(existingConfig || defaultConfig(), inspectCrate(crate)));
      } catch (e) {
        log(`crate2tables: could not inspect the crate — ${e.message}`, "warn");
        return;
      }

      ctx.crate2tables = { config, configSource };

      const tableNames = Object.keys(config.tables || {});
      if (!tableNames.length) {
        log(`crate2tables: no tables selected yet (config source: ${configSource}). Wrote every discovered type to ${CONFIG_FILE} under "potential_tables" — move the ones you want into "tables" and rebuild.`, "warn");
        return;
      }

      try {
        const data = await extractTables(crate, config, { fileReader: browserFileReader(dirHandle) });
        ctx.crate2tables.csv = tablesToCsvStrings(data);
        log(`crate2tables: built ${tableNames.length} table(s) — ${tableNames.join(", ")}.`, "ok");
      } catch (e) {
        log(`crate2tables: failed to extract tables — ${e.message}`, "warn");
      }
    },

    "output:write": async (ctx) => {
      if (!ctx.options.enableCrate2Tables || !ctx.crate2tables) return;
      const { dirHandle, options, log } = ctx;
      const { config, csv } = ctx.crate2tables;

      // Non-destructive by construction (mergeDiscovered only ever adds
      // newly-seen types/properties, unselected — see roctable/lib/inspect.js),
      // so rewriting it every build is the same "keep it fresh" behaviour as
      // rerunning `roctable inspect`, not a risk to a hand-edited config.
      await writeFileAtPath(dirHandle, CONFIG_FILE, JSON.stringify(config, null, 2) + "\n");

      if (!csv) return;
      let written = 0;
      for (const [tableName, text] of Object.entries(csv)) {
        const path = `${OUTPUT_DIR}/${tableName}.csv`;
        if (options.overwrite || !(await existsAtPath(dirHandle, path))) {
          await writeFileAtPath(dirHandle, path, text);
          written++;
        } else {
          log(`${path} exists and overwrite is off — skipped.`, "warn");
        }
      }
      if (written) log(`crate2tables: wrote ${written} CSV file(s) to ${OUTPUT_DIR}/.`, "ok");
    },
  },
};
