// transcript-grammar: patterns generated from markup, and the parser that
// reads documents with them. The editor itself is DOM and stays untested
// here; everything it saves comes out of these functions.
//
// Names below are placeholders with no connection to any participant — see
// "Names in fixtures" in the project notes.
//
//   node transcript-grammar.test.mjs
import assert from "node:assert/strict";
import {
  SPEAKER_FIELDS, TURN_FIELDS, DEFAULT_GRAMMAR,
  buildRowPattern, buildRegions, buildGrammar, checkRegionOrder, decomposeSample,
  escapeRegex, parseWithGrammar, spansFromMatch, suggestRegions, suggestSamples,
  textToLines, validateGrammar,
} from "./plugins/transcript-grammar/grammar.js";

let failures = 0;
const check = (label, fn) => {
  try { fn(); console.log(`  ok   ${label}`); }
  catch (e) { failures++; console.log(`  FAIL ${label}\n       ${e.message}`); }
};

// Mark `line` up by naming the text of each field, in order.
const markup = (line, parts) => {
  let from = 0;
  const spans = parts.map(([field, text]) => {
    const start = line.indexOf(text, from);
    if (start < 0) throw new Error(`"${text}" not in "${line}"`);
    from = start + text.length;
    return { field, start, end: from };
  });
  return { line, spans };
};

const LINES = [
  "Transcript: demo-01",
  "Recording date: 2020-01-01",
  "",
  "Participants",
  "AA:\tAlex [Alex Example] (Researcher, Place A) #p001",
  "BB:\tSam (Participant) #p002",
  "",
  "OPENING",
  "1\tAA:\tfirst turn",
  "2\tBB:\tsecond turn",
  "that wraps onto a second line",
  "BODY",
  "3\tAA:\tthird turn",
  "4\t(0.5)",
  "5.\tBB:\tfifth turn has a period",
  "-- end --",
];

const ROLES = [
  "header", "header", "header",
  "speakers", "speakers", "speakers", "speakers",
  "main", "main", "main", "main", "main", "main", "main", "main",
  "ignore",
];
const MARKERS = LINES.map((l) => ["Participants", "OPENING", "BODY"].includes(l));

const SPEAKER_SAMPLES = [
  markup(LINES[4], [["code", "AA"], ["name", "Alex"], ["alternateName", "Alex Example"], ["affiliation", "Researcher, Place A"], ["id", "p001"]]),
  markup(LINES[5], [["code", "BB"], ["name", "Sam"], ["affiliation", "Participant"], ["id", "p002"]]),
];
const TURN_SAMPLES = [markup(LINES[8], [["turn", "1"], ["speaker", "AA"], ["text", "first turn"]])];

const GRAMMAR = buildGrammar({
  name: "demo", lines: LINES, roles: ROLES, markers: MARKERS,
  speakerSamples: SPEAKER_SAMPLES, turnSamples: TURN_SAMPLES,
});

console.log("Row patterns");

check("a speaker pattern reads every field the samples marked", () => {
  const spec = buildRowPattern(SPEAKER_SAMPLES, SPEAKER_FIELDS);
  const m = LINES[4].match(new RegExp(spec.pattern, spec.flags));
  assert.ok(m, spec.pattern);
  assert.deepEqual({ ...m.groups }, {
    code: "AA", name: "Alex", alternateName: "Alex Example", affiliation: "Researcher, Place A", id: "p001",
  });
});

check("a field only some samples have is optional, and its brackets go with it", () => {
  const spec = buildRowPattern(SPEAKER_SAMPLES, SPEAKER_FIELDS);
  assert.deepEqual(spec.fields.filter((f) => f.optional).map((f) => f.key), ["alternateName"]);
  const m = LINES[5].match(new RegExp(spec.pattern, spec.flags));
  assert.equal(m.groups.alternateName, undefined);
  assert.equal(m.groups.name, "Sam");
  assert.equal(m.groups.affiliation, "Participant");
});

check("a row shape neither sample had exactly still parses when it fits the pattern", () => {
  const spec = buildRowPattern(SPEAKER_SAMPLES, SPEAKER_FIELDS);
  const m = "CC:  Robin Q [Robin Quux] (Visitor)   #p003".match(new RegExp(spec.pattern, spec.flags));
  assert.ok(m);
  assert.equal(m.groups.name, "Robin Q");
  assert.equal(m.groups.alternateName, "Robin Quux");
});

check("a required field that is missing fails the match rather than shifting fields", () => {
  const spec = buildRowPattern(SPEAKER_SAMPLES, SPEAKER_FIELDS);
  assert.equal(new RegExp(spec.pattern, spec.flags).test("DD:\tNoId (Participant)"), false);
});

check("a field can be forced optional even when every sample has it", () => {
  const spec = buildRowPattern(SPEAKER_SAMPLES, SPEAKER_FIELDS, { optional: ["affiliation"] });
  assert.ok(new RegExp(spec.pattern, spec.flags).test("DD:\tKim #p004"));
});

check("stray punctuation after the last field is tolerated, not required", () => {
  const withComma = markup("AA:\tAlex (R) #p001,", [["code", "AA"], ["name", "Alex"], ["affiliation", "R"], ["id", "p001"]]);
  const spec = buildRowPattern([withComma], SPEAKER_FIELDS);
  const re = new RegExp(spec.pattern, spec.flags);
  assert.ok(re.test("BB:\tSam (P) #p002,"));
  assert.ok(re.test("BB:\tSam (P) #p002"));
  assert.equal("BB:\tSam (P) #p002,".match(re).groups.id, "p002");
});

check("a tab between turn number and speaker stays a tab", () => {
  const spec = buildRowPattern(TURN_SAMPLES, TURN_FIELDS);
  const re = new RegExp(spec.pattern, spec.flags);
  assert.ok(re.test("12\tAA:\ttext"));
  assert.equal(re.test("1998 was: the year"), false);
});

check("marking a sample without a turn number makes the number optional", () => {
  const spec = buildRowPattern([...TURN_SAMPLES, markup("BB:\thello", [["speaker", "BB"], ["text", "hello"]])], TURN_FIELDS);
  const re = new RegExp(spec.pattern, spec.flags);
  assert.equal("CC:\tunnumbered".match(re).groups.speaker, "CC");
  assert.equal("7\tCC:\tnumbered".match(re).groups.turn, "7");
});

check("an empty text field still matches", () => {
  const spec = buildRowPattern(TURN_SAMPLES, TURN_FIELDS);
  assert.equal("3\tAA:\t".match(new RegExp(spec.pattern, spec.flags)).groups.text, "");
});

check("unicode codes and names parse", () => {
  const sample = markup("Ŋa:\tŊarri (Élder) #x1", [["code", "Ŋa"], ["name", "Ŋarri"], ["affiliation", "Élder"], ["id", "x1"]]);
  const spec = buildRowPattern([sample], SPEAKER_FIELDS);
  assert.equal("Ŋu:\tŊulu (Élder) #x2".match(new RegExp(spec.pattern, spec.flags)).groups.code, "Ŋu");
});

check("samples that disagree on field order are refused", () => {
  const reordered = markup("p003 Alex AA", [["id", "p003"], ["name", "Alex"], ["code", "AA"]]);
  assert.throws(() => buildRowPattern([SPEAKER_SAMPLES[0], reordered], SPEAKER_FIELDS), /different orders/);
});

check("overlapping marks are refused", () => {
  assert.throws(() => decomposeSample({ line: "AA: Alex", spans: [{ field: "code", start: 0, end: 3 }, { field: "name", start: 2, end: 8 }] }), /overlap/);
});

check("a sample with no marks yields no pattern", () => {
  assert.equal(buildRowPattern([{ line: "AA: x", spans: [] }], TURN_FIELDS), null);
});

check("escaped literals compile under the u flag", () => {
  for (const text of ["a-b", "#id", "x: y", "(a) [b] {c}", "1.5*2+3?", "a/b|c^$"]) {
    assert.ok(new RegExp(`^${escapeRegex(text)}$`, "u").test(text), text);
  }
});

console.log("Regions");

check("markers become region starts and section names; ignored lines become patterns", () => {
  const { regions, ignore } = buildRegions(LINES, ROLES, MARKERS);
  assert.ok(new RegExp(regions.speakers.start, "u").test("Participants"));
  assert.ok(new RegExp(regions.main.start, "u").test("OPENING"));
  assert.deepEqual(regions.main.sections, ["OPENING", "BODY"]);
  assert.deepEqual(regions.header.keys, ["Transcript", "Recording date"]);
  assert.equal(ignore.length, 1);
  assert.ok(new RegExp(ignore[0], "u").test("--   end --"));
});

check("regions out of order are reported once, and missing regions named", () => {
  assert.deepEqual(checkRegionOrder(ROLES), []);
  const problems = checkRegionOrder(["header", "main", "speakers", "speakers"]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /Line 3 is marked Speaker info but comes after Main/);
  assert.deepEqual(checkRegionOrder(["header"]), ["No lines are marked Speaker info.", "No lines are marked Main."]);
});

console.log("Parsing another document");

const OTHER = [
  "Transcript: demo-02",
  "Transcriber: Someone",
  "Participants",
  "CC:\tRobin (Visitor) #p003",
  "DD:\tKim [Kim Placeholder] (Participant) #p004",
  "OPENING",
  "1\tCC:\thello",
  "2\tDD:\thi there",
  "and more",
  "BODY",
  "3\tCC:\tbye",
  "4\t(1.2)",
  "stray line",
  "-- end --",
].join("\n");

const parsed = parseWithGrammar(OTHER, GRAMMAR);

check("header lines become metadata", () => {
  assert.deepEqual(parsed.metadata, { Transcript: "demo-02", Transcriber: "Someone" });
});

check("speakers are read with their fields, trimmed, blanks for absent optionals", () => {
  assert.deepEqual(parsed.speakers.map(({ line, ...s }) => s), [
    { code: "CC", name: "Robin", alternateName: "", affiliation: "Visitor", id: "p003" },
    { code: "DD", name: "Kim", alternateName: "Kim Placeholder", affiliation: "Participant", id: "p004" },
  ]);
});

check("turns carry their section, and a wrapped line folds into the turn above", () => {
  assert.deepEqual(parsed.turns.map((t) => `${t.section}/${t.turn}/${t.speaker}/${t.text}`), [
    "OPENING/1/CC/hello",
    "OPENING/2/DD/hi there and more",
    "BODY/3/CC/bye",
  ]);
  assert.deepEqual(parsed.continuations.map((c) => [c.line, c.into]), [[9, 8]]);
});

check("a numbered line with no speaker is reported, not folded — and nothing after it folds into it", () => {
  assert.deepEqual(parsed.unmatched.map((u) => [u.line, u.region]), [[12, "main"], [13, "main"]]);
});

check("an ignored line is recorded as ignored", () => {
  assert.deepEqual(parsed.ignored.map((i) => i.line), [14]);
});

check("every non-blank line is accounted for exactly once", () => {
  const lines = OTHER.split("\n");
  const counted = Object.keys(parsed.metadata).length + parsed.speakers.length + parsed.turns.length
    + parsed.sections.length + parsed.continuations.length + parsed.ignored.length + parsed.unmatched.length
    + 1; // the "Participants" marker
  assert.equal(counted, lines.filter((l) => l.trim()).length);
});

check("without marker lines, region boundaries come from the row shapes", () => {
  const roles = ROLES.slice();
  const grammar = buildGrammar({
    name: "no-markers", lines: LINES, roles, markers: LINES.map(() => false),
    speakerSamples: SPEAKER_SAMPLES, turnSamples: TURN_SAMPLES,
  });
  assert.equal(grammar.regions.speakers.start, null);
  assert.equal(grammar.regions.main.start, null);
  const result = parseWithGrammar(["Title: x", "CC:\tRobin (Visitor) #p003", "1\tCC:\thello"], grammar);
  assert.equal(result.metadata.Title, "x");
  assert.equal(result.speakers.length, 1);
  assert.equal(result.turns.length, 1);
});

check("a .docx's paragraphs are the lines, soft breaks folded in", () => {
  assert.deepEqual(textToLines("A: b\n\nC\nD\n\n\n\nE\n\n", { paragraphs: true }), ["A: b", "C D", "", "E"]);
  assert.deepEqual(textToLines("a\r\nb\rc"), ["a", "b", "c"]);
});

console.log("The saved config");

check("the grammar validates and carries no sample text", () => {
  assert.deepEqual(validateGrammar(GRAMMAR), []);
  const json = JSON.stringify(GRAMMAR);
  for (const word of ["Alex", "Example", "Sam", "Researcher", "Place A", "p001", "first turn"]) {
    assert.ok(!json.includes(word), `saved grammar contains "${word}"`);
  }
});

check("a round trip through JSON parses the same", () => {
  const again = parseWithGrammar(OTHER, JSON.parse(JSON.stringify(GRAMMAR)));
  assert.deepEqual(again.turns, parsed.turns);
});

check("a broken pattern is caught by validation", () => {
  const broken = { ...GRAMMAR, turnRow: { ...GRAMMAR.turnRow, pattern: "(unclosed" } };
  assert.match(validateGrammar(broken).join(), /turnRow/);
  assert.match(validateGrammar({ ...GRAMMAR, version: 99 }).join(), /unsupported version/);
});

console.log("Starting points");

check("region suggestions follow the ca-data-prep convention", () => {
  const lines = ["Transcript: t", "Speakers:", "A:\tAl #a", "", "MAIN", "A:\thi", "END OF TRANSCRIPT"];
  const { roles, markers } = suggestRegions(lines);
  assert.deepEqual(roles, ["header", "speakers", "speakers", "speakers", "main", "main", "ignore"]);
  assert.deepEqual(markers, [false, true, false, false, true, false, false]);
});

check("a saved grammar suggests regions for a new document by parsing it", () => {
  const { roles, markers } = suggestRegions(OTHER.split("\n"), GRAMMAR);
  assert.equal(roles[3], "speakers");
  assert.equal(markers[2], true);
  assert.equal(roles[13], "ignore");
});

check("sample suggestions pick the fullest row and a sparser one", () => {
  const picked = suggestSamples(LINES, ROLES, MARKERS, "speakers", DEFAULT_GRAMMAR.speakerRow);
  assert.deepEqual(picked.map((p) => p.index), [4, 5]);
  const names = picked[0].spans.map((s) => LINES[4].slice(s.start, s.end));
  assert.deepEqual(names, ["AA", "Alex", "Alex Example", "Researcher, Place A", "p001"]);
});

check("spans from a match are trimmed to the text", () => {
  const spans = spansFromMatch("AA:\tAlex   [Alex Example] #p001", DEFAULT_GRAMMAR.speakerRow);
  const name = spans.find((s) => s.field === "name");
  assert.equal("AA:\tAlex   [Alex Example] #p001".slice(name.start, name.end), "Alex");
});

check("suggested samples regenerate a grammar that parses the sample itself", () => {
  const speakerSamples = suggestSamples(LINES, ROLES, MARKERS, "speakers", DEFAULT_GRAMMAR.speakerRow);
  const turnSamples = suggestSamples(LINES, ROLES, MARKERS, "main", DEFAULT_GRAMMAR.turnRow);
  const grammar = buildGrammar({ name: "x", lines: LINES, roles: ROLES, markers: MARKERS, speakerSamples, turnSamples });
  const result = parseWithGrammar(LINES, grammar);
  assert.equal(result.speakers.length, 2);
  assert.equal(result.turns.length, 3);
  // "4\t(0.5)" and the period-numbered row: both reported, neither folded.
  assert.deepEqual(result.unmatched.map((u) => u.line), [14, 15]);
});

if (failures) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll transcript-grammar checks passed.");
