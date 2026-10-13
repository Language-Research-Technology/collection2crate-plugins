// name-lookup: people and places found in a file's text by named entity
// recognition — with other proper names confirmed as places by a gazetteer —
// then linked from the File at Process, reusing an entity the crate already
// holds under the name's @id and creating one otherwise. Offline: the
// gazetteer is a stub here.
//
//   node name-lookup.test.mjs
import assert from "node:assert/strict";
import { ROCrate } from "ro-crate";
import { REGISTRY } from "./index.js";
import { linkNamedEntities, confirmPlaces } from "./plugins/name-lookup/index.js";
import { generatedEntityId } from "./src/_entity_ids.js";
import { extractNames, fileText, isReadableForNames } from "./plugins/name-lookup/extract.js";

let failures = 0;
const check = async (label, fn) => {
  try { await fn(); console.log(`  ok   ${label}`); }
  catch (e) { failures++; console.log(`  FAIL ${label}\n       ${e.message}`); }
};
const ids = (value) => (Array.isArray(value) ? value : [value]).map((v) => v?.["@id"] ?? v);

const TEXT = "Dora Leung recorded this with John Smith's family at Mount Isa. " +
  "Later, Mrs. Mary O'Brien travelled to Queensland and Palm Island, then on to Yarrabah.";

// A one-page PDF whose text is `text`, with a correct xref table — enough for
// pdf.js to read without repairing it.
function pdfWithText(text) {
  const stream = `BT /F1 12 Tf 72 720 Td (${text.replace(/[()\\]/g, "\\$&")}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets = objects.map((body, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

console.log("name-lookup");

await check("@ids follow merge's scheme", () => {
  assert.equal(generatedEntityId("Person", "John Smith"), "#john_smith");
  assert.equal(generatedEntityId("Person", "Mary O'Brien"), "#mary_o_brien");
  assert.equal(generatedEntityId("Place", " Mount  Isa "), "#place-mount-isa");
});

await check("a Person merge made from a spreadsheet is the one a file links to", async () => {
  const { mergeXlsxIntoCrate } = await import("./plugins/merge/xlsx.js");
  const { default: ExcelJS } = await import("exceljs");
  const book = new ExcelJS.Workbook();
  book.addWorksheet("Sheet1").addRows([["@id", "contentPerson", "location"], ["a.txt", "Dora Leung", "Mount Isa"]]);
  const bytes = await book.xlsx.writeBuffer();
  const crate = new ROCrate({ array: true, link: true });
  crate.addEntity({ "@id": "a.txt", "@type": "File", name: "a.txt" });
  await mergeXlsxIntoCrate(crate, bytes,
    { mapping: [{ source: "contentPerson", target: "custom:contentPerson", type: "Person" },
                { source: "location", target: "contentLocation", type: "Place" }],
      placeLookup: { enabled: false } },
    () => {}, (c, id) => c.getEntity(id));
  const counts = linkNamedEntities(crate, { "a.txt": { people: ["Dora Leung"], places: ["Mount Isa"] } });
  assert.deepEqual(counts, { created: 0, reused: 2, links: 2 });
});

await check("finds people and places, without honorifics, possessives or trailing punctuation", () => {
  const { people, places, candidates } = extractNames(TEXT);
  assert.deepEqual(people, ["Dora Leung", "John Smith", "Mary O'Brien"]);
  assert.deepEqual(places, ["Mount Isa", "Queensland", "Palm Island"]);
  assert.deepEqual(candidates, ["Yarrabah"], "other proper names are left for the gazetteer");
});

await check("a name running across a comma is two", () => {
  const { people, candidates } = extractNames("Notes by George Watson, Jambun.");
  assert.deepEqual(people, ["George Watson"]);
  assert.deepEqual(candidates, ["Jambun"]);
});

await check("reads .txt, .md, .docx and .pdf only", async () => {
  assert.ok(["notes.txt", "a/b.MD", "x.docx", "scan.PDF"].every(isReadableForNames));
  assert.ok(!isReadableForNames("song.wav") && !isReadableForNames("sheet.xlsx"));
  assert.equal(await fileText(new TextEncoder().encode("Hello Dora"), "a.txt"), "Hello Dora");
});

await check("reads a PDF's text", async () => {
  const text = await fileText(pdfWithText("Dora Leung visited Mount Isa."), "field-notes.pdf");
  assert.match(text, /Dora Leung visited Mount Isa\./);
});

await check("the gazetteer confirms only exact names, or the spellings it tries itself", async () => {
  const gazetteer = { Yarrabah: "Yarrabah", Dyirbal: "Dyirbal Creek", "Mt Garnet": "Mount Garnet" };
  const lookup = async (name) => (gazetteer[name] ? { matchedName: gazetteer[name] } : null);
  const confirmed = await confirmPlaces(["Yarrabah", "Dyirbal", "Mt Garnet", "Jambun"], lookup);
  assert.deepEqual([...confirmed], ["Yarrabah", "Mt Garnet"]);
});

await check("reuses an existing entity, creates the rest, links each once", () => {
  const crate = new ROCrate({ array: true, link: true });
  crate.addEntity({ "@id": "a.txt", "@type": "File", name: "a.txt", "custom:participant": "" });
  crate.addEntity({ "@id": "#dora_leung", "@type": "Person", name: "Dora Leung", description: "Described by hand" });
  const names = { people: ["Dora Leung", "John Smith"], places: ["Mount Isa"] };

  const counts = linkNamedEntities(crate, { "a.txt": names });
  assert.deepEqual(counts, { created: 2, reused: 1, links: 3 });
  assert.deepEqual(ids(crate.getProperty("a.txt", "custom:participant")), ["#dora_leung", "#john_smith"]);
  assert.deepEqual(ids(crate.getProperty("a.txt", "custom:place")), ["#place-mount-isa"]);
  assert.deepEqual([].concat(crate.getEntity("#dora_leung").description), ["Described by hand"], "the existing entity is kept as it was");
  assert.ok([].concat(crate.getEntity("#place-mount-isa")["@type"]).includes("Place"));
  assert.ok(crate.getEntity("arcp://name,custom/terms#place"), "custom:place is defined");

  assert.equal(linkNamedEntities(crate, { "a.txt": names }).links, 0, "a second run adds no duplicate links");
});

await check("a File new to the crate is added so it can be linked", () => {
  const crate = new ROCrate({ array: true, link: true });
  linkNamedEntities(crate, { "notes/new.txt": { people: ["Dora Leung"], places: [] } }, { "notes/new.txt": "new.txt" });
  assert.deepEqual([].concat(crate.getEntity("notes/new.txt").name), ["new.txt"]);
  assert.deepEqual(ids(crate.getProperty("notes/new.txt", "custom:participant")), ["#dora_leung"]);
});

await check("Process alone links the crate: files:prepare is the only tap", async () => {
  const plugin = REGISTRY["name-lookup"]({ readFileBytes: async () => null });
  assert.deepEqual(Object.keys(plugin.hooks), ["files:prepare"]);

  const handleFor = (bytes) => ({ getFile: async () => ({ arrayBuffer: async () => bytes.buffer }) });
  const crate = new ROCrate({ array: true, link: true });
  crate.addEntity({ "@id": "notes.txt", "@type": "File", name: "notes.txt" });
  const ctx = {
    options: { enableNameLookups: true, nameLookupGazetteer: false },
    crate,
    log: () => {},
    filesWithMeta: [
      { id: "notes.txt", relativePath: "notes.txt", fileName: "notes.txt", handle: handleFor(new TextEncoder().encode(TEXT)) },
      { id: "scan.pdf", relativePath: "scan.pdf", fileName: "scan.pdf", handle: handleFor(pdfWithText("Interview with Chloe Grant.")) },
      { id: "song.wav", relativePath: "song.wav", fileName: "song.wav" },
    ],
  };
  await plugin.hooks["files:prepare"].handler(ctx);
  assert.deepEqual(ids(crate.getProperty("notes.txt", "custom:participant")), ["#dora_leung", "#john_smith", "#mary_o_brien"]);
  assert.deepEqual(ids(crate.getProperty("notes.txt", "custom:place")), ["#place-mount-isa", "#place-queensland", "#place-palm-island"], "Yarrabah needs the gazetteer, which is off");
  assert.deepEqual(ids(crate.getProperty("scan.pdf", "custom:participant")), ["#chloe_grant"]);
  assert.equal(crate.getEntity("song.wav"), undefined);
});

await check("off by default; the gazetteer is on once the option is", () => {
  const plugin = REGISTRY["name-lookup"]({});
  assert.equal(plugin.optionSchema.default, false);
  assert.equal(plugin.optionSchema.children.find((c) => c.key === "nameLookupGazetteer").default, true);
  assert.equal(plugin.hooks["files:prepare"].activeWhen({ options: {} }), false);
});

if (failures) { console.log(`\n${failures} check(s) failed.`); process.exit(1); }
