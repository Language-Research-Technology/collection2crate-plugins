#!/usr/bin/env node
// Regenerates pronom-signatures.json (this folder) from the National
// Archives' official DROID/PRONOM signature file. Run with:
//   npm run update:pronom
//
// The DROID signature file is the *machine-readable* form PRONOM/DROID/
// siegfried actually match against at runtime — despite PRONOM's
// human-authoring signature syntax supporting wildcards (??), byte ranges
// ([xx:yy]), bitmasks ([&mask]) and alternation ((a|b)), none of that
// appears in the compiled XML: every <Sequence> is plain hex. Wildcards/
// ranges/alternation are pre-compiled into chains of fixed hex blocks
// (SubSequence / LeftFragment / RightFragment), each carrying its own
// min/max offset gap from the previous one. That's what this script
// converts into the compact JSON matcher.js reads — see this folder's
// matcher.js for the matching algorithm that consumes it.
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { XMLParser } from "fast-xml-parser";

const SIGNATURE_FILE_VERSION = process.argv[2] || "124";
const SOURCE_URL = `https://cdn.nationalarchives.gov.uk/documents/DROID_SignatureFile_V${SIGNATURE_FILE_VERSION}.xml`;
const OUTPUT_PATH = fileURLToPath(new URL("./pronom-signatures.json", import.meta.url));

// Tags that may repeat and must always come back as an array, even when
// there's exactly one — fast-xml-parser otherwise hands back a bare object
// for a single occurrence, which would silently break every consumer that
// assumes an array.
const ALWAYS_ARRAY = new Set([
  "InternalSignature", "ByteSequence", "SubSequence", "LeftFragment", "RightFragment",
  "FileFormat", "InternalSignatureID", "HasPriorityOverFileFormatID", "Extension",
]);

function toArray(v) {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

// An offset attribute absent from the XML means "unbounded" for a Max, and
// 0 for a Min (DROID's own default). Keep "unbounded" as null rather than
// some sentinel number, so matcher.js can tell "no upper bound" apart from
// "bounded at a real number" without a magic-number convention leaking
// across the two modules.
function intOrNull(v) {
  return v === undefined ? null : Number(v);
}
function intOrZero(v) {
  return v === undefined ? 0 : Number(v);
}

// A SubSequence/fragment's <Sequence> (or LeftFragment/RightFragment text)
// is already plain hex — just lowercase it for a consistent bundle.
function hex(v) {
  return String(v ?? "").toLowerCase();
}

// LeftFragment/RightFragment elements sharing a Position are alternatives
// (OR — the compiled form of "(a|b|c)" alternation); increasing Position
// chains further outward from the core Sequence (AND). Group them into
// outward-ordered slots of alternatives.
function groupFragmentsByPosition(fragments) {
  const byPosition = new Map();
  for (const f of fragments) {
    const pos = Number(f["@_Position"]);
    const alt = { seq: hex(f["#text"]), lo: intOrZero(f["@_MinOffset"]), hi: intOrNull(f["@_MaxOffset"]) };
    if (!byPosition.has(pos)) byPosition.set(pos, []);
    byPosition.get(pos).push(alt);
  }
  return [...byPosition.keys()].sort((a, b) => a - b).map((pos) => byPosition.get(pos));
}

function convertSubSequence(sub) {
  return {
    seq: hex(sub.Sequence),
    gLo: intOrZero(sub["@_SubSeqMinOffset"]),
    gHi: intOrNull(sub["@_SubSeqMaxOffset"]),
    left: groupFragmentsByPosition(toArray(sub.LeftFragment)),
    right: groupFragmentsByPosition(toArray(sub.RightFragment)),
  };
}

function convertByteSequence(bs) {
  const ref = bs["@_Reference"] === "BOFoffset" ? "B" : bs["@_Reference"] === "EOFoffset" ? "E" : "V";
  return { ref, sub: toArray(bs.SubSequence).map(convertSubSequence) };
}

// Largest gap a search window will ever need to cover, from its anchor
// (BOF/EOF) — used to size how many head/tail bytes matcher.js reads per
// file, so it never has to pull a whole large media file into memory just
// to sniff its format. A subsequence chain's total reach is the sum of
// every subsequence's own sequence length + its max gap (fragments extend
// a little further still, but never past the subsequence chain's own
// span in practice) — walk the chain rather than just taking the first
// subsequence's offset, since later subsequences in a chain can still be
// unbounded (gHi: null) or push well past the first one's window.
function byteSequenceReach(byteSeq) {
  let reach = 0;
  for (const s of byteSeq.sub) {
    if (s.gHi === null) return null; // unbounded — caller falls back to a fixed cap
    reach += s.gHi + s.seq.length / 2;
    for (const slot of [...s.left, ...s.right]) {
      for (const alt of slot) {
        if (alt.hi === null) return null;
        reach = Math.max(reach, reach + alt.hi + alt.seq.length / 2);
      }
    }
  }
  return reach;
}

async function main() {
  console.log(`Downloading ${SOURCE_URL} ...`);
  const res = await fetch(SOURCE_URL);
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  const xml = await res.text();
  console.log(`Downloaded ${(xml.length / 1024 / 1024).toFixed(2)}MB, parsing...`);

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    textNodeName: "#text",
    isArray: (name) => ALWAYS_ARRAY.has(name),
    // Critical: without this, fast-xml-parser coerces numeric-looking tag
    // text to a JS number (e.g. <Sequence>00</Sequence> -> 0, silently
    // dropping the leading zero and turning a 1-byte hex sequence into a
    // meaningless single hex digit). Attribute values are left alone —
    // Position/MinOffset/etc are genuinely meant to be numbers there.
    parseTagValue: false,
  });
  const doc = parser.parse(xml);
  const root = doc.FFSignatureFile;
  const version = String(root["@_Version"]);

  const internalSignatures = toArray(root.InternalSignatureCollection.InternalSignature);
  const signatures = {};
  for (const sig of internalSignatures) {
    signatures[sig["@_ID"]] = toArray(sig.ByteSequence).map(convertByteSequence);
  }

  const fileFormats = toArray(root.FileFormatCollection.FileFormat);
  const formats = fileFormats.map((ff) => ({
    id: Number(ff["@_ID"]),
    puid: ff["@_PUID"],
    name: ff["@_Name"],
    mime: ff["@_MIMEType"] || null,
    sig: toArray(ff.InternalSignatureID).map((v) => String(v)),
    priorityOver: toArray(ff.HasPriorityOverFileFormatID).map((v) => Number(v)),
    // Extension-based identification is DROID's own lower-confidence
    // fallback tier (used only when byte-signature matching finds
    // nothing — see matcher.js) — most formats DROID can't fingerprint by
    // content at all (plain text chief among them) still have one or more
    // known extensions on record here.
    exts: toArray(ff.Extension).map((v) => String(v).toLowerCase()),
  }));

  // Sizing for matcher.js's head/tail reads: the largest bounded reach
  // across all BOF signatures (head window) and all EOF signatures (tail
  // window). An unbounded chain (gHi: null anywhere) falls back to a fixed
  // cap — 256KB is comfortably past every bounded reach actually observed
  // in the registry (the largest, ZIP's EOF end-of-central-directory
  // search, is ~64KB for the standard comment-field allowance).
  const FALLBACK_WINDOW = 256 * 1024;
  let headWindow = 0;
  let tailWindow = 0;
  for (const byteSeqs of Object.values(signatures)) {
    for (const bs of byteSeqs) {
      const reach = byteSequenceReach(bs);
      const bounded = reach === null ? FALLBACK_WINDOW : reach;
      if (bs.ref === "B" || bs.ref === "V") headWindow = Math.max(headWindow, bounded);
      if (bs.ref === "E") tailWindow = Math.max(tailWindow, bounded);
    }
  }
  // A little margin past the exact computed reach for safety.
  headWindow = Math.ceil(headWindow * 1.1);
  tailWindow = Math.ceil(tailWindow * 1.1);

  const out = { version, headWindow, tailWindow, formats, signatures };
  await writeFile(OUTPUT_PATH, JSON.stringify(out));
  console.log(`Wrote ${OUTPUT_PATH}`);
  console.log(`  ${formats.length} formats, ${Object.keys(signatures).length} internal signatures`);
  console.log(`  headWindow=${headWindow}B tailWindow=${tailWindow}B`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
