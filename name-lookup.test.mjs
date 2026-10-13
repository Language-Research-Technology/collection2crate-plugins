// name-lookup: people and places found in a file's text by named entity
// recognition, then linked from the File — reusing an entity the crate already
// holds under the name's @id, creating one otherwise. The whole Process →
// Build round trip runs here against a stub folder.
//
//   node name-lookup.test.mjs
import assert from "node:assert/strict";
import { ROCrate } from "ro-crate";
import { REGISTRY } from "./index.js";
import { nameToId, linkNamedEntities } from "./plugins/name-lookup/index.js";
import { extractNames, fileText, isReadableForNames } from "./plugins/name-lookup/extract.js";

let failures = 0;
const check = async (label, fn) => {
  try { await fn(); console.log(`  ok   ${label}`); }
  catch (e) { failures++; console.log(`  FAIL ${label}\n       ${e.message}`); }
};
const ids = (value) => (Array.isArray(value) ? value : [value]).map((v) => v?.["@id"] ?? v);

const TEXT = "Dora Leung recorded this with John Smith's family at Mount Isa. " +
  "Later, Mrs. Mary O'Brien travelled to Queensland and Palm Island.";

console.log("name-lookup");

await check("@id is # plus the name, spaces as underscores", () => {
  assert.equal(nameToId("John Smith"), "#John_Smith");
  assert.equal(nameToId(" Mount  Isa "), "#Mount_Isa");
});

await check("finds people and places, without honorifics, possessives or trailing punctuation", () => {
  const { people, places } = extractNames(TEXT);
  assert.deepEqual(people, ["Dora Leung", "John Smith", "Mary O'Brien"]);
  assert.deepEqual(places, ["Mount Isa", "Queensland", "Palm Island"]);
});

await check("reads .txt, .md and .docx only", async () => {
  assert.ok(isReadableForNames("notes.txt") && isReadableForNames("a/b.MD") && isReadableForNames("x.docx"));
  assert.ok(!isReadableForNames("song.wav") && !isReadableForNames("sheet.xlsx"));
  assert.equal(await fileText(new TextEncoder().encode("Hello Dora"), "a.txt"), "Hello Dora");
});

await check("reuses an existing entity, creates the rest, links each once", () => {
  const crate = new ROCrate({ array: true, link: true });
  crate.addEntity({ "@id": "a.txt", "@type": "File", name: "a.txt", "custom:participant": "" });
  crate.addEntity({ "@id": "#Dora_Leung", "@type": "Person", name: "Dora Leung", description: "From merge" });
  const names = { people: ["Dora Leung", "John Smith"], places: ["Mount Isa"] };

  const counts = linkNamedEntities(crate, { "a.txt": names, "gone.txt": names });
  assert.deepEqual(counts, { created: 2, reused: 1, links: 3 });
  assert.deepEqual(ids(crate.getProperty("a.txt", "custom:participant")), ["#Dora_Leung", "#John_Smith"]);
  assert.deepEqual(ids(crate.getProperty("a.txt", "custom:place")), ["#Mount_Isa"]);
  assert.deepEqual([].concat(crate.getEntity("#Dora_Leung").description), ["From merge"], "the existing entity is kept as it was");
  assert.ok([].concat(crate.getEntity("#Mount_Isa")["@type"]).includes("Place"));
  assert.ok(crate.getEntity("arcp://name,custom/terms#place"), "custom:place is defined");

  assert.equal(linkNamedEntities(crate, { "a.txt": names }).links, 0, "a second build adds no duplicate links");
});

await check("Process then Build: files:prepare finds names, crate:build links them", async () => {
  const plugin = REGISTRY["name-lookup"]({ readFileBytes: async () => null });
  const bytes = new TextEncoder().encode(TEXT);
  const crate = new ROCrate({ array: true, link: true });
  crate.addEntity({ "@id": "notes.txt", "@type": "File", name: "notes.txt" });
  const ctx = {
    options: { enableNameLookups: true },
    crate,
    log: () => {},
    filesWithMeta: [
      { id: "notes.txt", relativePath: "notes.txt", fileName: "notes.txt", handle: { getFile: async () => ({ arrayBuffer: async () => bytes.buffer }) } },
      { id: "song.wav", relativePath: "song.wav", fileName: "song.wav" },
    ],
  };
  await plugin.hooks["files:prepare"].handler(ctx);
  assert.deepEqual(Object.keys(ctx.namesByFile), ["notes.txt"]);
  await plugin.hooks["crate:build"].handler(ctx);
  assert.deepEqual(ids(crate.getProperty("notes.txt", "custom:participant")), ["#Dora_Leung", "#John_Smith", "#Mary_O'Brien"]);
  assert.deepEqual(ids(crate.getProperty("notes.txt", "custom:place")), ["#Mount_Isa", "#Queensland", "#Palm_Island"]);
});

await check("off by default", () => {
  const plugin = REGISTRY["name-lookup"]({});
  assert.equal(plugin.optionSchema.default, false);
  assert.equal(plugin.hooks["files:prepare"].activeWhen({ options: {} }), false);
});

if (failures) { console.log(`\n${failures} check(s) failed.`); process.exit(1); }
