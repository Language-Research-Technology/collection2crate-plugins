// Matches this repo's plain-node-assert test style (see chaos2crate's
// tests/test-*.mjs) — no framework needed for a handful of fixture checks.
// Run with: node src/file-format-identify/matcher.test.mjs
import assert from "node:assert/strict";
import { identifyBuffers, identifyByExtension } from "./matcher.js";

function hex(str) {
  const bytes = new Uint8Array(str.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(str.substr(i * 2, 2), 16);
  return bytes;
}
function concat(...arrs) {
  const len = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
function pad(n, byte = 0x20) { return new Uint8Array(n).fill(byte); }

function identify(bytes) {
  // Mirrors how identifyAllFormats slices a file: a head window and a tail
  // window, both drawn from the same buffer here since fixtures are tiny.
  return identifyBuffers(bytes, bytes);
}

// TIFF (little-endian): exact 4-byte BOF signature, no fragments.
{
  const bytes = concat(hex("49492a00"), pad(20));
  const result = identify(bytes);
  assert.equal(result?.puid, "fmt/353", "TIFF little-endian");
}

// GIF89a: BOF literal + EOF trailer within a 4-byte window.
{
  const bytes = concat(hex("474946383961"), pad(50), hex("3b"));
  const result = identify(bytes);
  assert.equal(result?.puid, "fmt/4", "GIF89a");
}

// GIF89a with EOF trailer just past the allowed window should NOT match.
{
  const bytes = concat(hex("474946383961"), pad(50), hex("3b"), pad(10));
  const result = identify(bytes);
  assert.notEqual(result?.puid, "fmt/4", "GIF89a trailer outside window must not match");
}

// JPEG/JFIF: core "JFIF\0\x01\x00" with a LeftFragment (FFD8FFE0, exactly
// 2 bytes before it) and a RightFragment alternative ("00"/"01"/"02",
// exactly at core's end) — exercises the anchor-side-fragment path in
// matchSubSequence, not just the simple no-fragment case above.
{
  // The byte right after "JFIF\0\x01\x00" (here 0x01, a JFIF density-units
  // value) is itself part of the signature — RightFragment requires it to
  // be 0x00/0x01/0x02 — so it isn't just arbitrary padding.
  const bytes = concat(hex("ffd8ffe0"), hex("0010"), hex("4a464946000100"), hex("01"), pad(30), hex("ffd9"));
  const result = identify(bytes);
  assert.equal(result?.puid, "fmt/42", "JPEG/JFIF (left+right fragment chain)");
}

// A bare JFIF core sequence with the WRONG left fragment 2 bytes before it
// must not match fmt/42 — proves the fragment constraint is actually
// enforced, not just skipped.
{
  const bytes = concat(hex("00000000"), hex("0010"), hex("4a464946000100"), hex("01"), pad(30), hex("ffd9"));
  const result = identify(bytes);
  assert.notEqual(result?.puid, "fmt/42", "JPEG without its left fragment must not match");
}

// ZIP-based Office disambiguation: a bare PK\x03\x04 zip with no Office
// marker identifies as generic ZIP; one with word/document.xml identifies
// as docx specifically.
{
  const bareZip = concat(hex("504b0304"), pad(100));
  const result = identify(bareZip);
  assert.equal(result?.puid, "x-fmt/263", "bare ZIP");
}
{
  const docx = concat(hex("504b0304"), pad(20), Buffer.from("word/document.xml"), pad(80));
  const result = identify(docx);
  assert.equal(result?.puid, "fmt/412", "docx via zip-internal-path heuristic");
}
{
  const xlsx = concat(hex("504b0304"), pad(20), Buffer.from("xl/workbook.xml"), pad(80));
  const result = identify(xlsx);
  assert.equal(result?.puid, "fmt/214", "xlsx via zip-internal-path heuristic");
}

// Unidentifiable content (no signature matches anything).
{
  const bytes = pad(40, 0x41);
  const result = identify(bytes);
  assert.equal(result, null, "unrecognized content stays unidentified");
}

// Extension fallback: PRONOM has no byte signature at all for plain text
// (x-fmt/111), so a .txt file only resolves via the extension tier — and
// is tagged as such rather than looking like a verified content match.
{
  const result = identifyByExtension("field-notes.txt");
  assert.equal(result?.puid, "x-fmt/111", "plain text resolves via extension fallback");
  assert.equal(result?.method, "extension", "extension-fallback results are tagged, not confused with content matches");
}

// A genuinely ambiguous extension (several signature-less legacy ".doc"
// variants share it) must NOT guess — proves the fallback only fires when
// exactly one signature-less format claims the extension.
{
  const result = identifyByExtension("old-manuscript.doc");
  assert.equal(result, null, "ambiguous extension is left unidentified rather than guessed");
}

// An extension shared with a signature-*bearing* format (fmt/18 "Acrobat
// PDF 1.4" also lists "csv" nowhere, but check a real case: "csv" only
// has one claimant, x-fmt/18, with no signature) still resolves cleanly.
{
  const result = identifyByExtension("wordlist.csv");
  assert.equal(result?.puid, "x-fmt/18", "unambiguous extension resolves");
}

// A file with no extension at all must not throw or false-match.
{
  const result = identifyByExtension("README");
  assert.equal(result, null, "extensionless filename yields no fallback match");
}

console.log("All file-format-identify matcher tests passed.");
