// Registry of every plugin this package ships, keyed by the same "name"
// each plugin's factory returns (matching chaos2crate's PLUGINS array
// order/keys before this repo existed). chaos2crate's src/plugins/index.js
// imports REGISTRY/INPUT_REGISTRY, filters them against its PLUGINS env var,
// and calls each selected factory with the chaos2crate core functions it
// declares needing (see README.md's per-plugin dependency table) — nothing
// here imports chaos2crate itself, so filtering out an entry keeps its
// whole subtree (and its dynamic imports, e.g. austlang's data pack or
// docx-input's mammoth/cheerio) out of a build that didn't ask for it.
import { createPlugin as createXlsxCrateInput } from "./src/xlsx-crate-input/index.js";
import { createPlugin as createAustlang } from "./src/austlang/index.js";
import { createPlugin as createFileFormatIdentify } from "./src/file-format-identify/index.js";
import { createPlugin as createCaDataPrep } from "./src/ca-data-prep/index.js";
import { createPlugin as createChatExport } from "./src/chat-export/index.js";
import { createPlugin as createMerge } from "./src/merge/index.js";
import { createPlugin as createValidateCrate } from "./src/validate-crate/index.js";
import { createPlugin as createJsonOutput } from "./src/ro-crate-json-output/index.js";
import { createPlugin as createXlsxOutput } from "./src/ro-crate-xlsx-output/index.js";
import { createPlugin as createHtmlOutput } from "./src/ro-crate-html-output/index.js";
import { createPlugin as createCrate2Tables } from "./src/crate2tables/index.js";
import { createPlugin as createGenericInput } from "./src/generic-input/index.js";
import { createPlugin as createDocxInput } from "./src/docx-input/index.js";

// Additive plugins — order here doubles as the default hook-execution order
// for plugins sharing a hook stage (same reasoning as the old PLUGINS array:
// createHookBus's priority defaults to 10 for every registration and
// Array#sort is stable, so registration order reproduces the original
// sequence). chaos2crate is responsible for preserving this order when
// it filters by its PLUGINS env var.
export const REGISTRY = {
  "xlsx-crate-input": createXlsxCrateInput,
  "austlang": createAustlang,
  "file-format-identify": createFileFormatIdentify,
  "ca-data-prep": createCaDataPrep,
  "chat-export": createChatExport,
  "merge": createMerge,
  "crate2tables": createCrate2Tables,
  "validate-crate": createValidateCrate,
  "ro-crate-json-output": createJsonOutput,
  "ro-crate-xlsx-output": createXlsxOutput,
  "ro-crate-html-output": createHtmlOutput,
};

// Input-mode plugins — mutually exclusive, keyed by inputMode rather than
// additive like REGISTRY above (see chaos2crate's pipeline.js).
export const INPUT_REGISTRY = {
  generic: createGenericInput,
  docx: createDocxInput,
};
