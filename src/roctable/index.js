// Exports a built RO-Crate as one CSV per configured @type, using the
// roctable library (https://github.com/ptsefton/roctable) — this plugin
// takes its name from it. chaos2crate's own crate.js builds its ROCrate
// with the same `ro-crate` package version the roctable library depends on,
// so ctx.crate can be handed straight to its crate-walking functions with
// no adapter needed.
//
// Config lives at _config/roctable/config.json and output at
// _outputs/roctable/ — chaos2crate issue #81's proposed standard per-plugin
// directories (_config/<slug>/ for standing configuration, _outputs/<slug>/
// for disposable generated content), adopted here ahead of that becoming a
// repo-wide convention. Both are excluded from "Delete plugin output before
// rebuilding" on the chaos2crate side (SPEC.md), since _config/ specifically
// is meant to persist across builds, not be cleared like _outputs/.
//
// On a build with no existing config (nothing at _config/roctable/config.json
// and nothing uploaded), the build blocks on the tree editor
// (config-tree-ui.js) so a person picks tables/properties before anything is
// extracted — the config is then written and that same build proceeds to
// extract+write CSVs from the just-confirmed selection. Once a config
// exists, later builds use it directly with no prompt; "Configure tables…"
// (an action tile, see optionSchema below) reopens the same editor on
// demand, independent of a build.
//
// load_text (the roctable library's "read this property's referenced file
// into the row" feature) reads through an injected fileReader
// (ptsefton/roctable#2) rather than its own Node-fs default —
// browserFileReader below wraps chaos2crate's readFileTextFromDirectory,
// which already returns null for "not found", matching what extractTables'
// loadText expects from a reader.
import { extractTables } from "roctable/lib/extract.js";
import { tablesToCsvStrings } from "roctable/lib/csv.js";
import { discoverConfig } from "./discover.js";
import { openConfigTreeEditor } from "./config-tree-ui.js";

const CONFIG_DIR = "_config/roctable";
const CONFIG_FILE = `${CONFIG_DIR}/config.json`;
const OUTPUT_DIR = "_outputs/roctable";
const CRATE_FILE = "ro-crate-metadata.json";

// Hook names are literal strings and core chaos2crate functions arrive via
// createPlugin(deps) — see this repo's README.
let readJsonFromFolder, writeFileAtPath, getFileHandleAtPath, readFileTextFromDirectory, loadCrateFromJson, openModal;

export function createPlugin(deps) {
  ({ readJsonFromFolder, writeFileAtPath, getFileHandleAtPath, readFileTextFromDirectory, loadCrateFromJson, openModal } = deps);
  return plugin;
}

function browserFileReader(dirHandle) {
  return { readFile: (relPath) => readFileTextFromDirectory(dirHandle, relPath) };
}

async function existsAtPath(dirHandle, relativePath) {
  return !!(await getFileHandleAtPath(dirHandle, relativePath));
}

async function readConfigFromFolder(dirHandle) {
  const text = await readFileTextFromDirectory(dirHandle, CONFIG_FILE);
  if (text == null) return null;
  try { return JSON.parse(text); }
  catch (e) { throw new Error(`${CONFIG_FILE} is not valid JSON: ${e.message}`); }
}

const plugin = {
  name: "roctable",
  optionSchema: {
    key: "enableRoctable",
    label: "Export RO-Crate tables",
    default: false,
    hint: `Flattens the crate into one CSV per entity type. On the first build, choose which types/properties to export; the choice is saved to ${CONFIG_FILE} and reused on later builds. See docs/roctable-spec.md.`,
    children: [
      {
        key: "roctableConfigure", type: "action", label: "Configure tables…",
        hint: "Review or change which types/properties become tables, without waiting for a build.",
        run: async ({ dirHandle, log }) => {
          if (!dirHandle) { log("roctable: pick a folder first.", "warn"); return; }
          const crateJson = await readJsonFromFolder(dirHandle, CRATE_FILE);
          if (!crateJson) {
            log(`roctable: no ${CRATE_FILE} in this folder yet — build once first, then configure tables.`, "warn");
            return;
          }
          let config;
          try {
            const existingConfig = await readConfigFromFolder(dirHandle);
            config = discoverConfig(loadCrateFromJson(crateJson), existingConfig);
          } catch (e) {
            log(`roctable: could not inspect the crate — ${e.message}`, "warn");
            return;
          }
          const edited = await openConfigTreeEditor({ config, openModal });
          if (edited === null) { log("roctable: configuration unchanged.", "muted"); return; }
          await writeFileAtPath(dirHandle, CONFIG_FILE, JSON.stringify(edited, null, 2) + "\n");
          log(`roctable: saved ${CONFIG_FILE}. Rebuild to regenerate the CSV output.`, "ok");
        },
      },
      { key: "roctableConfigUpload", type: "file", label: "Table config (JSON)",
        accept: "application/json,.json",
        hint: `Overrides ${CONFIG_FILE} from the folder, if present.` },
    ],
  },
  outputPaths: [
    { path: CONFIG_DIR, kind: "dir" },
    { path: OUTPUT_DIR, kind: "dir" },
  ],
  hooks: {
    "crate:built": async (ctx) => {
      if (!ctx.options.enableRoctable) return;
      const { crate, dirHandle, options, log } = ctx;

      let existingConfig = null;
      let configSource = "none — starting fresh";
      if (options.roctableConfigUpload) {
        const text = await options.roctableConfigUpload.file.text();
        try { existingConfig = JSON.parse(text); }
        catch (e) { throw new Error(`uploaded table config "${options.roctableConfigUpload.name}" is not valid JSON: ${e.message}`); }
        configSource = `uploaded (${options.roctableConfigUpload.name})`;
      } else {
        const folderConfig = await readConfigFromFolder(dirHandle);
        if (folderConfig) { existingConfig = folderConfig; configSource = CONFIG_FILE; }
      }

      let config;
      try {
        config = discoverConfig(crate, existingConfig);
      } catch (e) {
        log(`roctable: could not inspect the crate — ${e.message}`, "warn");
        return;
      }

      if (!existingConfig) {
        log("roctable: no existing table configuration — opening the table picker.", "info");
        const edited = await openConfigTreeEditor({ config, openModal });
        if (edited === null) throw new Error("Build cancelled: table configuration was not confirmed.");
        config = edited;
        configSource = "configured just now";
      }

      ctx.roctable = { config, configSource };

      const tableNames = Object.keys(config.tables || {});
      if (!tableNames.length) {
        log(`roctable: no tables selected (config source: ${configSource}). Use "Configure tables…" to pick some, or edit ${CONFIG_FILE} directly.`, "warn");
        return;
      }

      try {
        const data = await extractTables(crate, config, { fileReader: browserFileReader(dirHandle) });
        ctx.roctable.csv = tablesToCsvStrings(data);
        log(`roctable: built ${tableNames.length} table(s) — ${tableNames.join(", ")}.`, "ok");
      } catch (e) {
        log(`roctable: failed to extract tables — ${e.message}`, "warn");
      }
    },

    "output:write": async (ctx) => {
      if (!ctx.options.enableRoctable || !ctx.roctable) return;
      const { dirHandle, options, log } = ctx;
      const { config, csv } = ctx.roctable;

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
      if (written) log(`roctable: wrote ${written} CSV file(s) to ${OUTPUT_DIR}/.`, "ok");
    },
  },
};
