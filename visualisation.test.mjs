// The pure seams of the visualisation panels: matching, counting and scaling.
//
// The panels themselves are DOM and stay untested here, as the rest of this
// repo's UI does. What is tested is the half that can be wrong while looking
// right — a window that clips a word, an n-gram that runs across a speaker
// change, a chart scale that hides the tallest bar.
//
//   node visualisation.test.mjs
import assert from "node:assert/strict";

import { search } from "./plugins/concordance/index.js";
import { analyzeNgrams, tokenize } from "./plugins/ngrams/index.js";
import {
  analyzeCollocations, documentsForSelection, fisherExact,
  tokenize as tokenizeCollocations,
} from "./plugins/collocation/index.js";
import { chartGeometry } from "./plugins/chart/index.js";
import { REGISTRY } from "./index.js";

let failures = 0;
const check = (label, fn) => {
  try { fn(); console.log(`  ok   ${label}`); }
  catch (e) { failures++; console.log(`  FAIL ${label}\n       ${e.message}`); }
};

const docs = (...lines) => lines.map((text, i) => ({ id: `d${i}`, source: "test.csv", speaker: "", text }));

console.log("The contract");

const deps = new Proxy({}, { get: () => () => {} });
for (const [name, factory] of Object.entries(REGISTRY)) {
  const plugin = factory(deps);
  if (!plugin.visualisation) continue;
  check(`${name}: its panel declares label, hint and render`, () => {
    const { label, hint, render } = plugin.visualisation;
    assert.equal(typeof label, "string", "a panel needs a label for the sidebar");
    assert.ok(label.length, "the label is empty");
    assert.equal(typeof hint, "string", "a panel needs a one-line hint");
    assert.equal(typeof render, "function", "a panel needs render(container, ctx)");
  });
  check(`${name}: declares no hooks — it runs during no build`, () => {
    assert.equal(Object.keys(plugin.hooks || {}).length, 0);
  });
}

console.log("\nconcordance");

check("finds every occurrence, with a window either side", () => {
  const rows = search(docs("the quick brown fox jumps over the lazy dog"), "fox", { windowSize: 2 });
  assert.equal(rows.length, 1);
  assert.deepEqual(
    { left: rows[0].left, keyword: rows[0].keyword, right: rows[0].right },
    { left: "quick brown", keyword: "fox", right: "jumps over" },
    "two words either side, and the keyword exactly as written"
  );
});

check("a window wider than the text takes what there is", () => {
  const [row] = search(docs("fox jumps"), "fox", { windowSize: 5 });
  assert.equal(row.left, "", "nothing to the left of the first word");
  assert.equal(row.right, "jumps");
});

check("case-insensitive by default, and reports what it matched", () => {
  const rows = search(docs("Fox and fox"), "fox", { windowSize: 2 });
  assert.deepEqual(rows.map((r) => r.keyword), ["Fox", "fox"],
    "each row carries the text as it appeared, not the query");
  assert.equal(search(docs("Fox and fox"), "fox", { caseSensitive: true }).length, 1);
});

check("whole word only matches whole words", () => {
  assert.equal(search(docs("the foxes ran"), "fox", { wholeWord: true }).length, 0);
  assert.equal(search(docs("the fox ran"), "fox", { wholeWord: true }).length, 1);
});

check("a literal query is not read as a pattern", () => {
  assert.equal(search(docs("a.b and axb"), "a.b").length, 1,
    "the dot is a dot unless regex is on");
  assert.equal(search(docs("a.b and axb"), "a.b", { regex: true }).length, 2);
});

check("a pattern that can match nothing still terminates", () => {
  // Would spin forever on a zero-length match without the guard.
  const rows = search(docs("aaa"), "b*", { regex: true });
  assert.ok(Array.isArray(rows), "returned rather than hanging");
});

check("an invalid pattern throws for the panel to report", () => {
  assert.throws(() => search(docs("x"), "(unclosed", { regex: true }));
});

check("searches every document and says which it came from", () => {
  const two = [
    { source: "a.csv", speaker: "CHI", text: "fox one" },
    { source: "b.csv", speaker: "MOT", text: "fox two" },
  ];
  assert.deepEqual(search(two, "fox").map((r) => [r.source, r.speaker]),
    [["a.csv", "CHI"], ["b.csv", "MOT"]]);
});

console.log("\nngrams");

check("tokenises non-ASCII orthographies as words", () => {
  assert.deepEqual(tokenize("Yolŋu-matha ŋurra don't"), ["yolŋu-matha", "ŋurra", "don't"],
    "the whole point of not using [A-Za-z0-9]");
});

check("counts n-grams and ranks them by frequency", () => {
  const rows = analyzeNgrams(docs("a b a b", "a b"), { n: 2, minFreq: 1 });
  const ab = rows.find((r) => r.ngram === "a b");
  assert.equal(ab.count, 3);
  assert.equal(rows[0].ngram, "a b", "most frequent first");
});

check("an n-gram never spans two documents", () => {
  // "b c" would exist only by running the window across the boundary.
  const rows = analyzeNgrams(docs("a b", "c d"), { n: 2, minFreq: 1 });
  assert.deepEqual(rows.map((r) => r.ngram).sort(), ["a b", "c d"]);
});

check("minimum frequency and stopwords filter rows out", () => {
  const corpus = docs("the cat sat", "the cat ran", "the cat sat");
  assert.equal(analyzeNgrams(corpus, { n: 2, minFreq: 3 }).length, 1, "only 'the cat' occurs three times");
  const noStop = analyzeNgrams(corpus, { n: 2, minFreq: 1, removeStopwords: true });
  assert.ok(!noStop.some((r) => r.ngram.split(" ").includes("the")),
    "a stopword anywhere in the n-gram drops it");
});

check("stopwords are not removed unless asked", () => {
  const rows = analyzeNgrams(docs("the cat", "the cat"), { n: 2, minFreq: 1 });
  assert.equal(rows[0].ngram, "the cat",
    "the default keeps them: the list is English and the corpus may not be");
});

check("MI and t-score, against hand-worked numbers", () => {
  // "a b" twice in "a b c a b c": N=6 tokens, f(a)=2, f(b)=2, O=2.
  // expected = 2*2/6 = 0.666… ; MI = log2(2/0.666…) = log2(3) ≈ 1.585
  // t = (2 - 0.666…)/sqrt(2) ≈ 0.943
  const [row] = analyzeNgrams(docs("a b c a b c"), { n: 2, minFreq: 2 });
  assert.equal(row.ngram, "a b");
  assert.ok(Math.abs(row.mi - Math.log2(3)) < 1e-9, `MI was ${row.mi}`);
  assert.ok(Math.abs(row.tScore - (2 - 4 / 6) / Math.SQRT2) < 1e-9, `t was ${row.tScore}`);
});

check("no association measures for anything but bigrams", () => {
  const [row] = analyzeNgrams(docs("a b c a b c"), { n: 3, minFreq: 2 });
  assert.ok(!("mi" in row) && !("tScore" in row), "MI is defined for pairs, not triples");
});

console.log("\ncollocations");

check("tokenises Unicode words and matches nodes without case", () => {
  assert.deepEqual(tokenizeCollocations("YOLNGU-matha ŋurra don't"), ["yolngu-matha", "ŋurra", "don't"]);
  const rows = analyzeCollocations(docs("YOLNGU-matha ŋurra"), { nodes: "yolngu-matha", minFreq: 1, spanLeft: 1, spanRight: 1 });
  assert.equal(rows[0].collocate, "ŋurra");
});

check("uses one corpus stream and independent left/right windows", () => {
  const rows = analyzeCollocations(docs("left node right", "after"), {
    nodes: "node", minFreq: 1, spanLeft: 1, spanRight: 2,
  });
  assert.deepEqual(rows.map((row) => row.collocate), ["left", "right", "after"]);
});

check("handles comma-separated nodes and frequency filtering", () => {
  const rows = analyzeCollocations(docs("a x b a x b"), {
    nodes: "a, b, missing", minFreq: 2, spanLeft: 1, spanRight: 1,
  });
  assert.deepEqual(rows.map((row) => [row.node, row.collocate, row.O]), [["a", "x", 2], ["b", "x", 2]]);
});

check("returns hand-worked association measures and stable columns", () => {
  const [row] = analyzeCollocations(docs("a b c a b c"), {
    nodes: "a", minFreq: 2, spanLeft: 1, spanRight: 1,
  }).filter((candidate) => candidate.collocate === "b");
  assert.deepEqual(Object.keys(row), [
    "node", "collocate", "O", "E", "f_node", "f_collocate", "N", "OE", "MI", "MI2", "MI3",
    "G2", "tscore", "DeltaP12", "DeltaP21", "Fisher",
  ]);
  assert.equal(row.O, 2);
  assert.equal(row.E, 2 * 2 / 6);
  assert.ok(Math.abs(row.MI - Math.log2(3)) < 1e-9);
  assert.ok(Math.abs(row.tscore - (2 - 2 / 3) / Math.SQRT2) < 1e-9);
  assert.ok(Math.abs(row.Fisher - 1 / 15) < 1e-9);
});

check("Fisher exact handles a known table and large tables", () => {
  assert.ok(Math.abs(fisherExact(2, 0, 0, 4) - 1 / 15) < 1e-9);
  assert.equal(fisherExact(0, 0, 0, 2001), 1);
});

check("selects one file and combines selected CSV columns", () => {
  const documents = [
    { source: "notes.txt", text: "node note" },
    { source: "data.csv", text: "node ignored" },
  ];
  const tables = [{
    source: "data.csv",
    header: ["text", "translation", "speaker"],
    rows: [["node", "ŋurra", "CHI"]],
  }];
  assert.deepEqual(
    documentsForSelection(documents, tables, "data.csv", ["text", "translation"]).map((row) => row.text),
    ["node ŋurra"],
    "selected CSV columns become one analysis document per row"
  );
  assert.deepEqual(
    documentsForSelection(documents, tables, "notes.txt").map((row) => row.text),
    ["node note"],
    "non-CSV sources keep their existing document text"
  );
});

console.log("\nchart");

const rows = [
  { name: "one", value: "10" },
  { name: "two", value: "20" },
  { name: "three", value: "n/a" },
];

check("skips non-numeric values and counts them", () => {
  const g = chartGeometry(rows, { xColumn: "name", yColumn: "value" });
  assert.equal(g.points.length, 2);
  assert.equal(g.skipped, 1, "the panel reports this rather than plotting a zero");
});

check("the scale always includes zero", () => {
  const g = chartGeometry([{ x: "a", y: "10" }, { x: "b", y: "12" }], { xColumn: "x", yColumn: "y" });
  assert.equal(g.scale.min, 0, "a floating baseline makes bar lengths meaningless");
  assert.equal(g.scale.max, 12);
});

check("the tallest value sits at the top of the plot, zero at the bottom", () => {
  const g = chartGeometry(rows, { xColumn: "name", yColumn: "value" });
  assert.equal(Math.round(g.scale.y(20)), g.plot.margin.top, "the maximum touches the top margin");
  assert.equal(Math.round(g.scale.y(0)), g.plot.margin.top + g.plot.innerHeight, "zero sits on the axis");
});

check("negative values keep zero inside the plot", () => {
  const g = chartGeometry([{ x: "a", y: "-5" }, { x: "b", y: "5" }], { xColumn: "x", yColumn: "y" });
  const zero = g.scale.y(0);
  assert.ok(zero > g.plot.margin.top && zero < g.plot.margin.top + g.plot.innerHeight,
    "the baseline is between the extremes, not off the chart");
});

check("ticks span the scale and are labelled", () => {
  const g = chartGeometry(rows, { xColumn: "name", yColumn: "value" });
  assert.equal(g.ticks[0].value, 0);
  assert.equal(g.ticks[g.ticks.length - 1].value, 20);
  assert.equal(g.ticks[g.ticks.length - 1].label, "20");
});

check("thousands are abbreviated in tick labels", () => {
  const g = chartGeometry([{ x: "a", y: "4000" }], { xColumn: "x", yColumn: "y" });
  assert.equal(g.ticks[g.ticks.length - 1].label, "4k");
});

check("numbers written with separators still count", () => {
  const g = chartGeometry([{ x: "a", y: "1,200" }], { xColumn: "x", yColumn: "y" });
  assert.equal(g.points[0].value, 1200);
  assert.equal(g.skipped, 0);
});

check("an empty table yields no points and no division by zero", () => {
  const g = chartGeometry([], { xColumn: "x", yColumn: "y" });
  assert.equal(g.points.length, 0);
  assert.ok(Number.isFinite(g.step), `step was ${g.step}`);
});

if (failures) {
  console.error(`\nvisualisation.test: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll checks passed");
