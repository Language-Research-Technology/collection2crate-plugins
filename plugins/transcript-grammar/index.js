// transcript-grammar: define a transcript's layout by marking up a sample,
// and save the regular expressions that markup implies as standing
// configuration for parsing other documents in the same format.
//
// This plugin taps no build stage. It offers two actions in the Build panel
// (collection2crate runs an `action` node's run() there and then, outside a
// build — SPEC.md §6.2 and §9):
//
//   Define a transcript grammar…  — the three-step editor in ui.js: source
//                                   document → regions → row markup → save.
//   Test a transcript grammar…    — parse another document with a saved one.
//
// Grammars live at _config/transcript-grammar/<name>.json — standing
// configuration, so under _config/ (collection2crate issue #81's per-plugin
// directory convention, as roctable uses it) and kept by "Delete plugin
// output before rebuilding". The file holds the patterns and the field
// structure only; the sample text it was marked up from is never written.
//
// The parser is grammar.js's parseWithGrammar(), pure and importable, for a
// build-time consumer such as ca-data-prep to read a saved grammar with.
import { GRAMMAR_VERSION, textToLines, validateGrammar } from "./grammar.js";
import { openGrammarEditor, openGrammarTester } from "./ui.js";

export { parseWithGrammar, validateGrammar } from "./grammar.js";

export const CONFIG_DIR = "_config/transcript-grammar";

let writeFileAtPath, readFileTextFromDirectory, openModal;

export function createPlugin(deps) {
  ({ writeFileAtPath, readFileTextFromDirectory, openModal } = deps);
  return plugin;
}

async function configDirectory(dirHandle) {
  let dir = dirHandle;
  try {
    for (const part of CONFIG_DIR.split("/")) dir = await dir.getDirectoryHandle(part, { create: false });
    return dir;
  } catch {
    return null;
  }
}

export async function listGrammars(dirHandle) {
  const dir = await configDirectory(dirHandle);
  if (!dir) return [];
  const names = [];
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind === "file" && /\.json$/i.test(name)) names.push(name.replace(/\.json$/i, ""));
  }
  return names.sort();
}

export async function loadGrammar(dirHandle, name) {
  const path = `${CONFIG_DIR}/${name}.json`;
  const text = await readFileTextFromDirectory(dirHandle, path);
  if (text == null) throw new Error(`${path} not found.`);
  let grammar;
  try { grammar = JSON.parse(text); }
  catch (e) { throw new Error(`${path} is not valid JSON: ${e.message}`); }
  const problems = validateGrammar(grammar);
  if (problems.length) throw new Error(`${path}: ${problems.join("; ")}`);
  return grammar;
}

// A .docx goes through ca-data-prep's own mammoth extraction, so the lines
// marked up here are exactly the lines that plugin reads. Imported on demand:
// mammoth is heavy and most visits to the Build panel never open the editor.
export async function readDocument(file) {
  if (/\.docx$/i.test(file.name || "")) {
    const { extractDocumentText } = await import("../ca-data-prep/process.js");
    const text = await extractDocumentText(await file.arrayBuffer());
    return textToLines(text, { paragraphs: true });
  }
  return textToLines(await file.text());
}

const plugin = {
  name: "transcript-grammar",
  optionSchema: {
    key: "transcriptGrammarEdit",
    type: "action",
    label: "Define a transcript grammar…",
    hint: `Mark up a sample transcript — its header metadata, speaker info and main regions, then the fields inside speaker and content rows — and save the patterns to ${CONFIG_DIR}/<name>.json for parsing other documents.`,
    run: async ({ dirHandle, log }) => {
      if (!dirHandle) { log("transcript-grammar: pick a folder first — grammars are saved into it.", "warn"); return; }
      const grammars = await listGrammars(dirHandle);
      const outcome = await openGrammarEditor({
        openModal,
        grammars,
        loadGrammar: (name) => loadGrammar(dirHandle, name),
        readDocument,
      });
      if (!outcome) { log("transcript-grammar: nothing saved.", "muted"); return; }
      const { grammar, sourceName } = outcome;
      const saved = {
        ...grammar,
        version: GRAMMAR_VERSION,
        generatedBy: "collection2crate transcript-grammar",
        markedUpFrom: sourceName || null,
        savedAt: new Date().toISOString(),
      };
      const path = `${CONFIG_DIR}/${grammar.name}.json`;
      await writeFileAtPath(dirHandle, path, JSON.stringify(saved, null, 2) + "\n");
      log(`transcript-grammar: saved ${path}.`, "ok");
    },
    children: [
      {
        key: "transcriptGrammarTest",
        type: "action",
        label: "Test a transcript grammar…",
        hint: "Parse another document with a saved grammar and see what it finds and what it misses.",
        run: async ({ dirHandle, log }) => {
          if (!dirHandle) { log("transcript-grammar: pick a folder first.", "warn"); return; }
          const grammars = await listGrammars(dirHandle);
          if (!grammars.length) {
            log(`transcript-grammar: no grammars in ${CONFIG_DIR}/ yet — define one first.`, "warn");
            return;
          }
          await openGrammarTester({
            openModal,
            grammars,
            loadGrammar: (name) => loadGrammar(dirHandle, name),
            readDocument,
            log,
          });
        },
      },
    ],
  },
  outputPaths: [{ path: CONFIG_DIR, kind: "dir" }],
};
