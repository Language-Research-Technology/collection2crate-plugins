// The transcript grammar, derived from markup rather than written by hand.
//
// A person marks up one sample document in the editor (ui.js): which lines are
// the header metadata, the speaker info and the main body, and — within
// individual rows — which characters are a speaker's code, name, alternate
// name, affiliation and id, or a turn's number, speaker and text. This module
// turns that markup into regular expressions, and parses other documents
// with them.
//
// Everything here is pure: no DOM, no file handles. The editor is the only
// thing that knows about a folder, which is what makes the generation and the
// parser testable in Node (transcript-grammar.test.mjs).
//
// What a generated grammar deliberately does NOT carry is the sample text it
// came from. The rows a person marks up are real speaker declarations — names,
// affiliations, ids — and a config file is the kind of thing that gets copied
// between collections and committed to repositories. Only the shape survives:
// the delimiters, the brackets, which fields are optional.

export const GRAMMAR_VERSION = 1;

export const REGIONS = [
  { key: "header", label: "Header metadata" },
  { key: "speakers", label: "Speaker info" },
  { key: "main", label: "Main" },
];

// Not a region of the document, but a role a line can be given: a line the
// parser should step over wherever it appears ("END OF TRANSCRIPT").
export const IGNORE = "ignore";

export const SPEAKER_FIELDS = [
  { key: "code", label: "Code", kind: "code" },
  { key: "name", label: "Name", kind: "text" },
  { key: "alternateName", label: "Alternate name", kind: "text" },
  { key: "affiliation", label: "Affiliation", kind: "text" },
  { key: "id", label: "ID", kind: "id" },
];

export const TURN_FIELDS = [
  { key: "turn", label: "Turn number", kind: "number" },
  { key: "speaker", label: "Speaker", kind: "code" },
  { key: "text", label: "Text", kind: "rest" },
];

// Same bound as ca-data-prep's CODE: short, no whitespace, no colon — the
// length limit is what stops an ordinary word from passing as a code.
const VALUE_PATTERNS = {
  number: "\\d+",
  code: "[\\p{L}\\p{N}][\\p{L}\\p{N}_.'\\-]{0,23}",
};

// Punctuation that hugs a field rather than separating two of them: the
// brackets round "[alternate name]", the "#" of "#id", the period of "12.".
// Everything else in the gap between two fields is the separator.
const CLOSERS = new Set([")", "]", "}", ">", "."]);
const OPENERS = new Set(["(", "[", "{", "<", "#", "@"]);

const WS = "[\\t ]";

// Escaping for the `u` flag, where an unnecessary escape is a syntax error:
// only the syntax characters may be escaped outside a class.
export function escapeRegex(text) {
  return String(text).replace(/[\^$\\.*+?()[\]{}|/]/g, "\\$&");
}

function escapeClassChar(char) {
  return /[\\\]\[^-]/.test(char) ? `\\${char}` : char;
}

/** A pattern matching a line equal to `line`, give or take whitespace. */
export function literalLinePattern(line) {
  const trimmed = String(line || "").trim();
  const body = trimmed.split(/\s+/).map(escapeRegex).join("\\s+");
  return `^\\s*${body}\\s*$`;
}

/**
 * A pattern for a line to step over. Like literalLinePattern, except that
 * every run of digits matches any digits: a timestamp line marked Ignore
 * ("05:36-05:37") then covers every timestamp, not just that one.
 */
export function ignoreLinePattern(line) {
  const trimmed = String(line || "").trim();
  const body = trimmed.split(/\s+/)
    .map((word) => word.split(/(\d+)/).map((part) => (/^\d+$/.test(part) ? "\\d+" : escapeRegex(part))).join(""))
    .join("\\s+");
  return `^\\s*${body}\\s*$`;
}

/**
 * Split a document into the lines the editor shows and the parser reads.
 *
 * A .docx arrives as mammoth's raw text, where "\n\n" ends a paragraph and a
 * lone "\n" is a soft break inside one; those paragraphs are the lines a
 * transcriber sees, so that is what they become here. Plain text is split on
 * its own line breaks.
 */
export function textToLines(text, { paragraphs = false } = {}) {
  const normalized = String(text || "").replace(/\r\n?/g, "\n").replace(/\u00A0/g, " ");
  if (!paragraphs) return normalized.split("\n");
  const lines = normalized.split("\n\n").map((paragraph) => paragraph.replace(/\n/g, " "));
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

// ---------------------------------------------------------------------------
// Regions
// ---------------------------------------------------------------------------

/**
 * Turn per-line region markup into the region part of a grammar.
 *
 * `roles[i]` is "header" | "speakers" | "main" | "ignore" | null (unassigned),
 * and `markers[i]` says line i is structure rather than content: the
 * "Speakers:" heading that opens the speaker info, or a section name such as
 * "PRELIMINARIES" inside the main body.
 *
 * A region's first marker is what the parser looks for to know the region has
 * started. A region with no marker starts at its first row — the parser then
 * falls back to the row patterns to find the boundary.
 */
export function buildRegions(lines, roles, markers = []) {
  const regions = { header: {}, speakers: { start: null }, main: { start: null, sections: [] } };
  const ignore = [];
  const headerKeys = [];
  const seen = new Set();

  lines.forEach((line, index) => {
    const role = roles[index];
    const trimmed = String(line || "").trim();
    if (!trimmed || !role) return;
    if (role === IGNORE) {
      const pattern = ignoreLinePattern(trimmed);
      if (!seen.has(pattern)) { seen.add(pattern); ignore.push(pattern); }
      return;
    }
    if (markers[index]) {
      if ((role === "speakers" || role === "main") && !regions[role].start) {
        regions[role].start = literalLinePattern(trimmed);
      }
      if (role === "main" && !regions.main.sections.includes(trimmed)) regions.main.sections.push(trimmed);
      return;
    }
    if (role === "header") {
      const match = trimmed.match(new RegExp(HEADER_FIELD_PATTERN, "u"));
      if (match && !headerKeys.includes(match.groups.key)) headerKeys.push(match.groups.key);
    }
  });

  regions.main.sectionPattern = regions.main.sections.length
    ? `^\\s*(?:${regions.main.sections.map(escapeRegex).join("|")})\\s*$`
    : null;
  regions.header.keys = headerKeys;
  return { regions, ignore };
}

/** Problems with region markup that would make the parser misread a document. */
export function checkRegionOrder(roles) {
  const order = ["header", "speakers", "main"];
  const problems = [];
  let furthest = -1;
  let reported = false;
  const present = new Set();
  roles.forEach((role, index) => {
    const rank = order.indexOf(role);
    if (rank < 0) return;
    present.add(role);
    if (rank < furthest && !reported) {
      reported = true;
      problems.push(`Line ${index + 1} is marked ${regionLabel(role)} but comes after ${regionLabel(order[furthest])} — regions are read in order: header metadata, speaker info, main.`);
    }
    furthest = Math.max(furthest, rank);
  });
  // Speaker info is optional: some formats name the speaker on every row
  // ("<u speaker=X>") and declare nobody up front.
  if (!present.has("main")) problems.push(`No lines are marked ${regionLabel("main")}.`);
  return problems;
}

const regionLabel = (key) => REGIONS.find((r) => r.key === key)?.label || key;

// A header line is "Key: value". Nothing more is asked of it — the keys vary
// from project to project, and the ones the sample had are recorded
// alongside for reference.
export const HEADER_FIELD_PATTERN = "^[\\t ]*(?<key>[^:\\t]{1,60}?)[\\t ]*:[\\t ]*(?<value>.*?)[\\t ]*$";

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

// A span marked "ignore" is fixed text between fields — an XML-ish tag, a
// label, a timestamp — that every row has but nobody wants kept. It is matched
// as written (except that digits match any digits) and never captured. Inside a gap it is carried between these two private-use
// sentinels, which none of the punctuation rules below recognise, so a marked
// ">" stays literal instead of being read as a bracket.
export const IGNORE_FIELD = "ignore";
const LIT_OPEN = "\uE000";
const LIT_CLOSE = "\uE001";
const LIT_RUN = /(\uE000[^\uE001]*\uE001)/u;

/**
 * Read one marked-up sample into its fields and the gaps between them.
 *
 * A sample is `{ line, spans: [{ field, start, end }] }`, with `start`/`end`
 * character offsets into `line`. Spans whose field is `ignore` are not fields;
 * they are folded into the gap they sit in, as literal text.
 */
export function decomposeSample(sample) {
  const line = String(sample.line || "");
  const all = [...(sample.spans || [])]
    .filter((s) => s && s.end > s.start)
    .sort((a, b) => a.start - b.start);
  for (let i = 1; i < all.length; i++) {
    if (all[i].start < all[i - 1].end) throw new Error(`"${all[i - 1].field}" and "${all[i].field}" overlap.`);
  }
  const ignored = all.filter((s) => s.field === IGNORE_FIELD);
  const spans = all.filter((s) => s.field !== IGNORE_FIELD);
  const gap = (from, to) => {
    let out = "";
    for (const s of ignored) {
      if (s.end <= from || s.start >= to) continue;
      out += line.slice(from, s.start) + LIT_OPEN + line.slice(s.start, s.end) + LIT_CLOSE;
      from = s.end;
    }
    return out + line.slice(from, to);
  };
  const fields = spans.map((span, i) => ({
    key: span.field,
    value: line.slice(span.start, span.end),
    before: gap(i === 0 ? 0 : spans[i - 1].end, span.start),
  }));
  const tail = spans.length ? gap(spans[spans.length - 1].end, line.length) : gap(0, line.length);
  return { fields, tail };
}

// "] (" → closers "]", middle " ", openers "(".
function splitGap(gap, { leading = false, trailing = false } = {}) {
  let i = 0;
  if (!leading) while (i < gap.length && CLOSERS.has(gap[i])) i++;
  let j = gap.length;
  if (!trailing) while (j > i && OPENERS.has(gap[j - 1])) j--;
  return { closers: gap.slice(0, i), middle: gap.slice(i, j), openers: gap.slice(j) };
}

// Letters or digits in a gap are content nobody marked, not delimiters. They
// must not become literal text in the pattern — that would make the pattern
// match only rows with those very words — so they generalise to "anything".
const WORDY = /[\p{L}\p{N}]/u;

function literalPattern(text) {
  const lead = /^[\t ]/.test(text) ? `${WS}*` : "";
  const trail = /[\t ]$/.test(text) ? `${WS}*` : "";
  const core = text.trim();
  // Digits stand for any digits, so an ignored "[05:36]" covers every time.
  const word = (w) => w.split(/(\d+)/).map((part) => (/^\d+$/.test(part) ? "\\d+" : escapeRegex(part))).join("");
  return core ? `${lead}${core.split(/[\t ]+/).map(word).join(`${WS}+`)}${trail}` : `${WS}*`;
}

function generalisePlain(middle, { wild = ".+?" } = {}) {
  if (middle === "") return "";
  if (WORDY.test(middle)) return wild;
  // A tab is kept as a tab: it is what tells a turn-number column from prose
  // that happens to open with a numeral (see ca-data-prep's grammar notes).
  if (/^[\t ]+$/.test(middle)) return middle.includes("\t") ? "[ ]*\\t[\\t ]*" : `${WS}+`;
  const core = middle.trim();
  return `${WS}*${core.split(/[\t ]+/).map(escapeRegex).join(`${WS}*`)}${WS}*`;
}

// A gap may mix ignored (literal) runs with plain delimiters.
function generaliseGap(text, options) {
  const parts = text.split(LIT_RUN).filter(Boolean);
  return parts.map((part, i) => {
    if (part.startsWith(LIT_OPEN)) return literalPattern(part.slice(1, -1));
    // Space beside fixed text is a matter of taste, not structure: "<u a=B>hi"
    // and "<u a=B> hi" are the same row.
    const besideLiteral = parts.length > 1 && /^[\t ]+$/.test(part);
    return besideLiteral ? `${WS}*` : generalisePlain(part, options);
  }).join("");
}

const generaliseSeparator = (middle) => generaliseGap(middle);

// One pattern for a set of observed variants, optional when "" is one of them.
function alternatives(values, render) {
  const distinct = [...new Set(values.map(render))];
  const hasEmpty = distinct.includes("");
  const nonEmpty = distinct.filter((v) => v !== "");
  if (!nonEmpty.length) return "";
  // "[\t ]+" or nothing is just "[\t ]*".
  if (hasEmpty && nonEmpty.length === 1 && nonEmpty[0] === `${WS}+`) return `${WS}*`;
  const body = nonEmpty.length === 1 ? nonEmpty[0] : `(?:${nonEmpty.join("|")})`;
  if (!hasEmpty) return body;
  if (nonEmpty.length === 1 && /^(?:\\.|[^\\])$/.test(body)) return `${body}?`;
  return nonEmpty.length > 1 ? `${body}?` : `(?:${body})?`;
}

// Fields in the order the samples give them, merged: a field only some
// samples have is slotted in after the field it follows where it does appear.
function mergeFieldOrder(decomposed) {
  const order = [];
  for (const sample of decomposed) {
    const keys = sample.fields.map((f) => f.key);
    const shared = keys.filter((k) => order.includes(k));
    const expected = order.filter((k) => shared.includes(k));
    if (shared.join("|") !== expected.join("|")) {
      throw new Error(`The samples put their fields in different orders (${expected.join(", ")} vs ${shared.join(", ")}).`);
    }
    keys.forEach((key, i) => {
      if (order.includes(key)) return;
      const previous = keys.slice(0, i).reverse().find((k) => order.includes(k));
      order.splice(previous ? order.indexOf(previous) + 1 : 0, 0, key);
    });
  }
  return order;
}

/**
 * Generate a row pattern from marked-up samples.
 *
 * Returns `{ pattern, flags, fields }`, where `fields` records, per field, what
 * was observed — present in how many samples, the brackets round it, and
 * whether the pattern treats it as optional. `options.optional` forces a field
 * optional even when every sample had it.
 */
export function buildRowPattern(samples, fieldDefs, options = {}) {
  const forcedOptional = new Set(options.optional || []);
  const usable = (samples || []).filter((s) => s && (s.spans || []).some((span) => span.end > span.start && span.field !== IGNORE_FIELD));
  if (!usable.length) return null;

  const decomposed = usable.map(decomposeSample);
  const known = new Set(fieldDefs.map((f) => f.key));
  for (const sample of decomposed) {
    const keys = sample.fields.map((f) => f.key);
    const unknown = keys.find((k) => !known.has(k));
    if (unknown) throw new Error(`"${unknown}" is not a field of this row.`);
    const dupe = keys.find((k, i) => keys.indexOf(k) !== i);
    if (dupe) throw new Error(`"${dupe}" is marked twice in one sample.`);
  }
  const order = mergeFieldOrder(decomposed);

  // Per field, per sample: the punctuation hugging it and the gaps either side.
  const stats = new Map(order.map((key) => [key, { present: 0, prefix: [], suffix: [], sepBefore: [], sepAfter: [] }]));
  const tails = [];
  const unmarked = new Set();
  const leads = [];
  for (const sample of decomposed) {
    // Reported from the first letter or digit: the delimiters before it are
    // not what the person needs to go and mark.
    const words = (gap) => {
      const plain = gap.split(LIT_RUN).filter((p) => !p.startsWith(LIT_OPEN) && WORDY.test(p));
      return plain.map((p) => p.slice(p.search(WORDY)).trim()).filter(Boolean);
    };
    for (const f of sample.fields) words(f.before).forEach((w) => unmarked.add(w));
    words(sample.tail).forEach((w) => unmarked.add(w));
    if (sample.fields.length) leads.push(splitGap(sample.fields[0].before, { leading: true }).middle);
    const n = sample.fields.length;
    const gaps = sample.fields.map((f, i) => splitGap(f.before, { leading: i === 0 }));
    const tailGap = splitGap(sample.tail, { trailing: true });
    sample.fields.forEach((field, i) => {
      const s = stats.get(field.key);
      s.present++;
      s.prefix.push(gaps[i].openers);
      s.suffix.push(i + 1 < n ? gaps[i + 1].closers : tailGap.closers);
      if (i > 0) s.sepBefore.push(gaps[i].middle);
      if (i + 1 < n) s.sepAfter.push(gaps[i + 1].middle);
    });
    tails.push(tailGap.middle);
  }

  const fieldInfo = order.map((key) => {
    const s = stats.get(key);
    const def = fieldDefs.find((f) => f.key === key);
    const optional = s.present < decomposed.length || forcedOptional.has(key);
    return {
      key,
      label: def.label,
      kind: def.kind,
      present: s.present,
      samples: decomposed.length,
      optional,
      alwaysPresent: s.present === decomposed.length,
      prefix: alternatives(s.prefix, escapeRegex),
      suffix: alternatives(s.suffix, escapeRegex),
      prefixChars: [...new Set(s.prefix.map((p) => p[0]).filter(Boolean))],
      suffixChars: [...new Set(s.suffix.map((p) => p[0]).filter(Boolean))],
      sepBefore: alternatives(s.sepBefore, generaliseSeparator),
      sepAfter: alternatives(s.sepAfter, generaliseSeparator),
    };
  });

  // After a closing bracket the boundary is already plain, so the space before
  // the next field need not be there: "[x] (y)" and "[x](y)" read the same.
  fieldInfo.forEach((info, index) => {
    const before = fieldInfo[index - 1];
    const closed = before && before.suffix && !before.suffix.startsWith("\\.");
    if (closed && info.sepBefore === `${WS}+`) info.sepBefore = `${WS}*`;
  });

  const valuePattern = (info, index) => {
    if (VALUE_PATTERNS[info.kind]) return VALUE_PATTERNS[info.kind];
    const last = index === fieldInfo.length - 1;
    if (info.kind === "rest") return last ? ".*?" : ".+?";
    // A bracketed field runs to its closing bracket. Anything else runs up to
    // the opening punctuation of whatever can follow it.
    const stops = info.suffixChars.some((c) => c !== ".")
      ? info.suffixChars.filter((c) => c !== ".")
      : fieldInfo.slice(index + 1).flatMap((f) => f.prefixChars);
    if (info.kind === "id") stops.push(" ", "\\t");
    const unique = [...new Set(stops)];
    const cls = unique.map((c) => (c === "\\t" ? c : escapeClassChar(c))).join("");
    return cls ? `[^${cls}]+?` : ".+?";
  };

  // Before the first field: ignored text is required as written, unmarked words
  // match anything, and plain whitespace or punctuation is left to the
  // leading-space allowance (as it always was).
  const renderLead = (lead) => (lead.includes(LIT_OPEN) || WORDY.test(lead) ? generaliseGap(lead, { wild: ".*?" }) : "");
  let pattern = `^${WS}*${alternatives(leads, renderLead)}`;
  let requiredSeen = false;
  fieldInfo.forEach((info, index) => {
    const core = `${info.prefix}(?<${info.key}>${valuePattern(info, index)})${info.suffix}`;
    if (!info.optional) {
      pattern += (requiredSeen ? info.sepBefore : "") + core;
      requiredSeen = true;
    } else if (requiredSeen) {
      pattern += `(?:${info.sepBefore}${core})?`;
    } else {
      // An optional field ahead of every required one carries the gap after
      // it, so a row without it doesn't have to start with a separator.
      pattern += `(?:${core}${info.sepAfter})?`;
    }
  });
  // Whatever trails the last field is never required: stray punctuation after
  // an #id is a slip in one row, not part of the shape of every row.
  // After the last field: ignored text is required as written; otherwise the
  // tail is tolerated, never required (stray punctuation after an #id is a slip
  // in one row), and unmarked words match anything.
  const renderTail = (t) => (t.includes(LIT_OPEN) ? generaliseGap(t, { wild: ".*" }) : WORDY.test(t) ? ".*" : escapeRegex(t.trim()));
  const tail = tails.some((t) => t.includes(LIT_OPEN))
    ? alternatives(tails, renderTail)
    : tails.some((t) => WORDY.test(t)) ? ".*" : alternatives([...tails.map((t) => t.trim()), ""], escapeRegex);
  pattern += `${WS}*${tail}${tail ? `${WS}*` : ""}$`;

  // A row that opens with a turn number is recognisable by that alone, even
  // when the rest of it is malformed. The parser uses this to report such a
  // line instead of folding it into the row above as a wrapped continuation.
  const first = fieldInfo[0];
  // Optional or not, and whether or not the samples had a period after it.
  const rowStart = first && first.kind === "number" && fieldInfo.length > 1 && first.sepAfter
    ? `^${WS}*${first.prefix}${VALUE_PATTERNS.number}${first.suffix.startsWith("\\.") ? "" : "\\.?"}${first.suffix}${first.sepAfter}`
    : null;

  return {
    pattern,
    flags: "u",
    rowStart,
    // Sample text that fell outside every field. The editor shows it as a
    // prompt to mark it; buildGrammar drops it, so it is never saved.
    unmarked: [...unmarked].filter(Boolean),
    fields: fieldInfo.map(({ key, label, present, samples: count, optional, alwaysPresent }) => (
      { key, label, present, samples: count, optional, alwaysPresent }
    )),
  };
}

// ---------------------------------------------------------------------------
// The grammar as a whole
// ---------------------------------------------------------------------------

/** Assemble everything the editor produced into the saved config shape. */
export function buildGrammar({ name, lines, roles, markers, speakerSamples, turnSamples, optional = {}, cleanup = null }) {
  const { regions, ignore: markedIgnore } = buildRegions(lines, roles, markers);
  // The cleanup step's rules, when there is one, replace the ignore patterns
  // derived from lines marked Ignore (it starts from those, and may edit them).
  const ignore = cleanup ? [...new Set(cleanup.drop.map((p) => p.trim()).filter(Boolean))] : markedIgnore;
  const strip = cleanup ? cleanup.strip.map((p) => p.trim()).filter(Boolean).map((pattern) => ({ pattern, flags: "u" })) : [];
  const speakerRow = buildRowPattern(speakerSamples, SPEAKER_FIELDS, { optional: optional.speakerRow });
  const turnRow = buildRowPattern(turnSamples, TURN_FIELDS, { optional: optional.turnRow });
  return {
    version: GRAMMAR_VERSION,
    name: name || "default",
    regions,
    ignore,
    strip,
    headerField: { pattern: HEADER_FIELD_PATTERN, flags: "u" },
    speakerRow: withoutSampleText(speakerRow),
    turnRow: withoutSampleText(turnRow),
  };
}

function withoutSampleText(spec) {
  if (!spec) return spec;
  const { unmarked, ...kept } = spec;
  return kept;
}

/** Check a loaded config before trusting it. Returns a list of problems. */
export function validateGrammar(grammar) {
  const problems = [];
  if (!grammar || typeof grammar !== "object") return ["not a grammar object"];
  if (grammar.version !== GRAMMAR_VERSION) problems.push(`unsupported version ${grammar.version}`);
  const tryCompile = (label, pattern, flags = "u") => {
    if (pattern == null) return;
    try { new RegExp(pattern, flags); } catch (e) { problems.push(`${label}: ${e.message}`); }
  };
  if (!grammar.turnRow?.pattern) problems.push("no turn row pattern");
  tryCompile("speakerRow", grammar.speakerRow?.pattern, grammar.speakerRow?.flags);
  tryCompile("turnRow", grammar.turnRow?.pattern, grammar.turnRow?.flags);
  tryCompile("headerField", grammar.headerField?.pattern, grammar.headerField?.flags);
  tryCompile("regions.speakers.start", grammar.regions?.speakers?.start);
  tryCompile("regions.main.start", grammar.regions?.main?.start);
  tryCompile("regions.main.sectionPattern", grammar.regions?.main?.sectionPattern);
  (grammar.ignore || []).forEach((p, i) => tryCompile(`ignore[${i}]`, p));
  (grammar.strip || []).forEach((s, i) => tryCompile(`strip[${i}]`, s?.pattern, s?.flags));
  return problems;
}

function compile(grammar) {
  const re = (spec) => (spec?.pattern ? new RegExp(spec.pattern, spec.flags || "u") : null);
  const plain = (pattern) => (pattern ? new RegExp(pattern, "u") : null);
  return {
    speakerRow: re(grammar.speakerRow),
    turnRow: re(grammar.turnRow),
    turnRowStart: grammar.turnRow?.rowStart ? new RegExp(grammar.turnRow.rowStart, "u") : null,
    headerField: re(grammar.headerField) || new RegExp(HEADER_FIELD_PATTERN, "u"),
    speakersStart: plain(grammar.regions?.speakers?.start),
    mainStart: plain(grammar.regions?.main?.start),
    section: plain(grammar.regions?.main?.sectionPattern),
    ignore: (grammar.ignore || []).map(plain),
    strip: compileStrip(grammar.strip),
  };
}

const cleanGroups = (groups) => Object.fromEntries(
  Object.entries(groups || {}).map(([k, v]) => [k, v == null ? "" : v.trim()]),
);

/**
 * Parse a document with a grammar.
 *
 * `input` is either the document's text or an array of lines (textToLines).
 * Every non-blank line is accounted for in the result: as a metadata field, a
 * speaker, a turn, a section marker, an ignored line, a continuation folded
 * into the turn above it, or — when nothing fits — in `unmatched`, with the
 * region it was in. A line that opens like a row (a turn number) but doesn't
 * match is a turn with `malformed: true` and no speaker, not an unmatched line. Line numbers are 1-based positions in the lines array.
 */
export function parseWithGrammar(input, grammar) {
  const lines = Array.isArray(input) ? input : textToLines(input);
  const re = compile(grammar);
  const result = {
    metadata: {}, speakers: [], turns: [], sections: [], ignored: [], continuations: [], unmatched: [],
    roles: new Array(lines.length).fill(null),
  };

  let region = "header";
  let section = "";
  // The row a wrapped line would continue. Cleared by a section marker and by
  // a row-shaped line that failed to parse: a line after either belongs to
  // neither the turn before the marker nor the turn before the broken row.
  let openTurn = null;
  const note = (index, role) => { result.roles[index] = role; };
  const headerKeys = new Set(grammar.regions?.header?.keys || []);
  const isKnownHeaderLine = (line) => {
    const m = line.match(re.headerField);
    return !!m && headerKeys.has(m.groups.key.trim());
  };

  lines.forEach((raw, index) => {
    const line = String(raw ?? "");
    const lineNumber = index + 1;
    if (!line.trim()) return;

    if (re.ignore.some((r) => r.test(line))) {
      result.ignored.push({ line: lineNumber, text: line });
      return note(index, IGNORE);
    }
    // Row shapes were marked up on cleaned lines, so rows are read from the
    // line with the cleanup step's removals applied. Markers are read as is.
    const rowLine = applyStrip(line, re.strip);

    // Region boundaries: a declared start marker when there is one, otherwise
    // the first line of the next region's row shape.
    if (region === "header") {
      const starts = re.speakersStart ? re.speakersStart.test(line) : !!re.speakerRow?.test(rowLine);
      if (starts) {
        region = "speakers";
        if (re.speakersStart) return note(index, "speakers:marker");
      }
    }
    if (region === "header" || region === "speakers") {
      const markerHere = !!re.mainStart?.test(line);
      // Without a marker, the main region starts at the first turn row. That
      // is also how a document with no speaker block (and, from the header,
      // no main marker either) gets there: both are optional per document,
      // like the header itself. A turn row is the more specific shape, so it
      // wins over the generic "Key: value" — unless the key is one the sample
      // header had. The speaker block, when a grammar's marker opened it,
      // still waits for the main marker, so a malformed declaration there is
      // reported rather than read as a turn.
      const looksLikeTurn = () => !!re.turnRow?.test(rowLine) && !re.speakerRow?.test(rowLine) && !isKnownHeaderLine(line);
      const starts = markerHere || (region === "header" ? looksLikeTurn() : !re.mainStart && looksLikeTurn());
      if (starts) {
        region = "main";
        if (markerHere) {
          if (re.section?.test(line)) {
            section = line.trim();
            result.sections.push({ line: lineNumber, name: section });
          }
          return note(index, "main:marker");
        }
      }
    }

    if (region === "main" && re.section?.test(line)) {
      openTurn = null;
      section = line.trim();
      result.sections.push({ line: lineNumber, name: section });
      return note(index, "main:marker");
    }

    if (region === "header") {
      const m = line.match(re.headerField);
      if (m) {
        result.metadata[m.groups.key.trim()] = m.groups.value.trim();
        return note(index, "header");
      }
      result.unmatched.push({ line: lineNumber, region, text: line });
      return note(index, "header:unmatched");
    }

    if ((region === "speakers" || region === "main") && !rowLine.trim()) {
      result.ignored.push({ line: lineNumber, text: line });
      return note(index, IGNORE);
    }

    if (region === "speakers") {
      const m = re.speakerRow && rowLine.match(re.speakerRow);
      if (m) {
        result.speakers.push({ line: lineNumber, ...cleanGroups(m.groups) });
        return note(index, "speakers");
      }
      result.unmatched.push({ line: lineNumber, region, text: line });
      return note(index, "speakers:unmatched");
    }

    const m = re.turnRow && rowLine.match(re.turnRow);
    if (m) {
      openTurn = { line: lineNumber, section, ...cleanGroups(m.groups) };
      result.turns.push(openTurn);
      return note(index, "main");
    }
    // A line that is not a row is the wrapped tail of the one above — as long
    // as there is one above, and it doesn't open like a row itself. It is
    // recorded, never folded silently.
    const looksLikeRow = !!re.turnRowStart?.test(rowLine);
    if (openTurn && "text" in openTurn && !looksLikeRow) {
      openTurn.text = `${openTurn.text} ${rowLine.trim()}`.trim();
      result.continuations.push({ line: lineNumber, into: openTurn.line, text: line });
      return note(index, "main:continuation");
    }
    if (looksLikeRow) {
      // Opens with a turn number but doesn't match the row: still a row, as
      // the built-in reader treats one — kept with no speaker, so the gap
      // shows in the CSV, and flagged. Lines after it fold into it, not into
      // the turn before it.
      const start = rowLine.match(re.turnRowStart)[0];
      openTurn = {
        line: lineNumber, section, turn: (start.match(/\d+/) || [""])[0], speaker: "",
        text: rowLine.slice(start.length).replace(/\s+/g, " ").trim(), malformed: true,
      };
      result.turns.push(openTurn);
      return note(index, "main:malformed");
    }
    result.unmatched.push({ line: lineNumber, region, text: line });
    return note(index, "main:unmatched");
  });

  return result;
}

/**
 * Guess region markup for a document the person has not marked up yet, so
 * the editor opens on something to correct rather than a blank slate.
 *
 * With a saved grammar, the guess is that grammar's own reading of the
 * document. Without one, it is the convention ca-data-prep documents: a
 * "Speakers:" heading, upper-case section names, "END OF TRANSCRIPT".
 */
export function suggestRegions(lines, grammar = null) {
  const roles = new Array(lines.length).fill(null);
  const markers = new Array(lines.length).fill(false);

  if (grammar) {
    const parsed = parseWithGrammar(lines, grammar);
    parsed.roles.forEach((role, i) => {
      if (!role) return;
      const [region, detail] = role.split(":");
      roles[i] = region;
      markers[i] = detail === "marker";
    });
    return fillBlanks(lines, roles, markers);
  }

  let region = "header";
  lines.forEach((raw, i) => {
    const line = String(raw || "").trim();
    if (!line) return;
    if (/^END OF TRANSCRIPT\b/i.test(line)) { roles[i] = IGNORE; return; }
    if (region === "header" && /^speakers?\s*:?$/i.test(line)) {
      region = "speakers"; roles[i] = region; markers[i] = true; return;
    }
    if (/^[A-Z][A-Z ]{2,}$/.test(line) && region !== "header") {
      region = "main"; roles[i] = region; markers[i] = true; return;
    }
    roles[i] = region;
  });
  return fillBlanks(lines, roles, markers);
}

// Blank lines take the region of the line above, so a region reads as one
// unbroken band in the editor.
function fillBlanks(lines, roles, markers) {
  let last = null;
  lines.forEach((line, i) => {
    if (String(line || "").trim()) { if (roles[i] && roles[i] !== IGNORE) last = roles[i]; return; }
    roles[i] = last;
  });
  return { roles, markers };
}

// ---------------------------------------------------------------------------
// Cleanup: lines to skip, and text to remove from rows before they are read
// ---------------------------------------------------------------------------

function compileStrip(strip) {
  return (strip || [])
    .map((s) => (typeof s === "string" ? { pattern: s } : s))
    .filter((s) => s?.pattern)
    .map((s) => new RegExp(s.pattern, `${(s.flags || "u").replace("g", "")}g`));
}

// A removal leaves the spaces either side of it; they close up to one. Tabs
// are left alone — a tab can be structure.
const removeAll = (line, re) => {
  const marked = line.replace(re, "\u0000");
  if (marked === line) return line;
  return marked
    .replace(/^ *\u0000[ \u0000]*/, "")
    .replace(/[ \u0000]*\u0000 *$/, "")
    .replace(/ *\u0000[ \u0000]*/g, (m) => (/^ | $/.test(m) ? " " : ""));
};

function applyStrip(line, regexes) {
  let out = line;
  for (const re of regexes) out = removeAll(out, re);
  return out;
}

/** Text to remove exactly as selected (whitespace inside it may vary). */
export function exactPattern(text) {
  return String(text).trim().split(/\s+/).map(escapeRegex).join("\\s+");
}

/**
 * Text to remove wherever something shaped like it appears: digits stand for
 * any digits and letters for any letters, punctuation is kept. "[05:36]"
 * becomes \[\d+:\d+\], "(laughs)" becomes \(\p{L}+\).
 */
export function shapePattern(text) {
  return String(text).trim().split(/(\d+|\p{L}+|\s+)/u).filter(Boolean).map((part) => {
    if (/^\d+$/.test(part)) return "\\d+";
    if (/^\p{L}+$/u.test(part)) return "\\p{L}+";
    if (/^\s+$/.test(part)) return "\\s+";
    return escapeRegex(part);
  }).join("");
}

/** Compile one pattern the person typed; returns an error message or null. */
export function patternError(pattern, { global = false } = {}) {
  if (!String(pattern || "").trim()) return "empty pattern";
  try {
    const re = new RegExp(pattern, global ? "gu" : "u");
    if (global && re.test("")) return "matches empty text, so it would remove nothing and loop";
    return null;
  } catch (e) {
    return e.message;
  }
}

/**
 * What a cleanup does to a document, for the editor's preview and for the
 * rows step to work on. `cleanup` is `{ drop: [pattern], strip: [pattern] }`.
 * Returns the cleaned lines (a dropped line becomes ""), which lines each
 * rule touched, and the before/after of every changed line. Removals apply
 * only to speaker-info and main lines, and never to marker lines.
 */
export function applyCleanup(lines, roles, markers, cleanup) {
  const drop = (cleanup?.drop || []).map((p) => (patternError(p) ? null : new RegExp(p.trim(), "u")));
  const strip = (cleanup?.strip || []).map((p) => (patternError(p, { global: true }) ? null : new RegExp(p.trim(), "gu")));
  const dropHits = drop.map(() => []);
  const stripHits = strip.map(() => []);
  const changes = [];
  const cleaned = lines.map((raw, index) => {
    const line = String(raw ?? "");
    if (!line.trim()) return line;
    const hit = drop.findIndex((re) => re?.test(line));
    if (hit >= 0) {
      dropHits[hit].push(index);
      changes.push({ index, before: line, after: null });
      return "";
    }
    if (markers[index] || (roles[index] !== "speakers" && roles[index] !== "main")) return line;
    let out = line;
    strip.forEach((re, i) => {
      if (!re) return;
      const next = removeAll(out, re);
      if (next !== out) stripHits[i].push(index);
      out = next;
    });
    if (out !== line) changes.push({ index, before: line, after: out });
    return out;
  });
  return { lines: cleaned, dropHits, stripHits, changes };
}

// ---------------------------------------------------------------------------
// Starting points
// ---------------------------------------------------------------------------

const CODE = VALUE_PATTERNS.code;

// The convention ca-data-prep documents, as a grammar. Only ever used to
// pre-fill the editor's sample markup — it is never saved, and never parses a
// document on its own.
export const DEFAULT_GRAMMAR = {
  version: GRAMMAR_VERSION,
  name: "ca-data-prep convention",
  regions: { header: { keys: [] }, speakers: { start: "^\\s*Speakers:?\\s*$" }, main: { start: null, sections: [], sectionPattern: null } },
  ignore: [],
  headerField: { pattern: HEADER_FIELD_PATTERN, flags: "u" },
  speakerRow: {
    pattern: `^[\\t ]*(?<code>${CODE})[\\t ]*:[\\t ]*(?<name>[^\\[(#]+?)(?:[\\t ]*\\[(?<alternateName>[^\\]]+)\\])?(?:[\\t ]*\\((?<affiliation>[^)]+)\\))?[\\t ]*#(?<id>[^\\s,"]+)`,
    flags: "u",
  },
  turnRow: {
    pattern: `^[\\t ]*(?:(?<turn>\\d+)\\.?[\\t ]+)?(?<speaker>${CODE})[\\t ]*:[\\t ]*(?<text>.*?)[\\t ]*$`,
    flags: "u",
  },
};

/** Where each named group of `spec` matched in `line`, as editor spans. */
export function spansFromMatch(line, spec) {
  if (!spec?.pattern) return null;
  const re = new RegExp(spec.pattern, `${(spec.flags || "u").replace("d", "")}d`);
  const match = String(line || "").match(re);
  if (!match?.indices?.groups) return null;
  return Object.entries(match.indices.groups)
    .filter(([, range]) => range && range[1] > range[0])
    .map(([field, [start, end]]) => {
      // Trim, so a lazily-matched name doesn't carry the space before "[".
      const value = line.slice(start, end);
      const lead = value.length - value.trimStart().length;
      const trail = value.length - value.trimEnd().length;
      return { field, start: start + lead, end: end - trail };
    })
    .filter((span) => span.end > span.start);
}

/**
 * Pre-fill sample markup for a region: the matching line with the most
 * fields, plus — when there is one — a line missing some of those fields, so
 * the generated pattern starts out knowing which fields are optional.
 */
export function suggestSamples(lines, roles, markers, region, spec, limit = 2) {
  const candidates = [];
  lines.forEach((line, index) => {
    if (roles[index] !== region || markers[index] || !String(line || "").trim()) return;
    const spans = spansFromMatch(line, spec);
    if (spans?.length) candidates.push({ index, line, spans });
  });
  if (!candidates.length) return [];
  const richest = candidates.reduce((best, c) => (c.spans.length > best.spans.length ? c : best));
  const picked = [richest];
  const richKeys = new Set(richest.spans.map((s) => s.field));
  const sparser = candidates.find((c) => c !== richest && c.spans.length < richKeys.size);
  if (sparser && picked.length < limit) picked.push(sparser);
  return picked.sort((a, b) => a.index - b.index);
}

// ---------------------------------------------------------------------------
// Saved grammars in a collection folder
// ---------------------------------------------------------------------------
//
// Shared by the editor (plugins/transcript-grammar) and the parsers that use a
// saved grammar (ca-data-prep, chat-export). Folder access goes through the
// File System Access handle and the host's readFileTextFromDirectory, which
// each caller already holds.

export const GRAMMAR_CONFIG_DIR = "_config/transcript-grammar";

export const grammarPath = (name) => `${GRAMMAR_CONFIG_DIR}/${name}.json`;

export async function listSavedGrammars(dirHandle) {
  if (!dirHandle) return [];
  let dir = dirHandle;
  try {
    for (const part of GRAMMAR_CONFIG_DIR.split("/")) dir = await dir.getDirectoryHandle(part, { create: false });
  } catch {
    return [];
  }
  const names = [];
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind === "file" && /\.json$/i.test(name)) names.push(name.replace(/\.json$/i, ""));
  }
  return names.sort();
}

/** Read and validate a saved grammar. Throws with the path in the message. */
export async function loadSavedGrammar(dirHandle, name, readFileTextFromDirectory) {
  const path = grammarPath(name);
  const text = await readFileTextFromDirectory(dirHandle, path);
  if (text == null) throw new Error(`${path} not found.`);
  let grammar;
  try { grammar = JSON.parse(text); }
  catch (e) { throw new Error(`${path} is not valid JSON: ${e.message}`); }
  const problems = validateGrammar(grammar);
  if (problems.length) throw new Error(`${path}: ${problems.join("; ")}`);
  return grammar;
}

/**
 * A short, stable fingerprint of what a grammar parses — its patterns and
 * regions, not when it was saved or what it was marked up from. Two saves of
 * the same markup fingerprint the same, so re-saving without a change does
 * not read as a change.
 */
export function grammarFingerprint(grammar) {
  const { regions, ignore, headerField, speakerRow, turnRow } = grammar || {};
  const strip = (row) => (row ? { pattern: row.pattern, flags: row.flags, rowStart: row.rowStart ?? null } : null);
  const text = JSON.stringify([regions, ignore, headerField, strip(speakerRow), strip(turnRow)]);
  // FNV-1a, 32-bit. Collisions only matter as a missed "grammar changed"
  // warning, and a person saving grammars is not an adversary.
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Split extracted document text into lines, choosing the reading by shape:
 * mammoth's (every paragraph followed by a blank line) gives paragraphs,
 * anything else gives its own lines.
 */
export function documentLines(text) {
  const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
  let filled = 0;
  let spaced = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    filled++;
    if (i + 1 >= lines.length || lines[i + 1] === "") spaced++;
  }
  const mammothShaped = filled > 0 && spaced / filled >= 0.9;
  return textToLines(text, { paragraphs: mammothShaped });
}
