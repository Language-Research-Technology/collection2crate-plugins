// The transcript parser's line grammar — the part that decides what is a turn
// and what is a continuation of the turn before it. Everything downstream (the
// CSV, the CHAT export, the crate's Person entities) is derived from the rows
// this produces, so a line shape it fails to recognise doesn't produce a
// warning: it produces an empty CSV.
//
//   node transcript.test.mjs
import assert from "node:assert/strict";

import { processTranscriptText, parseRows, mergeContinuationLines, normalizeText } from "./plugins/ca-data-prep/process.js";

let failures = 0;
const check = async (label, fn) => {
  try { await fn(); console.log(`  ok   ${label}`); }
  catch (e) { failures++; console.log(`  FAIL ${label}\n       ${e.message}`); }
};

const doc = (turns) => [
  "\tTranscript: demo", "",
  "Speakers:",
  "D:\tDora [Dora Leung] (Australian, male) #dora",
  "S:\tSona [Sona Johnson] (Chinese, female) #sona",
  "C:\tCharlie (research assistant) #charlie", "",
  "PRELIMINARIES", turns[0], "",
  "MAIN", turns[1], turns[2], "",
  "POSTLIMINARIES", turns[3],
].join("\n\n");

const UNNUMBERED = doc(["C:\tcan you tell me your name again?", "D:\thi", "S:\thi ((smiles))", "S:\toh (0.2) @"]);
const NUMBERED = doc(["1\tC:\tcan you tell me your name again?", "4\tD:\thi", "5\tS:\thi ((smiles))", "9\tS:\toh (0.2) @"]);

const shape = (result) => result.rows.map((r) => `${r.section}/${r.speakerID}/${r.text}`);

console.log("Turn lines");

await check("an unnumbered transcript parses its turns and sections", async () => {
  const { rows } = await processTranscriptText(UNNUMBERED, {});
  assert.deepEqual(rows.map((r) => r.section), ["PRE", "MAIN", "MAIN", "POST"]);
  assert.deepEqual(rows.map((r) => r.speakerID), ["#charlie", "#dora", "#sona", "#sona"]);
});

await check("a leading turn-number column parses identically — the number is dropped", async () => {
  const numbered = await processTranscriptText(NUMBERED, {});
  const plain = await processTranscriptText(UNNUMBERED, {});
  assert.deepEqual(shape(numbered), shape(plain));
});

await check("a numbered transcript keeps its section markers", () => {
  // The failure this guards is silent and total: before the turn-number
  // prefix was allowed, every numbered line counted as a continuation, so the
  // whole transcript — section markers included — was glued onto the last
  // speaker line of the Speakers block and parseRows returned nothing.
  const rows = parseRows(mergeContinuationLines(normalizeText(NUMBERED)));
  assert.equal(rows.length, 4, "expected four turns, one per section marker plus two in MAIN");
  assert.ok(rows.every((r) => !/^\d/.test(r.text)), "a turn number leaked into the turn's text");
});

await check("a continuation line still folds into the turn above it", async () => {
  const withWrap = NUMBERED.replace("4\tD:\thi", "4\tD:\thi\n\nand hello again");
  const { rows } = await processTranscriptText(withWrap, {});
  assert.equal(rows[1].text, "hi and hello again");
});

await check("a numeral that isn't a turn number doesn't become a turn", () => {
  const rows = parseRows(mergeContinuationLines(normalizeText(
    doc(["C:\tin 1998 Budget: the figure was", "D:\thi", "S:\thi", "S:\tbye"])
  )));
  assert.equal(rows.length, 4);
  assert.equal(rows[0].text, "in 1998 Budget: the figure was");
});

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
