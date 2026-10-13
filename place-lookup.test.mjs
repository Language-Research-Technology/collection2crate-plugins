// The GA/GHAP place lookup shared by merge and name-lookup: how it asks
// TLCMap's GHAP search API, and how it reads the answer. Offline — fetch is
// a stub that records what was asked and answers from a table.
//
//   node place-lookup.test.mjs
import assert from "node:assert/strict";
import { ROCrate } from "ro-crate";
import ExcelJS from "exceljs";
import { createPlaceLookupService } from "./src/_place_lookup.js";
import { REGISTRY } from "./index.js";

let failures = 0;
const check = async (label, fn) => {
  try { await fn(); console.log(`  ok   ${label}`); }
  catch (e) { failures++; console.log(`  FAIL ${label}\n       ${e.message}`); }
};

// One GeoJSON Feature as TLCMap's /api returns it: coordinates in the
// geometry, everything else (name, state, feature_term) in properties.
const feature = (name, state, feature_term, longitude, latitude) => ({
  type: "Feature",
  geometry: { type: "Point", coordinates: [longitude, latitude] },
  properties: { name, placename: name, state, feature_term, latitude: String(latitude), longitude: String(longitude) },
});

const TLCMAP = {
  "name=Cairns": [
    feature("Cairns", "VIC", "monument", 144.9, -38.4),
    feature("Cairns", "QLD", "county", 148.25, -22.6),
    feature("Cairns", "QLD", "populated place", 145.78, -16.92),
  ],
  "containsname=Murray Upp": [feature("Murray Upper", "QLD", "locality", 145.8, -18.12)],
};

const asked = [];
async function withStubFetch(ga, fn) {
  const realFetch = globalThis.fetch;
  asked.length = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    asked.push(url);
    let body = { features: [] };
    if (url.hostname === "tlcmap.org") {
      const [param] = ["name", "containsname"].filter((p) => url.searchParams.has(p));
      body = { type: "FeatureCollection", features: TLCMAP[`${param}=${url.searchParams.get(param)}`] || [] };
    } else if (url.hostname.endsWith("ga.gov.au")) {
      body = { features: (ga || []).map((attributes) => ({ attributes })) };
    }
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  };
  try { return await fn(); } finally { globalThis.fetch = realFetch; }
}

console.log("place lookup");

await check("GHAP asks TLCMap's /api for JSON by exact name", () => withStubFetch(null, async () => {
  const match = await createPlaceLookupService({ providers: ["ghap"] }).lookup("Cairns");
  const [first] = asked;
  assert.equal(`${first.origin}${first.pathname}`, "https://tlcmap.org/api");
  assert.equal(first.searchParams.get("format"), "json");
  assert.equal(first.searchParams.get("name"), "Cairns");
  assert.equal(asked.length, 1, "an exact match needs no second search");
  assert.equal(match.provider, "ghap");
  assert.deepEqual([match.latitude, match.longitude], [-16.92, 145.78], "the populated place, not the county or the monument");
}));

await check("GHAP falls back to names containing it, unless exactOnly", () => withStubFetch(null, async () => {
  const fuzzy = await createPlaceLookupService({ providers: ["ghap"] }).lookup("Murray Upp");
  assert.equal(fuzzy.matchedName, "Murray Upper");
  assert.deepEqual(asked.map((u) => [...u.searchParams.keys()].find((k) => k.endsWith("name"))), ["name", "containsname"]);

  const exact = await createPlaceLookupService({ providers: ["ghap"], ghap: { exactOnly: true } }).lookup("Murray Upp");
  assert.equal(exact, null);
  assert.ok(!asked.slice(2).some((u) => u.searchParams.has("containsname")), "exactOnly never searches by containsname");
}));

await check("GHAP reads the region from a feature's state", () => withStubFetch(null, async () => {
  const match = await createPlaceLookupService({ providers: ["ghap"], placeMatchRegion: "VIC" }).lookup("Cairns");
  assert.deepEqual([match.latitude, match.longitude], [-38.4, 144.9]);
}));

await check("GHAP is asked only when GA has no match", () => withStubFetch(
  [{ name: "Cairns", latitude: -16.9, longitude: 145.7, authority: "QLD", category: "POPULATED PLACE" }],
  async () => {
    const match = await createPlaceLookupService({}).lookup("Cairns");
    assert.equal(match.provider, "geoscience-australia");
    assert.ok(!asked.some((u) => u.hostname === "tlcmap.org"));
  },
));

await check("exactOnly for the whole service keeps every provider to exact names", () => withStubFetch(null, async () => {
  const match = await createPlaceLookupService({ exactOnly: true }).lookup("Murray Upp");
  assert.equal(match, null);
  assert.ok(!asked.some((u) => u.searchParams.has("containsname")), "no GHAP containsname search");
  assert.ok(!asked.some((u) => /like/i.test(u.searchParams.get("where") || "")), "no GA starts-with search");
}));

// merge's "Exact place names only" (placeExactOnly), through its own Build tap.
async function mergePlace(options) {
  const book = new ExcelJS.Workbook();
  book.addWorksheet("Files").addRows([["@id", ".location"], ["a.txt", "Murray Upp"]]);
  const bytes = await book.xlsx.writeBuffer();
  const crate = new ROCrate({ array: true, link: true });
  crate.addEntity({ "@id": "a.txt", "@type": "File", name: "a.txt" });
  const plugin = REGISTRY.merge({ readJsonFromFolder: async () => null, graphEntityById: (c, id) => c.getEntity(id) });
  await plugin.hooks["crate:build"].handler({
    crate, dirHandle: {}, log: () => {},
    options: { merge: true, mergeUpload: { name: "m.xlsx", file: { arrayBuffer: async () => bytes } }, ...options },
  });
  return crate.getEntity("#place-murray-upp");
}

await check("merge: partial matches by default, exact only when placeExactOnly is on", () => withStubFetch(null, async () => {
  const partial = await mergePlace({});
  assert.deepEqual([].concat(partial.geo).map((g) => g["@id"]), ["#location-murray-upp"], "Murray Upper's coordinates");
  const exact = await mergePlace({ placeExactOnly: true });
  assert.equal([].concat(exact.geo ?? []).length, 0, "no coordinates without an exact name");
}));

if (failures) { console.log(`\n${failures} check(s) failed.`); process.exit(1); }
