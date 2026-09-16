// The transcript grammar editor: four dialogs in sequence, each an ordinary
// openModal (collection2crate SPEC.md §6.2) whose footer carries Back / Next.
//
//   1. Source   — paste a transcript or choose a file, and name the grammar.
//   2. Regions  — mark line ranges as header metadata, speaker info or main,
//                 flag the marker lines ("Speakers:", "PRELIMINARIES"), and
//                 flag lines to ignore ("END OF TRANSCRIPT").
//   3. Cleanup  — rules for lines to skip and text to remove from rows,
//                 with a before/after preview of the whole document.
//   4. Rows     — select characters inside the cleaned sample rows and say
//                 what they are:
//                 a speaker's code / name / alternate name / affiliation / id,
//                 or a turn's number / speaker / text. The generated patterns
//                 are re-run over the whole document on every change, so the
//                 person sees what they would parse before saving.
//
// Everything the person edits lives in one `state` object that outlives each
// dialog, so Back loses nothing. The DOM is built with src/_panel.js and the
// host's own classes; the few rules specific to this editor are prefixed
// `tg-` and injected once, the way roctable's tree editor does it.

import { element, button, field, dataTable } from "../../src/_panel.js";
import {
  REGIONS, IGNORE, SPEAKER_FIELDS, TURN_FIELDS, HEADER_FIELD_PATTERN,
  DEFAULT_GRAMMAR, IGNORE_FIELD, applyCleanup, buildGrammar, buildRegions, exactPattern,
  ignoreLinePattern, literalLinePattern, patternError, shapePattern, buildRowPattern, checkRegionOrder,
  parseWithGrammar, suggestRegions, suggestSamples, textToLines,
} from "../../src/_transcript_grammar.js";

const MODAL_CLASS = "tg-modal";
const RENDER_CAP = 300;

const FIELD_COLOURS = {
  code: "#d97706", name: "#2563eb", alternateName: "#7c3aed", affiliation: "#0891b2", id: "#db2777",
  turn: "#d97706", speaker: "#2563eb", text: "#16a34a",
  [IGNORE_FIELD]: "#8a929c",
};

// Offered on every row, after the row's own fields: fixed text to match but
// not keep ("<u speaker=", the ">" after a name).
const IGNORE_BUTTON = {
  key: IGNORE_FIELD,
  label: "Ignore",
  title: "Fixed text every row has but nobody wants kept — matched as written, not saved as a field",
};

const ROLE_LABELS = {
  header: "Header metadata", speakers: "Speaker info", main: "Main", [IGNORE]: "Ignore",
};

function ensureStyle() {
  if (document.getElementById("transcript-grammar-style")) return;
  const fieldRules = Object.entries(FIELD_COLOURS).map(([key, colour]) => (
    `.tg-f-${key} { background: color-mix(in srgb, ${colour} 24%, transparent); box-shadow: inset 0 -2px 0 ${colour}; }\n` +
    `.tg-swatch-${key} { background: ${colour}; }`
  )).join("\n");
  const style = document.createElement("style");
  style.id = "transcript-grammar-style";
  style.textContent = `
.modal-panel.${MODAL_CLASS} { width: min(1100px, 96vw); }
/* A fixed height: the host centres modals vertically, so a panel that grew and
   shrank with the live results moved the row being marked out from under the
   pointer between one selection and the next. */
.modal-panel.${MODAL_CLASS}:has(.tg-sample) { height: 86vh; }
.modal-panel.${MODAL_CLASS} .modal-body { flex: 1; }
.tg-toolbar { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin: 10px 0; }
.tg-toolbar .field-hint { margin: 0 6px 0 0; }
.tg-lines { font-family: var(--mono); font-size: 12.5px; border: 1px solid var(--border);
  border-radius: var(--radius-sm); max-height: 50vh; overflow: auto; user-select: none; background: var(--panel); }
.tg-lines:focus-visible { outline: 2px solid var(--accent); }
.tg-line { display: grid; grid-template-columns: 3.2em 8.5em minmax(0, 1fr); gap: 8px; padding: 1px 8px 1px 0;
  border-left: 5px solid transparent; cursor: pointer; }
.tg-line:hover { background: var(--panel-2); }
.tg-line[aria-selected="true"] { background: var(--accent-soft); }
.tg-line.tg-cursor { outline: 1px dashed var(--accent); outline-offset: -1px; }
.tg-num { color: var(--muted); text-align: right; }
.tg-role { color: var(--muted); font-size: 11px; white-space: nowrap; overflow: hidden; }
.tg-text { white-space: pre; tab-size: 4; overflow: hidden; text-overflow: ellipsis; }
.tg-line.tg-marker .tg-text { font-weight: 700; }
.tg-line.tg-ignore .tg-text { text-decoration: line-through; color: var(--muted); }
.tg-line.tg-blank .tg-text::after { content: "¶"; color: var(--border); }
.tg-r-header { border-left-color: var(--warn); }
.tg-r-speakers { border-left-color: var(--ok); }
.tg-r-main { border-left-color: var(--accent); }
.tg-r-ignore { border-left-color: var(--muted); }
.tg-key { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 5px; vertical-align: -1px; }
.tg-key.tg-r-header { background: var(--warn); } .tg-key.tg-r-speakers { background: var(--ok); }
.tg-key.tg-r-main { background: var(--accent); } .tg-key.tg-r-ignore { background: var(--muted); }
.tg-problems { color: var(--warn); font-size: 13px; margin: 8px 0 0; padding-left: 18px; }
.tg-error { color: var(--err); font-size: 13px; margin: 0 0 10px; }
.tg-sample { border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 8px 10px; margin-bottom: 8px; background: var(--panel); }
.tg-sample-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.tg-sample-head .field-hint { flex: 1; margin: 0; }
.tg-strip { font-family: var(--mono); font-size: 14px; white-space: pre; tab-size: 4; overflow-x: auto;
  padding: 6px 8px; background: var(--panel-2); border-radius: var(--radius-sm); user-select: text; cursor: text; line-height: 1.9; }
.tg-f-${IGNORE_FIELD} { text-decoration: line-through; text-decoration-color: color-mix(in srgb, var(--muted) 70%, transparent); }
.tg-tab { background: color-mix(in srgb, var(--muted) 18%, transparent); }
.tg-fields { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; align-items: center; }
.tg-swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; }
.tg-pattern { font-family: var(--mono); font-size: 12px; min-height: 0; width: 100%; }
.tg-summary { font-size: 13px; margin: 8px 0; }
.tg-summary .ok { color: var(--ok); } .tg-summary .warn { color: var(--warn); }
.tg-unmatched { font-family: var(--mono); font-size: 12px; white-space: pre; color: var(--warn); margin: 4px 0; }
.tg-section-title { font-size: 14px; margin: 14px 0 6px; }
.tg-toolbar input[type="text"] { flex: 1; width: auto; min-width: 14em; }
.tg-rule { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 8px; align-items: center; margin-bottom: 6px; }
.tg-rule .field-hint { margin: 0; white-space: nowrap; }
.tg-optional { display: flex; gap: 14px; flex-wrap: wrap; font-size: 13px; margin: 6px 0; }
${fieldRules}
`;
  document.head.append(style);
}

const truncate = (text, n = 90) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);
const shown = (line) => String(line).replace(/\t/g, " → ");

// ---------------------------------------------------------------------------
// Step 1 — source
// ---------------------------------------------------------------------------

async function sourceStep(state, { openModal, grammars, loadGrammar, readDocument, error }) {
  const nameInput = element("input", { attrs: { type: "text", value: state.name, spellcheck: "false" } });
  nameInput.className = "mono";

  const baseSelect = element("select");
  baseSelect.append(element("option", { text: "— the ca-data-prep convention —", attrs: { value: "" } }));
  for (const name of grammars) baseSelect.append(element("option", { text: name, attrs: { value: name } }));
  baseSelect.value = state.baseName || "";

  const textarea = element("textarea", { className: "mono", attrs: { rows: 14, spellcheck: "false", placeholder: "Paste a transcript here, or choose a file below." } });
  const draft = state.draftLines || state.lines;
  textarea.value = draft ? draft.join("\n") : "";
  textarea.style.whiteSpace = "pre";
  textarea.style.tabSize = "4";

  const fileInput = element("input", { attrs: { type: "file", accept: ".txt,.text,.md,.csv,.tsv,.docx,text/plain" } });
  const fileStatus = element("span", { className: "file-chosen", text: state.sourceName ? `✓ ${state.sourceName}` : "" });
  let sourceName = state.sourceName;
  let pasted = false;
  textarea.addEventListener("input", () => { pasted = true; });

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    fileStatus.textContent = `Reading ${file.name}…`;
    try {
      const lines = await readDocument(file);
      textarea.value = lines.join("\n");
      sourceName = file.name;
      pasted = false;
      fileStatus.textContent = `✓ ${file.name} — ${lines.length} line(s)`;
    } catch (e) {
      fileStatus.textContent = `Could not read ${file.name}: ${e.message}`;
    }
  });

  const result = await openModal({
    title: "Transcript grammar — 1 of 4: source document",
    modalClassName: MODAL_CLASS,
    onMount(body) {
      ensureStyle();
      if (error) body.append(element("p", { className: "tg-error", text: error }));
      body.append(
        element("p", { className: "field-hint", text: "Mark up one representative transcript. The patterns generated from it are saved to the folder's _config/transcript-grammar/ and can then parse other documents in the same format. Only the patterns are saved — never the sample's text." }),
        field("Grammar name (saved as _config/transcript-grammar/<name>.json)", nameInput),
        grammars.length ? field("Suggest the markup from", baseSelect) : null,
        field("Transcript text", textarea),
        element("label", { className: "field" }, [
          element("span", { className: "field-label", text: "…or choose a file (.txt, .docx)" }),
          fileInput, fileStatus,
        ]),
      );
    },
    actions: [
      { label: "Cancel", value: null },
      { label: "Next: regions", primary: true, value: () => ({ nav: "next" }) },
    ],
  });
  if (!result) return null;

  const name = nameInput.value.trim();
  const text = textarea.value;
  const lines = textToLines(text);
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  state.name = name;
  state.draftLines = lines;
  if (!/^[\w.-]+$/.test(name)) return { nav: "stay", error: "Name the grammar with letters, digits, dots, dashes or underscores only." };
  if (!lines.some((l) => l.trim())) return { nav: "stay", error: "Paste a transcript or choose a file first." };

  const baseName = baseSelect.value;
  const changed = !state.lines || lines.join("\n") !== state.lines.join("\n") || baseName !== (state.baseName || "");
  state.draftLines = null;
  state.sourceName = pasted ? "pasted text" : sourceName;
  if (changed) {
    const base = baseName ? await loadGrammar(baseName) : null;
    state.baseName = baseName;
    state.base = base;
    state.lines = lines;
    const { roles, markers } = suggestRegions(lines, base);
    state.roles = roles;
    state.markers = markers;
    state.speakerSamples = null;
    state.turnSamples = null;
    state.optional = { speakerRow: [], turnRow: [] };
    // A saved grammar brings its cleanup rules with it.
    state.cleanup = {
      drop: [...(base?.ignore || [])],
      strip: (base?.strip || []).map((r) => r.pattern),
      seen: new Set(base?.ignore || []),
    };
    state.clean = null;
  }
  return { nav: "next" };
}

// ---------------------------------------------------------------------------
// Step 2 — regions
// ---------------------------------------------------------------------------

async function regionStep(state, { openModal, error }) {
  const { lines, roles, markers } = state;
  let anchor = null;
  let cursor = null;
  let dragging = false;

  const list = element("div", { className: "tg-lines", attrs: { role: "listbox", "aria-multiselectable": "true", tabindex: "0", "aria-label": "Document lines" } });
  const rows = lines.map((line, i) => {
    const row = element("div", { className: "tg-line", attrs: { role: "option", "aria-selected": "false", "data-index": i } }, [
      element("span", { className: "tg-num", text: String(i + 1) }),
      element("span", { className: "tg-role" }),
      element("span", { className: "tg-text", text: line, attrs: { title: line } }),
    ]);
    list.append(row);
    return row;
  });
  const problems = element("ul", { className: "tg-problems", attrs: { "aria-live": "polite" } });
  const counts = element("span", { className: "field-hint", attrs: { "aria-live": "polite" } });

  const selection = () => {
    if (anchor == null) return [];
    const [a, b] = anchor <= cursor ? [anchor, cursor] : [cursor, anchor];
    return Array.from({ length: b - a + 1 }, (_, k) => a + k);
  };

  function paintRow(i) {
    const row = rows[i];
    const role = roles[i];
    const blank = !lines[i].trim();
    row.className = "tg-line";
    if (role) row.classList.add(`tg-r-${role}`);
    if (markers[i] && !blank) row.classList.add("tg-marker");
    if (role === IGNORE) row.classList.add("tg-ignore");
    if (blank) row.classList.add("tg-blank");
    if (i === cursor) row.classList.add("tg-cursor");
    row.children[1].textContent = blank ? "" : role ? `${ROLE_LABELS[role]}${markers[i] ? " ◆" : ""}` : "—";
  }

  function refresh() {
    const selected = new Set(selection());
    rows.forEach((row, i) => { row.setAttribute("aria-selected", String(selected.has(i))); paintRow(i); });
    const tally = {};
    roles.forEach((role, i) => { if (role && lines[i].trim()) tally[role] = (tally[role] || 0) + 1; });
    counts.textContent = [
      ...REGIONS.map((r) => `${r.label}: ${tally[r.key] || 0}`),
      `ignored: ${tally[IGNORE] || 0}`,
      `markers: ${markers.filter((m, i) => m && lines[i].trim()).length}`,
      selected.size ? `${selected.size} line(s) selected` : "no selection",
    ].join(" · ");
    problems.replaceChildren(...checkRegionOrder(roles).map((p) => element("li", { text: p })));
  }

  function setCursor(i, extend) {
    cursor = Math.max(0, Math.min(lines.length - 1, i));
    if (!extend || anchor == null) anchor = cursor;
    refresh();
    rows[cursor].scrollIntoView({ block: "nearest" });
  }

  const assign = (role) => {
    for (const i of selection()) {
      roles[i] = role;
      if (role === IGNORE || role === null) markers[i] = false;
    }
    refresh();
  };
  const toggleMarker = () => {
    const picked = selection().filter((i) => lines[i].trim());
    const on = !picked.every((i) => markers[i]);
    for (const i of picked) if (roles[i] !== IGNORE) markers[i] = on;
    refresh();
  };

  list.addEventListener("mousedown", (event) => {
    const row = event.target.closest(".tg-line");
    if (!row) return;
    event.preventDefault();
    list.focus();
    dragging = true;
    setCursor(Number(row.dataset.index), event.shiftKey);
  });
  list.addEventListener("mouseover", (event) => {
    if (!dragging) return;
    const row = event.target.closest(".tg-line");
    if (row) { cursor = Number(row.dataset.index); refresh(); }
  });
  const stopDrag = () => { dragging = false; };
  document.addEventListener("mouseup", stopDrag);

  const keys = { 1: "header", 2: "speakers", 3: "main", 4: IGNORE };
  list.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setCursor((cursor ?? -1) + (event.key === "ArrowDown" ? 1 : -1), event.shiftKey);
    } else if (keys[event.key]) {
      assign(keys[event.key]);
    } else if (event.key.toLowerCase() === "m") {
      toggleMarker();
    } else if (event.key === "Backspace" || event.key === "Delete") {
      assign(null);
    }
  });

  const regionButton = (key, label, shortcut) => {
    const node = button(label, { onClick: () => assign(key), title: `Mark the selected lines (${shortcut})` });
    node.prepend(element("span", { className: `tg-key tg-r-${key}` }));
    return node;
  };

  const result = await openModal({
    title: "Transcript grammar — 2 of 4: regions",
    modalClassName: MODAL_CLASS,
    onMount(body) {
      ensureStyle();
      if (error) body.append(element("p", { className: "tg-error", text: error }));
      body.append(
        element("p", { className: "field-hint", text: "Only Main is required — header metadata and speaker info are optional, and documents parsed later may leave either out. Click a line, then shift-click or drag to select a range, and mark it. A marker line (◆) is structure, not content: the heading that opens the speaker info, or a section name such as PRELIMINARIES inside the main body. Keys: ↑/↓ move (shift extends), 1–4 mark, M toggles marker, Delete clears." }),
        element("div", { className: "tg-toolbar" }, [
          regionButton("header", "Header metadata", "1"),
          regionButton("speakers", "Speaker info", "2"),
          regionButton("main", "Main", "3"),
          regionButton(IGNORE, "Ignore", "4"),
          button("◆ Marker line", { onClick: toggleMarker, title: "Toggle: the selected lines are headings / section markers (M)" }),
          button("Clear", { onClick: () => assign(null), title: "Unmark the selected lines (Delete)" }),
        ]),
        list,
        element("div", { className: "tg-toolbar", attrs: { style: "margin-top:8px" } }, [counts]),
        problems,
      );
      refresh();
      list.focus();
    },
    actions: [
      { label: "Cancel", value: null },
      { label: "Back", value: () => ({ nav: "back" }) },
      { label: "Next: cleanup", primary: true, value: () => ({ nav: "next" }) },
    ],
  });
  document.removeEventListener("mouseup", stopDrag);
  if (!result) return null;
  if (result.nav === "next") {
    const found = checkRegionOrder(roles);
    if (found.length) return { nav: "stay", error: found.join(" ") };
  }
  // Region changes may have removed the lines a sample was taken from.
  for (const key of ["speakerSamples", "turnSamples"]) {
    const region = key === "speakerSamples" ? "speakers" : "main";
    if (state[key]) state[key] = state[key].filter((s) => roles[s.index] === region && !markers[s.index]);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Step 3 — cleanup
// ---------------------------------------------------------------------------
//
// Two kinds of rule, both saved with the grammar and applied before rows are
// read: lines to skip altogether (timestamps between turns, "END OF
// TRANSCRIPT"), and text to remove from speaker and main lines (inline
// timecodes, markup). The rows step then works on the cleaned lines, so the
// fields are marked on text that looks the way the parser will see it.

const CLEANUP_PREVIEW_CAP = 60;

function cleanupRuleList({ rules, hits, describeHit, onChange, global, emptyText }) {
  const list = element("div");
  const draw = () => {
    list.replaceChildren();
    if (!rules.length) list.append(element("p", { className: "empty-note", text: emptyText }));
    rules.forEach((pattern, i) => {
      const input = element("input", { className: "mono", attrs: { type: "text", value: pattern, spellcheck: "false", "aria-label": `Rule ${i + 1}` } });
      const status = element("span", { className: "field-hint" });
      const problem = patternError(pattern, { global });
      status.textContent = problem ? `✕ ${problem}` : describeHit(hits()[i] || []);
      status.style.color = problem ? "var(--err)" : "";
      input.addEventListener("change", () => { rules[i] = input.value; onChange(); });
      const remove = button("Remove", { onClick: () => { rules.splice(i, 1); onChange(true, pattern); } });
      list.append(element("div", { className: "tg-rule" }, [input, status, remove]));
    });
  };
  return { node: list, draw };
}

async function cleanupStep(state, { openModal, error }) {
  const { lines, roles, markers } = state;
  const cleanup = state.cleanup || (state.cleanup = { drop: [], strip: [], seen: new Set() });
  // Lines marked Ignore in the regions step become skip rules — once each, so
  // a rule removed here is not brought back by returning to this step.
  for (const pattern of buildRegions(lines, roles, markers).ignore) {
    if (cleanup.seen.has(pattern)) continue;
    cleanup.seen.add(pattern);
    if (!cleanup.drop.includes(pattern)) cleanup.drop.push(pattern);
  }

  let result = applyCleanup(lines, roles, markers, cleanup);
  const preview = element("div", { attrs: { "aria-live": "polite" } });
  const summary = element("p", { className: "tg-summary" });

  const dropList = cleanupRuleList({
    rules: cleanup.drop,
    hits: () => result.dropHits,
    describeHit: (hit) => (hit.length ? `skips ${hit.length} line(s): ${hit.slice(0, 6).map((i) => i + 1).join(", ")}${hit.length > 6 ? "…" : ""}` : "matches no line"),
    onChange: () => refresh(),
    global: false,
    emptyText: "No lines are skipped.",
  });
  const stripList = cleanupRuleList({
    rules: cleanup.strip,
    hits: () => result.stripHits,
    describeHit: (hit) => (hit.length ? `changes ${hit.length} line(s)` : "changes no line"),
    onChange: () => refresh(),
    global: true,
    emptyText: "Nothing is removed from rows.",
  });

  // Adding a skip rule from a line.
  const skipPicker = element("select", { attrs: { "aria-label": "Line to skip" } });
  const fillSkipPicker = () => {
    skipPicker.replaceChildren(...lines
      .map((line, index) => ({ line, index }))
      .filter(({ line, index }) => line.trim() && !markers[index] && !result.changes.some((c) => c.index === index && c.after === null))
      .map(({ line, index }) => element("option", { text: `${index + 1}: ${truncate(shown(line))}`, attrs: { value: index } })));
  };
  const addSkip = (make) => {
    if (!skipPicker.value) return;
    const pattern = make(lines[Number(skipPicker.value)]);
    if (!cleanup.drop.includes(pattern)) cleanup.drop.push(pattern);
    refresh();
  };

  // Adding a removal from a selection in a sample line.
  const rowLines = () => lines
    .map((line, index) => ({ line: result.lines[index], index }))
    .filter(({ line, index }) => line.trim() && !markers[index] && (roles[index] === "speakers" || roles[index] === "main"));
  const samplePicker = element("select", { attrs: { "aria-label": "Line to select text in" } });
  const sampleStrip = element("div", { className: "tg-strip", attrs: { tabindex: "0" } });
  const stripHint = element("span", { className: "field-hint", text: "Select text in the line, then choose how to remove it." });
  let sampleText = "";
  const showSample = () => {
    sampleText = samplePicker.value === "" ? "" : result.lines[Number(samplePicker.value)];
    renderStrip(sampleStrip, { line: sampleText, spans: [] });
  };
  const fillSamplePicker = () => {
    const keep = samplePicker.value;
    samplePicker.replaceChildren(...rowLines().map(({ line, index }) => element("option", { text: `${index + 1}: ${truncate(shown(line))}`, attrs: { value: index } })));
    if ([...samplePicker.options].some((o) => o.value === keep)) samplePicker.value = keep;
    showSample();
  };
  samplePicker.addEventListener("change", showSample);
  const selection = selectionTracker(sampleStrip, () => sampleText);
  const addRemoval = (make, how) => {
    const range = selection.take();
    if (!range) { stripHint.textContent = "Select part of the line first."; return; }
    const text = sampleText.slice(range.start, range.end);
    const pattern = make(text);
    if (!cleanup.strip.includes(pattern)) cleanup.strip.push(pattern);
    stripHint.textContent = `Removing "${text}" ${how}.`;
    refresh();
  };

  const customInput = (rules, global, label) => {
    const input = element("input", { className: "mono", attrs: { type: "text", spellcheck: "false", placeholder: "or type a regular expression", "aria-label": label } });
    const add = button("Add", {
      onClick: () => {
        const problem = patternError(input.value, { global });
        if (problem) { input.setCustomValidity(problem); input.reportValidity(); return; }
        input.setCustomValidity("");
        if (!rules.includes(input.value)) rules.push(input.value);
        input.value = "";
        refresh();
      },
    });
    return [input, add];
  };

  function refresh() {
    result = applyCleanup(lines, roles, markers, cleanup);
    dropList.draw();
    stripList.draw();
    fillSkipPicker();
    fillSamplePicker();
    const dropped = result.changes.filter((c) => c.after === null).length;
    const edited = result.changes.length - dropped;
    summary.textContent = `${dropped} line(s) skipped · ${edited} line(s) changed`;
    preview.replaceChildren(...result.changes.slice(0, CLEANUP_PREVIEW_CAP).map((c) => element("div", {
      className: "tg-unmatched",
      attrs: { style: c.after === null ? "color: var(--muted); text-decoration: line-through" : "color: var(--text)" },
      text: c.after === null ? `${c.index + 1}: ${shown(c.before)}` : `${c.index + 1}: ${shown(c.before)}  ⟶  ${shown(c.after)}`,
    })));
    if (result.changes.length > CLEANUP_PREVIEW_CAP) preview.append(element("p", { className: "field-hint", text: `…and ${result.changes.length - CLEANUP_PREVIEW_CAP} more.` }));
  }

  const outcome = await openModal({
    title: "Transcript grammar — 3 of 4: cleanup",
    modalClassName: MODAL_CLASS,
    onMount(body) {
      ensureStyle();
      if (error) body.append(element("p", { className: "tg-error", text: error }));
      body.append(
        element("p", { className: "field-hint", text: "Rules applied before rows are read, and saved with the grammar. Digits in a rule made from a line or a shape match any digits." }),

        element("h3", { className: "tg-section-title", text: "Lines to skip" }),
        element("p", { className: "field-hint", text: "Whole lines the parser steps over wherever they appear — timestamps between turns, page furniture, \"END OF TRANSCRIPT\". Lines marked Ignore in the regions step start out here." }),
        dropList.node,
        element("div", { className: "tg-toolbar" }, [
          skipPicker,
          button("Skip lines like this", { onClick: () => addSkip(ignoreLinePattern), title: "Digits match any digits" }),
          button("Skip exactly this line", { onClick: () => addSkip(literalLinePattern) }),
        ]),
        element("div", { className: "tg-toolbar" }, customInput(cleanup.drop, false, "Skip-line pattern")),

        element("h3", { className: "tg-section-title", text: "Text to remove from rows" }),
        element("p", { className: "field-hint", text: "Removed from speaker-info and main lines wherever it appears — inline timecodes, markup, notes — before the rows step. Select it in a line below." }),
        stripList.node,
        element("div", { className: "tg-toolbar" }, [samplePicker]),
        sampleStrip,
        element("div", { className: "tg-toolbar" }, [
          stripHint,
          keepsSelection(button("Remove exactly this", { onClick: () => addRemoval(exactPattern, "wherever it appears as written") })),
          keepsSelection(button("Remove anything shaped like this", { onClick: () => addRemoval(shapePattern, "and anything shaped like it"), title: "Digits match any digits and letters any letters; punctuation is kept" })),
        ]),
        element("div", { className: "tg-toolbar" }, customInput(cleanup.strip, true, "Removal pattern")),

        element("h3", { className: "tg-section-title", text: "Effect on the sample" }),
        summary,
        preview,
      );
      refresh();
    },
    actions: [
      { label: "Cancel", value: null },
      { label: "Back", value: () => ({ nav: "back" }) },
      { label: "Next: rows", primary: true, value: () => ({ nav: "next" }) },
    ],
  });
  if (!outcome) return null;

  const invalid = [
    ...cleanup.drop.map((p) => patternError(p)),
    ...cleanup.strip.map((p) => patternError(p, { global: true })),
  ].filter(Boolean);
  if (outcome.nav === "next" && invalid.length) return { nav: "stay", error: `Fix the cleanup rules first: ${invalid.join("; ")}.` };

  // The rows step works on the cleaned lines. A sample whose line the cleanup
  // changed (or skipped) no longer shows what the pattern will read.
  state.clean = applyCleanup(lines, roles, markers, cleanup);
  for (const key of ["speakerSamples", "turnSamples"]) {
    if (state[key]) state[key] = state[key].filter((sample) => state.clean.lines[sample.index] === sample.line);
  }
  return outcome;
}

// ---------------------------------------------------------------------------
// Step 4 — rows
// ---------------------------------------------------------------------------

function offsetWithin(container, node, offset) {
  const range = document.createRange();
  range.selectNodeContents(container);
  range.setEnd(node, offset);
  return range.toString().length;
}

function renderStrip(strip, sample) {
  const { line, spans } = sample;
  const cuts = new Set([0, line.length]);
  for (const s of spans) { cuts.add(s.start); cuts.add(s.end); }
  for (let i = 0; i < line.length; i++) if (line[i] === "\t") { cuts.add(i); cuts.add(i + 1); }
  const points = [...cuts].sort((a, b) => a - b);
  strip.replaceChildren();
  for (let k = 0; k < points.length - 1; k++) {
    const [a, b] = [points[k], points[k + 1]];
    if (a === b) continue;
    const span = spans.find((s) => s.start <= a && b <= s.end);
    const text = line.slice(a, b);
    const node = element("span", { text });
    const classes = [];
    if (span) { classes.push(`tg-f-${span.field}`); node.title = span.field; }
    if (text === "\t") classes.push("tg-tab");
    if (classes.length) node.className = classes.join(" ");
    strip.append(node);
  }
}

/**
 * The selection inside a strip of text, as character offsets into that text.
 *
 * A drag that runs past the end of the line (onto the padding, or down onto
 * the buttons) ends outside the strip; it is clamped to the strip rather than
 * rejected. The selection is also remembered as it is made, so a click that
 * disturbs the live selection still acts on what was selected.
 */
function selectionTracker(strip, getText) {
  const read = () => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    const whole = document.createRange();
    whole.selectNodeContents(strip);
    // -1 before the strip, 0 inside it, 1 after it.
    const where = (node, offset) => {
      try { return whole.comparePoint(node, offset); } catch { return null; }
    };
    const startAt = where(range.startContainer, range.startOffset);
    const endAt = where(range.endContainer, range.endOffset);
    if (startAt === null || endAt === null || startAt > 0 || endAt < 0) return null; // no overlap
    const text = getText();
    let start = startAt < 0 ? 0 : offsetWithin(strip, range.startContainer, range.startOffset);
    let end = endAt > 0 ? text.length : offsetWithin(strip, range.endContainer, range.endOffset);
    // Snap to the text: a selection dragged over the whitespace either side
    // of a field is a selection of the field.
    while (start < end && /\s/.test(text[start])) start++;
    while (end > start && /\s/.test(text[end - 1])) end--;
    return end > start ? { start, end } : null;
  };

  let pending = null;
  let wasConnected = false;
  const remember = () => {
    // A strip is rebuilt when rows change and gone when the dialog closes; a
    // detached strip stops listening.
    if (!strip.isConnected) {
      if (wasConnected) document.removeEventListener("selectionchange", remember);
      return;
    }
    wasConnected = true;
    const now = read();
    if (now) pending = now;
    else if (window.getSelection()?.isCollapsed === false) pending = null; // selected elsewhere
  };
  strip.addEventListener("mouseup", () => setTimeout(remember, 0));
  strip.addEventListener("keyup", remember);
  document.addEventListener("selectionchange", remember);

  return {
    /** The current (or last) selection, consumed: it is cleared afterwards. */
    take() {
      const range = read() || pending;
      pending = null;
      if (range) window.getSelection().removeAllRanges();
      return range;
    },
  };
}

// A button that acts on a text selection must not take the selection away.
const keepsSelection = (node) => {
  node.addEventListener("mousedown", (e) => e.preventDefault());
  return node;
};

// One marked-up row: the line as selectable text, and a button per field.
function sampleCard(sample, fields, { onChange, onRemove }) {
  const labelOf = (key) => [...fields, IGNORE_BUTTON].find((f) => f.key === key).label;
  const strip = element("div", { className: "tg-strip", attrs: { tabindex: "0", "aria-label": `Line ${sample.index + 1}` } });
  const hint = element("span", { className: "field-hint", text: `Line ${sample.index + 1} — select characters, then say what they are.` });

  const selection = selectionTracker(strip, () => sample.line);

  const mark = (field) => {
    const range = selection.take();
    if (!range) {
      hint.textContent = `Select part of line ${sample.index + 1} first, then choose "${labelOf(field)}".`;
      return;
    }
    // A row has one of each field but may have several ignored runs.
    sample.spans = sample.spans.filter((s) => (field === IGNORE_FIELD || s.field !== field) && (s.end <= range.start || s.start >= range.end));
    sample.spans.push({ field, ...range });
    hint.textContent = `Line ${sample.index + 1} — marked "${sample.line.slice(range.start, range.end)}" as ${labelOf(field).toLowerCase()}.`;
    renderStrip(strip, sample);
    onChange();
  };

  const fieldButtons = [...fields, IGNORE_BUTTON].map((f) => {
    const node = button(f.label, { onClick: () => mark(f.key), title: f.title || `Mark the selected characters as ${f.label.toLowerCase()}` });
    node.prepend(element("span", { className: `tg-swatch tg-swatch-${f.key}` }));
    // Keep the text selection alive through the click.
    node.addEventListener("mousedown", (e) => e.preventDefault());
    return node;
  });

  renderStrip(strip, sample);
  return element("div", { className: "tg-sample" }, [
    element("div", { className: "tg-sample-head" }, [
      hint,
      button("Clear marks", { onClick: () => { sample.spans = []; renderStrip(strip, sample); onChange(); } }),
      button("Remove row", { onClick: onRemove }),
    ]),
    strip,
    element("div", { className: "tg-fields" }, fieldButtons),
  ]);
}

// The lines rows are marked up on: cleaned, once the cleanup step has run.
const rowLines = (state) => state.clean?.lines || state.lines;

function rowPanel(state, { region, fields, samplesKey, optionalKey, title, onChange }) {
  const wrap = element("div");
  const cards = element("div");
  const picker = element("select");
  const optionalBox = element("div", { className: "tg-optional" });
  const patternBox = element("textarea", { className: "tg-pattern", attrs: { readonly: "", rows: 3, "aria-label": `${title} pattern` } });
  const errorBox = element("p", { className: "tg-error", attrs: { "aria-live": "polite" } });
  const unmarkedBox = element("p", { className: "tg-summary", attrs: { "aria-live": "polite", style: "color: var(--warn)" } });

  const candidates = () => rowLines(state)
    .map((line, index) => ({ line, index }))
    .filter(({ line, index }) => state.roles[index] === region && !state.markers[index] && line.trim());

  function fillPicker() {
    const used = new Set(state[samplesKey].map((s) => s.index));
    picker.replaceChildren(...candidates().filter((c) => !used.has(c.index)).map((c) => (
      element("option", { text: `${c.index + 1}: ${truncate(shown(c.line))}`, attrs: { value: c.index } })
    )));
    picker.disabled = !picker.options.length;
    add.disabled = picker.disabled;
    if (picker.disabled) picker.append(element("option", { text: `Every ${title.toLowerCase()} row is already a sample` }));
  }

  function drawCards() {
    cards.replaceChildren(...state[samplesKey].map((sample) => sampleCard(sample, fields, {
      onChange: update,
      onRemove: () => { state[samplesKey] = state[samplesKey].filter((s) => s !== sample); drawCards(); update(); },
    })));
    if (!state[samplesKey].length) cards.append(element("p", { className: "empty-note", text: "No sample rows yet — add one below." }));
    fillPicker();
  }

  function update() {
    let spec = null;
    errorBox.textContent = "";
    try {
      spec = buildRowPattern(state[samplesKey], fields, { optional: state.optional[optionalKey] });
    } catch (e) {
      errorBox.textContent = e.message;
    }
    patternBox.value = spec ? spec.pattern : "";
    const loose = spec?.unmarked || [];
    unmarkedBox.textContent = loose.length
      ? `Not marked: ${loose.map((t) => `"${shown(t)}"`).join(", ")}. The pattern accepts anything there. Mark it as a field, or as Ignore if it is fixed text every row has.`
      : "";
    optionalBox.replaceChildren();
    if (spec) {
      for (const f of spec.fields) {
        const input = element("input", { attrs: { type: "checkbox" } });
        input.checked = f.optional;
        input.disabled = !f.alwaysPresent;
        input.addEventListener("change", () => {
          const set = new Set(state.optional[optionalKey]);
          if (input.checked) set.add(f.key); else set.delete(f.key);
          state.optional[optionalKey] = [...set];
          update();
        });
        const label = element("label", { className: "checkbox", attrs: { title: f.alwaysPresent ? "Every sample has this field; tick to accept rows without it." : `Only ${f.present} of ${f.samples} sample row(s) have this field, so it is optional.` } }, [
          input, element("span", { text: `${f.label} optional` }),
        ]);
        optionalBox.append(label);
      }
    }
    onChange();
  }

  const add = button("Add sample row", {
    onClick: () => {
      if (picker.disabled) return;
      const index = Number(picker.value);
      state[samplesKey].push({ index, line: rowLines(state)[index], spans: [] });
      state[samplesKey].sort((a, b) => a.index - b.index);
      drawCards();
      update();
    },
  });

  wrap.append(
    element("p", { className: "field-hint", text: `Mark up one or more ${title.toLowerCase()} rows. A field left out of some rows becomes optional; the delimiters and brackets around each field are taken from the rows as marked. Mark fixed text you don't want kept (a tag like "<u speaker=") as Ignore.` }),
    cards,
    element("div", { className: "tg-toolbar" }, [picker, add]),
    errorBox,
    element("h3", { className: "tg-section-title", text: "Generated pattern" }),
    patternBox,
    unmarkedBox,
    optionalBox,
  );
  drawCards();
  update();
  return wrap;
}

function headerPreview(state) {
  const re = new RegExp(HEADER_FIELD_PATTERN, "u");
  const table = dataTable(["Line", "Key", "Value"]);
  const unmatched = [];
  state.lines.forEach((line, i) => {
    if (state.roles[i] !== "header" || state.markers[i] || !line.trim()) return;
    const m = line.match(re);
    if (m) {
      table.body.append(element("tr", {}, [
        element("td", { text: String(i + 1) }), element("td", { text: m.groups.key.trim() }), element("td", { text: truncate(m.groups.value, 120) }),
      ]));
    } else unmatched.push(`${i + 1}: ${shown(line)}`);
  });
  return element("div", {}, [
    element("p", { className: "field-hint", text: "Header lines are read as \"Key: value\" — the keys are whatever the document uses. A header line with no colon is reported, not guessed at." }),
    table.node,
    unmatched.length ? element("h3", { className: "tg-section-title", text: `${unmatched.length} header line(s) that are not "Key: value"` }) : null,
    ...unmatched.map((u) => element("div", { className: "tg-unmatched", text: u })),
  ]);
}

// The whole grammar, re-run over the whole sample: what saving would give.
function testPanel(state, region) {
  const box = element("div", { attrs: { "aria-live": "polite" } });
  return {
    node: box,
    update() {
      let grammar;
      try { grammar = currentGrammar(state); }
      catch { box.replaceChildren(); return; }
      if (!grammar[region === "speakers" ? "speakerRow" : "turnRow"]) {
        box.replaceChildren(element("p", { className: "empty-note", text: "Mark up at least one row to see what the pattern parses." }));
        return;
      }
      const parsed = parseWithGrammar(state.lines, grammar);
      const unmatched = parsed.unmatched.filter((u) => u.region === region);
      // Rows that open with a turn number but don't match: kept, with no
      // speaker — list them alongside the lines that matched nothing.
      if (region === "main") {
        for (const t of parsed.turns.filter((turn) => turn.malformed)) {
          unmatched.push({ line: t.line, region, text: state.lines[t.line - 1], malformed: true });
        }
        unmatched.sort((a, b) => a.line - b.line);
      }
      const total = rowLines(state).filter((l, i) => state.roles[i] === region && !state.markers[i] && l.trim()).length;
      const items = region === "speakers" ? parsed.speakers : parsed.turns.filter((t) => !t.malformed);
      const columns = region === "speakers"
        ? ["line", ...SPEAKER_FIELDS.map((f) => f.key)]
        : ["line", "section", ...TURN_FIELDS.map((f) => f.key)];
      const labels = region === "speakers"
        ? ["Line", ...SPEAKER_FIELDS.map((f) => f.label)]
        : ["Line", "Section", ...TURN_FIELDS.map((f) => f.label)];
      const table = dataTable(labels);
      for (const item of items.slice(0, RENDER_CAP)) {
        table.body.append(element("tr", {}, columns.map((c) => element("td", { text: truncate(String(item[c] ?? ""), 80) }))));
      }
      const summary = element("p", { className: "tg-summary" }, [
        element("span", { className: unmatched.length ? "warn" : "ok", text: `${items.length} row(s) parsed` }),
        document.createTextNode(` from ${total} line(s) marked ${ROLE_LABELS[region]}`),
        region === "main" && parsed.continuations.length ? document.createTextNode(` · ${parsed.continuations.length} line(s) folded into the row above as continuations`) : null,
        unmatched.length ? element("span", { className: "warn", text: ` · ${unmatched.length} not matched` }) : null,
        items.length > RENDER_CAP ? document.createTextNode(` · first ${RENDER_CAP} shown`) : null,
      ].filter(Boolean));
      box.replaceChildren(...[
        element("h3", { className: "tg-section-title", text: "What this parses in the sample" }),
        summary,
        ...unmatched.slice(0, 50).map((u) => element("div", { className: "tg-unmatched", text: `${u.line}: ${shown(u.text)}${u.malformed ? "   (kept as a row with no speaker)" : ""}` })),
        region === "main" && parsed.continuations.length
          ? element("details", {}, [
            element("summary", { className: "field-hint", text: "Continuation lines" }),
            ...parsed.continuations.slice(0, 50).map((c) => element("div", { className: "tg-unmatched", text: `${c.line} → ${c.into}: ${shown(c.text)}`, attrs: { style: "color: var(--muted)" } })),
          ])
          : null,
        table.node,
      ].filter(Boolean));
    },
  };
}

function currentGrammar(state) {
  return buildGrammar({
    name: state.name,
    lines: state.lines,
    roles: state.roles,
    markers: state.markers,
    speakerSamples: state.speakerSamples,
    turnSamples: state.turnSamples,
    optional: state.optional,
    cleanup: state.cleanup,
  });
}

async function rowStep(state, { openModal, existing, error }) {
  const seed = state.base || DEFAULT_GRAMMAR;
  if (!state.speakerSamples) {
    state.speakerSamples = suggestSamples(rowLines(state), state.roles, state.markers, "speakers", seed.speakerRow);
  }
  if (!state.turnSamples) {
    state.turnSamples = suggestSamples(rowLines(state), state.roles, state.markers, "main", seed.turnRow);
  }

  const tabs = [
    { key: "header", label: "Header metadata" },
    { key: "speakers", label: "Speaker info (optional)" },
    { key: "main", label: "Main" },
  ];
  const bar = element("div", { className: "tab-bar", attrs: { role: "tablist" } });
  const panes = {};
  const speakerTest = testPanel(state, "speakers");
  const turnTest = testPanel(state, "main");
  panes.header = headerPreview(state);
  const hasSpeakerLines = state.roles.some((role, i) => role === "speakers" && !state.markers[i] && rowLines(state)[i].trim());
  panes.speakers = element("div", {}, [
    hasSpeakerLines ? null : element("p", { className: "field-hint", text: "No lines are marked Speaker info, and that's fine: a speaker block is optional, like the header. Without one, the speakers are whoever the Main rows name. Documents parsed with this grammar may also leave the block out." }),
    rowPanel(state, { region: "speakers", fields: SPEAKER_FIELDS, samplesKey: "speakerSamples", optionalKey: "speakerRow", title: "Speaker", onChange: () => speakerTest.update() }),
    speakerTest.node,
  ]);
  panes.main = element("div", {}, [
    rowPanel(state, { region: "main", fields: TURN_FIELDS, samplesKey: "turnSamples", optionalKey: "turnRow", title: "Content", onChange: () => turnTest.update() }),
    turnTest.node,
  ]);
  const tabButtons = tabs.map((tab) => {
    const node = element("button", { className: "tab", text: tab.label, attrs: { type: "button", role: "tab", "aria-selected": "false" } });
    node.addEventListener("click", () => select(tab.key));
    bar.append(node);
    return node;
  });
  function select(key) {
    state.rowTab = key;
    tabs.forEach((tab, i) => {
      tabButtons[i].setAttribute("aria-selected", String(tab.key === key));
      panes[tab.key].hidden = tab.key !== key;
    });
  }

  const target = `_config/transcript-grammar/${state.name}.json`;
  const result = await openModal({
    title: "Transcript grammar — 4 of 4: rows",
    modalClassName: MODAL_CLASS,
    onMount(body) {
      ensureStyle();
      if (error) body.append(element("p", { className: "tg-error", text: error }));
      body.append(bar, panes.header, panes.speakers, panes.main,
        element("p", { className: "field-hint", attrs: { style: "margin-top:12px" }, text: existing.includes(state.name) ? `Saving replaces ${target}.` : `Saving writes ${target}.` }));
      speakerTest.update();
      turnTest.update();
      select(state.rowTab || "speakers");
    },
    actions: [
      { label: "Cancel", value: null },
      { label: "Back", value: () => ({ nav: "back" }) },
      { label: "Save grammar", primary: true, value: () => ({ nav: "save" }) },
    ],
  });
  if (!result || result.nav !== "save") return result;

  let grammar;
  try { grammar = currentGrammar(state); }
  catch (e) { return { nav: "stay", error: e.message }; }
  if (!grammar.turnRow) return { nav: "stay", error: "Mark up at least one content row (Main tab)." };
  if (!grammar.turnRow.fields.some((f) => f.key === "text")) {
    return { nav: "stay", error: "No content row has its text marked (Main tab) — mark the text before saving." };
  }
  // Speaker rows are optional (a format may name the speaker on every row),
  // but a speaker row that is marked up has to say who the speaker is.
  if (grammar.speakerRow && !grammar.speakerRow.fields.some((f) => f.key === "code" || f.key === "id")) {
    return { nav: "stay", error: "The speaker rows have no code or ID marked (Speaker info tab) — mark one, or remove those rows if this format has no speaker list." };
  }
  return { nav: "save", grammar };
}

/**
 * Run the editor. Resolves with the grammar to save, or null if the person
 * cancelled at any step.
 */
export async function openGrammarEditor({ openModal, grammars, loadGrammar, readDocument }) {
  const state = { name: "default", sourceName: "", lines: null, optional: { speakerRow: [], turnRow: [] } };
  const steps = [sourceStep, regionStep, cleanupStep, rowStep];
  let step = 0;
  let error = null;
  for (;;) {
    const result = await steps[step](state, { openModal, grammars, existing: grammars, loadGrammar, readDocument, error });
    if (!result) return null;
    error = result.error || null;
    if (result.nav === "save") return { grammar: result.grammar, sourceName: state.sourceName };
    if (result.nav === "next") step = Math.min(step + 1, steps.length - 1);
    if (result.nav === "back") step = Math.max(step - 1, 0);
  }
}

// ---------------------------------------------------------------------------
// Tester — a saved grammar against another document
// ---------------------------------------------------------------------------

export async function openGrammarTester({ openModal, grammars, loadGrammar, readDocument, log }) {
  const grammarSelect = element("select");
  for (const name of grammars) grammarSelect.append(element("option", { text: name, attrs: { value: name } }));
  const fileInput = element("input", { attrs: { type: "file", accept: ".txt,.text,.md,.csv,.tsv,.docx,text/plain" } });
  const textarea = element("textarea", { className: "mono", attrs: { rows: 6, spellcheck: "false", placeholder: "…or paste a transcript here." } });
  const output = element("div", { attrs: { "aria-live": "polite" } });

  const run = async () => {
    output.replaceChildren(element("p", { className: "field-hint", text: "Parsing…" }));
    try {
      const grammar = await loadGrammar(grammarSelect.value);
      const file = fileInput.files?.[0];
      const lines = file && !textarea.value.trim() ? await readDocument(file) : textToLines(textarea.value);
      const source = file && !textarea.value.trim() ? file.name : "pasted text";
      const parsed = parseWithGrammar(lines, grammar);
      output.replaceChildren(...renderParse(parsed));
      log?.(`transcript-grammar: ${grammarSelect.value} on ${source} — ${Object.keys(parsed.metadata).length} header field(s), ${parsed.speakers.length} speaker(s), ${parsed.turns.filter((t) => !t.malformed).length} turn(s), ${parsed.unmatched.length + parsed.turns.filter((t) => t.malformed).length} line(s) not matched.`, parsed.unmatched.length || parsed.turns.some((t) => t.malformed) ? "warn" : "ok");
    } catch (e) {
      output.replaceChildren(element("p", { className: "tg-error", text: e.message }));
    }
  };

  await openModal({
    title: "Test a transcript grammar",
    modalClassName: MODAL_CLASS,
    onMount(body) {
      ensureStyle();
      body.append(
        field("Grammar", grammarSelect),
        element("label", { className: "field" }, [element("span", { className: "field-label", text: "Document (.txt, .docx)" }), fileInput]),
        field("Or paste text", textarea),
        element("div", { className: "actions" }, [button("Parse", { primary: true, onClick: run })]),
        output,
      );
    },
    actions: [{ label: "Close", value: null }],
  });
}

function renderParse(parsed) {
  const nodes = [];
  const malformed = parsed.turns.filter((t) => t.malformed);
  const problems = [...parsed.unmatched, ...malformed.map((t) => ({ ...t, region: "main", malformed: true }))].sort((a, b) => a.line - b.line);
  const summary = `${Object.keys(parsed.metadata).length} header field(s) · ${parsed.speakers.length} speaker(s) · ${parsed.turns.length - malformed.length} turn(s) in ${parsed.sections.length || "no"} section(s) · ${parsed.continuations.length} continuation line(s) · ${parsed.ignored.length} ignored · ${parsed.unmatched.length} unmatched · ${malformed.length} malformed row(s)`;
  nodes.push(element("p", { className: "tg-summary" }, [element("span", { className: problems.length ? "warn" : "ok", text: summary })]));
  for (const u of problems.slice(0, 100)) {
    const text = u.malformed ? `${u.turn}… ${u.text}   (row with no speaker)` : shown(u.text);
    nodes.push(element("div", { className: "tg-unmatched", text: `${u.line} (${ROLE_LABELS[u.region]}): ${text}` }));
  }
  const meta = dataTable(["Key", "Value"]);
  for (const [k, v] of Object.entries(parsed.metadata)) meta.body.append(element("tr", {}, [element("td", { text: k }), element("td", { text: truncate(v, 120) })]));
  const speakers = dataTable(["Line", ...SPEAKER_FIELDS.map((f) => f.label)]);
  for (const s of parsed.speakers) speakers.body.append(element("tr", {}, ["line", ...SPEAKER_FIELDS.map((f) => f.key)].map((k) => element("td", { text: String(s[k] ?? "") }))));
  const turns = dataTable(["Line", "Section", ...TURN_FIELDS.map((f) => f.label)]);
  for (const t of parsed.turns.slice(0, RENDER_CAP)) turns.body.append(element("tr", {}, ["line", "section", ...TURN_FIELDS.map((f) => f.key)].map((k) => element("td", { text: truncate(String(t[k] ?? ""), 80) }))));
  nodes.push(
    element("h3", { className: "tg-section-title", text: "Header metadata" }), meta.node,
    element("h3", { className: "tg-section-title", text: "Speakers" }), speakers.node,
    element("h3", { className: "tg-section-title", text: parsed.turns.length > RENDER_CAP ? `Turns (first ${RENDER_CAP})` : "Turns" }), turns.node,
  );
  return nodes;
}
