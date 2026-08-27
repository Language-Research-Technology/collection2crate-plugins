// Offline PRONOM file-format identification (content/byte-signature based),
// against a bundled copy of the official DROID signature registry
// (pronom-signatures.json, this folder — refresh with `npm run update:pronom`,
// see update-signatures.mjs for where it comes from). The compiled registry
// needs no wildcard/regex support for a SubSequence's own core <Sequence> —
// those are always plain hex — but LeftFragment/RightFragment values can
// still carry PRONOM's per-byte range/negation syntax (e.g. "[30:39]" a
// digit, "[!00]" not a null byte, "[!&01]" a bitmask exclusion) alongside
// plain hex bytes, so needles are compiled into a small matcher list rather
// than assumed to always be literal bytes — see compileNeedle() below.
//
// readFileBytesFromDirectory is a chaos2crate core function, injected once
// via configure() rather than imported by relative path — called from
// file-format-identify/index.js's createPlugin(deps) before this module's
// exports are used. See this repo's README.
let readFileBytesFromDirectory;
export function configure(deps) {
  ({ readFileBytesFromDirectory } = deps);
}

import PRONOM_DATA from "./pronom-signatures.json" with { type: "json" };

/* ---------- needle compilation ----------
 * A needle is { len, bytes } for the common case (pure literal hex — the
 * overwhelming majority of sequences and fragments) so matching stays a
 * tight byte-for-byte loop, or { len, matchers } for the rare (~3% of
 * fragment values in the registry) case that uses PRONOM's per-byte
 * range/negation syntax within a fragment string:
 *   "3032" -> two literal bytes (0x30, 0x32)
 *   "[30:39]" -> one byte, inclusive range 0x30-0x39
 *   "[!00]" / "[!4001c800...]" -> one-or-more literal bytes, NOT equal
 *   "[!&01]" -> one byte, NOT matching bitmask 0x01 (byte & mask !== mask)
 * Cached — the same hex/fragment string recurs constantly across the
 * registry's ~2.5k signatures. */
const needleCache = new Map();
function compileNeedle(hex) {
  let needle = needleCache.get(hex);
  if (needle) return needle;
  if (!hex.includes("[")) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    needle = { len: bytes.length, bytes };
  } else {
    const matchers = [];
    let i = 0;
    while (i < hex.length) {
      if (hex[i] === "[") {
        const end = hex.indexOf("]", i);
        const inner = hex.slice(i + 1, end);
        if (inner.startsWith("!&")) matchers.push({ type: "nmask", mask: parseInt(inner.slice(2), 16) });
        else if (inner.startsWith("!")) {
          const lit = inner.slice(1);
          const bytes = new Uint8Array(lit.length / 2);
          for (let j = 0; j < bytes.length; j++) bytes[j] = parseInt(lit.substr(j * 2, 2), 16);
          matchers.push({ type: "nlit", bytes });
        } else {
          const [lo, hi] = inner.split(":");
          matchers.push({ type: "range", lo: parseInt(lo, 16), hi: parseInt(hi, 16) });
        }
        i = end + 1;
      } else {
        matchers.push({ type: "byte", value: parseInt(hex.substr(i, 2), 16) });
        i += 2;
      }
    }
    const len = matchers.reduce((n, m) => n + (m.type === "nlit" ? m.bytes.length : 1), 0);
    needle = { len, matchers };
  }
  needleCache.set(hex, needle);
  return needle;
}

const reversedNeedleCache = new Map();
function reverseNeedle(needle) {
  let rev = reversedNeedleCache.get(needle);
  if (rev) return rev;
  if (needle.bytes) {
    const bytes = new Uint8Array(needle.len);
    for (let i = 0; i < needle.len; i++) bytes[i] = needle.bytes[needle.len - 1 - i];
    rev = { len: needle.len, bytes };
  } else {
    // Matcher order reverses; a multi-byte inverted-literal's own bytes
    // reverse too (single-byte matchers — range/mask/1-byte-nlit — are
    // order-invariant internally).
    const matchers = needle.matchers.slice().reverse().map((m) => {
      if (m.type === "nlit" && m.bytes.length > 1) {
        const bytes = new Uint8Array(m.bytes.length);
        for (let i = 0; i < bytes.length; i++) bytes[i] = m.bytes[m.bytes.length - 1 - i];
        return { type: "nlit", bytes };
      }
      return m;
    });
    rev = { len: needle.len, matchers };
  }
  reversedNeedleCache.set(needle, rev);
  return rev;
}

function reverseBytes(bytes) {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes[bytes.length - 1 - i];
  return out;
}

function testNeedleAt(buf, offset, needle) {
  if (offset < 0 || offset + needle.len > buf.length) return false;
  if (needle.bytes) {
    for (let i = 0; i < needle.len; i++) if (buf[offset + i] !== needle.bytes[i]) return false;
    return true;
  }
  let pos = offset;
  for (const m of needle.matchers) {
    switch (m.type) {
      case "byte": if (buf[pos] !== m.value) return false; pos += 1; break;
      case "range": if (buf[pos] < m.lo || buf[pos] > m.hi) return false; pos += 1; break;
      case "nmask": if ((buf[pos] & m.mask) === m.mask) return false; pos += 1; break;
      case "nlit": {
        let equal = true;
        for (let i = 0; i < m.bytes.length; i++) if (buf[pos + i] !== m.bytes[i]) { equal = false; break; }
        if (equal) return false;
        pos += m.bytes.length;
        break;
      }
    }
  }
  return true;
}

/* ---------- normalizing EOF ByteSequences into the same shape as BOF ----------
 * DROID's compiled signature keeps EOF ByteSequences in ordinary (BOF-style)
 * byte order — Reference="EOFoffset" just means "anchor this to the file's
 * end", not "bytes are reversed." Rather than writing a second, mirror-image
 * copy of the whole matching algorithm below for the EOF direction, an EOF
 * ByteSequence is matched by reversing the *tail buffer itself* and every
 * needle it matches against, and swapping which side ("left"/anchor-side vs
 * "right"/far-side) plays which role — reversing flips which physical
 * direction is which, so what was file-left (toward BOF) becomes the
 * far-from-EOF-anchor side after reversal, and vice versa. Matching then
 * proceeds exactly as for a BOF ByteSequence, just against the reversed
 * buffer. Memoized per ByteSequence object (the bundled JSON is a stable
 * singleton) since reversing every needle on every file would be wasted work.
 */
const reversedCache = new WeakMap();
function reverseSlot(slot) {
  return slot.map((alt) => ({ needle: reverseNeedle(compileNeedle(alt.seq)), lo: alt.lo, hi: alt.hi }));
}
function forwardSlot(slot) {
  return slot.map((alt) => ({ needle: compileNeedle(alt.seq), lo: alt.lo, hi: alt.hi }));
}
function toReversedView(bs) {
  let view = reversedCache.get(bs);
  if (view) return view;
  view = {
    sub: bs.sub.map((s) => ({
      needle: reverseNeedle(compileNeedle(s.seq)),
      gLo: s.gLo, gHi: s.gHi,
      // swapped: left (BOF-ward) <-> right (EOF-ward) flips under reversal
      anchorSlots: s.right.map(reverseSlot),
      farSlots: s.left.map(reverseSlot),
    })),
  };
  reversedCache.set(bs, view);
  return view;
}
function toForwardView(bs) {
  let view = reversedCache.get(bs); // reuse the same WeakMap, different shape, never both for one bs
  if (view) return view;
  view = {
    sub: bs.sub.map((s) => ({
      needle: compileNeedle(s.seq),
      gLo: s.gLo, gHi: s.gHi,
      anchorSlots: s.left.map(forwardSlot),
      farSlots: s.right.map(forwardSlot),
    })),
  };
  reversedCache.set(bs, view);
  return view;
}

/* ---------- forward-only matching primitives ----------
 * Every search below moves in one direction only: increasing index. `anchor`
 * is the offset a gap window is measured from (0, or the previous
 * subsequence/fragment's edge); gHi === null means unbounded (capped by the
 * buffer). When gLo === gHi (by far the common case — most signatures anchor
 * at an exact offset, not a real search window) this is a single O(seqLen)
 * compare rather than an O(window) scan. */
function findForward(buf, anchor, gLo, gHi, needle) {
  const lo = anchor + gLo;
  const hi = gHi === null ? buf.length - needle.len : Math.min(anchor + gHi, buf.length - needle.len);
  if (gHi !== null && lo === hi) return testNeedleAt(buf, lo, needle) ? lo : -1;
  for (let pos = lo; pos <= hi; pos++) if (testNeedleAt(buf, pos, needle)) return pos;
  return -1;
}
// Every occurrence of needle within [lo,hi] — only used for the minority of
// subsequences that carry anchor-side fragments (see matchSubSequence): the
// core sequence's own position isn't directly gap-bound in that case (the
// gap constraint applies to the outermost fragment instead — see the design
// note on matchSubSequence), so it's found by search and each candidate
// verified against the fragment chain. Still bounded, not a full-buffer
// scan — every anchor-fragment chain actually in the registry spans at most
// a few dozen bytes, so ANCHOR_FRAGMENT_MARGIN past the subsequence's own
// window is enormously generous while keeping a match attempt against
// unrelated content (a whole buffer with no real match anywhere) from
// costing a full O(buffer length) scan per signature.
const ANCHOR_FRAGMENT_MARGIN = 4096;
function findAllForward(buf, lo, hi, needle) {
  const out = [];
  const last = Math.min(hi, buf.length - needle.len);
  for (let pos = Math.max(0, lo); pos <= last; pos++) if (testNeedleAt(buf, pos, needle)) out.push(pos);
  return out;
}

// Walk a chain of fragment slots outward from `edge` (increasing index),
// each within its own [lo,hi] gap window from the previous slot's end (OR
// across alternatives within one slot — the compiled form of "(a|b|c)"
// alternation). Returns the final edge (end of the outermost slot matched),
// or null.
function walkSlotsForward(buf, edge, slots) {
  for (const slot of slots) {
    let matched = null;
    for (const alt of slot) {
      const start = findForward(buf, edge, alt.lo, alt.hi, alt.needle);
      if (start >= 0) { matched = start + alt.needle.len; break; }
    }
    if (matched === null) return null;
    edge = matched;
  }
  return edge;
}

/* ---------- one SubSequence ----------
 * A SubSequence is [outermost anchor-side fragment, ..., innermost
 * anchor-side fragment, core sequence, innermost far-side fragment, ...,
 * outermost far-side fragment] — "anchor-side" being the side the
 * SubSequence-level gLo/gHi actually pins (BOF-ward for a BOF ByteSequence,
 * which is the "left" fragments; EOF-ward for an EOF one, its "right"
 * fragments before the reversal in toReversedView() swaps them onto `left`).
 * Each fragment's own [lo,hi] governs its gap to its immediate *inward*
 * neighbor (the next fragment toward core, or core itself) — confirmed
 * against siegfried's own DROID-signature compiler (pkg/pronom/parse.go,
 * appendFragments): this holds for both anchor-side and far-side fragments
 * alike. The SubSequence-level gLo/gHi is a *separate, additional*
 * constraint that only pins the outermost anchor-side fragment (or core
 * directly, when there are no anchor-side fragments — the common case, e.g.
 * a bare "must start at file offset 0" signature has no fragments at all).
 *
 * When anchor-side fragments exist, core's own position isn't directly
 * gap-bound by anything — so it's found by unconstrained search within the
 * buffer, and each candidate verified by walking the anchor-side chain
 * outward from it and checking the resulting outermost edge against
 * gLo/gHi. This is the minority path (most signatures have no fragments,
 * or only far-side ones, both of which skip straight to the fast
 * exact/windowed core search below).
 */
function matchSubSequence(buf, anchor, sub) {
  if (sub.anchorSlots.length === 0) {
    const start = findForward(buf, anchor, sub.gLo, sub.gHi, sub.needle);
    if (start < 0) return null;
    const farEdge = walkSlotsForward(buf, start + sub.needle.len, sub.farSlots);
    return farEdge === null ? null : farEdge;
  }
  const scanLo = anchor + sub.gLo;
  const scanHi = (sub.gHi === null ? buf.length : anchor + sub.gHi) + ANCHOR_FRAGMENT_MARGIN;
  for (const coreStart of findAllForward(buf, scanLo, scanHi, sub.needle)) {
    // Anchor-side fragments sit before core (smaller indices) — walked by
    // matchAnchorChainBackward, not the forward-only walkSlotsForward used
    // everywhere else in this file (see that function's own comment).
    const anchorEdge = matchAnchorChainBackward(buf, coreStart, sub.anchorSlots);
    if (anchorEdge === null) continue;
    if (anchorEdge < anchor + sub.gLo) continue;
    if (sub.gHi !== null && anchorEdge > anchor + sub.gHi) continue;
    const farEdge = walkSlotsForward(buf, coreStart + sub.needle.len, sub.farSlots);
    if (farEdge === null) continue;
    return farEdge;
  }
  return null;
}

// Anchor-side fragments sit *before* core (smaller indices) — walk from
// core's start toward smaller indices, one slot at a time (innermost first,
// i.e. index 0, same order as the stored array — matching walkSlotsForward's
// "index 0 first" convention, just searching the opposite way), each within
// its own [lo,hi] gap from the previous (more inward) edge. Returns the
// *start* of the outermost slot matched (what the SubSequence-level gLo/gHi
// is checked against), or null.
function matchAnchorChainBackward(buf, coreStart, anchorSlots) {
  let edge = coreStart;
  for (const slot of anchorSlots) {
    let matched = null;
    for (const alt of slot) {
      const hiEnd = edge - alt.lo;
      const loEnd = alt.hi === null ? alt.needle.len : Math.max(edge - alt.hi, alt.needle.len);
      for (let end = hiEnd; end >= loEnd; end--) {
        if (testNeedleAt(buf, end - alt.needle.len, alt.needle)) { matched = end - alt.needle.len; break; }
      }
      if (matched !== null) break;
    }
    if (matched === null) return null;
    edge = matched;
  }
  return edge;
}

/* ---------- one ByteSequence (all its SubSequences, chained in order) ----------
 * `buffers` is { headBuf, tailBuf, revTailBuf } — revTailBuf (the tail
 * window reversed once) is precomputed per *file*, not per signature
 * attempted, since reversing it fresh for every EOF-referenced signature
 * checked (there are hundreds) would repeat the same O(tailWindow) work for
 * no reason. */
function matchByteSequence(bs, buffers) {
  const isEof = bs.ref === "E";
  const buf = isEof ? buffers.revTailBuf : buffers.headBuf;
  if (!buf || buf.length === 0) return false;
  const view = isEof ? toReversedView(bs) : toForwardView(bs);
  let anchor = 0;
  for (const sub of view.sub) {
    const edge = matchSubSequence(buf, anchor, sub);
    if (edge === null) return false;
    anchor = edge;
  }
  return true;
}

function matchInternalSignature(sigId, buffers) {
  const byteSeqs = PRONOM_DATA.signatures[sigId];
  if (!byteSeqs || !byteSeqs.length) return false;
  return byteSeqs.every((bs) => matchByteSequence(bs, buffers));
}

/* ---------- per-file identification ---------- */
function matchByteSignatures(buffers) {
  const matched = [];
  for (const format of PRONOM_DATA.formats) {
    if (!format.sig.length) continue; // container-only format (e.g. docx/xlsx) — no byte signature at all
    // Multiple InternalSignatureIDs on one format are alternative/legacy
    // variants of the same format (OR), not requirements to satisfy
    // together — confirmed against the converted registry: fmt/353 (TIFF)
    // lists both its little-endian and big-endian byte-order signatures
    // this way.
    if (format.sig.some((sigId) => matchInternalSignature(sigId, buffers))) matched.push(format);
  }
  if (!matched.length) return null;
  // Drop any format another matched format claims priority over — a single
  // pass over the original matched set correctly resolves chains too (if A
  // outranks B and B outranks C, C is dropped because B claims priority
  // over it, whether or not B itself survives).
  const survivors = matched.filter((f) => !matched.some((other) => other.id !== f.id && other.priorityOver.includes(f.id)));
  const winner = (survivors.length ? survivors : matched).slice().sort((a, b) => a.id - b.id)[0];
  return winner;
}

/* ---------- ZIP-based Office/OpenDocument disambiguation ----------
 * DROID/PRONOM identify these via a *separate* container-signature engine
 * (inspecting files inside the zip), not the byte-signature registry above —
 * confirmed against the converted data: fmt/412 (docx), fmt/214 (xlsx),
 * fmt/215 (pptx) and every OpenDocument format all have an EMPTY `sig` list,
 * so the byte engine alone can never identify them, only the bare
 * "ZIP Format" (x-fmt/263) container they're built on. Full container-
 * signature support was explicitly descoped as disproportionate effort; this
 * is a lightweight substitute: ZIP entry *names* are never compressed (only
 * entry data is), so a plain substring search for a telltale internal path
 * across the bytes already read for the byte-signature pass — no central-
 * directory parsing needed — reliably tells these formats apart whenever the
 * entry sits within the head/tail windows (true for the near-totality of
 * real documents; a doc-format archive with enough preceding embedded media
 * to push its own manifest entries past the windows is the documented
 * edge case this won't catch). */
const ZIP_NAME_MARKERS = [
  { needle: "word/document.xml", puid: "fmt/412", name: "Microsoft Word for Windows", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  { needle: "xl/workbook.xml", puid: "fmt/214", name: "Microsoft Excel for Windows", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  { needle: "ppt/presentation.xml", puid: "fmt/215", name: "Microsoft Powerpoint for Windows", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
];
// OASIS ODF's "mimetype" entry is different from the OPC markers above: its
// stored (never compressed) data holds the marker string, but that data
// doesn't sit immediately after the "mimetype" filename bytes — a local file
// header's fixed fields + extra field sit between them — so require the
// filename and its content marker to both appear (independently), rather
// than as one concatenated string.
const ZIP_CONTENT_MARKERS = [
  { needle: "application/vnd.oasis.opendocument.text", puid: "fmt/291", name: "OpenDocument Text", mime: "application/vnd.oasis.opendocument.text" },
  { needle: "application/vnd.oasis.opendocument.spreadsheet", puid: "fmt/294", name: "OpenDocument Spreadsheet", mime: "application/vnd.oasis.opendocument.spreadsheet" },
  { needle: "application/vnd.oasis.opendocument.presentation", puid: "fmt/292", name: "OpenDocument Presentation", mime: "application/vnd.oasis.opendocument.presentation" },
];
const textDecoder = new TextDecoder("latin1"); // byte-for-byte, no multi-byte decoding surprises for an ASCII marker search

function disambiguateZip(headBuf, tailBuf) {
  const text = textDecoder.decode(headBuf) + textDecoder.decode(tailBuf);
  for (const marker of ZIP_NAME_MARKERS) if (text.includes(marker.needle)) return marker;
  if (text.includes("mimetype")) {
    for (const marker of ZIP_CONTENT_MARKERS) if (text.includes(marker.needle)) return marker;
  }
  return null;
}

function isZipFormat(format) {
  return format && format.puid === "x-fmt/263";
}

const GENERIC_ZIP = { puid: "x-fmt/263", name: "ZIP Format", mime: "application/zip" };

// `method` on a result distinguishes real content identification from the
// weaker extension fallback below — surfaced in the per-file log line and
// left on the result object for any future consumer that cares about the
// confidence difference (mirrors DROID's own Signature/Container/Extension
// method tiers).
export function identifyBuffers(headBuf, tailBuf) {
  const buffers = { headBuf, tailBuf, revTailBuf: tailBuf && tailBuf.length ? reverseBytes(tailBuf) : tailBuf };
  const winner = matchByteSignatures(buffers);
  // The full x-fmt/263 signature needs a well-formed end-of-central-directory
  // record within the tail window too — a starts-with-PK\x03\x04 file whose
  // EOCD wasn't found (truncated read, unusual comment length, or genuinely
  // malformed) still very much looks like a zip-based file, so fall back to
  // the bare BOF magic rather than reporting it unidentified.
  if (isZipFormat(winner) || testNeedleAt(headBuf, 0, compileNeedle("504b0304"))) {
    const specific = disambiguateZip(headBuf, tailBuf);
    if (specific) return { puid: specific.puid, name: specific.name, mime: specific.mime, method: "content" };
    if (!winner) return { ...GENERIC_ZIP, method: "content" };
  }
  if (!winner) return null;
  return { puid: winner.puid, name: winner.name, mime: winner.mime, method: "content" };
}

/* ---------- extension fallback ----------
 * PRONOM's registry has no byte signature at all for most plain-text-family
 * formats (there's nothing distinctive about arbitrary text bytes to match)
 * — the real DROID/siegfried handle this with a second, lower-confidence
 * identification tier: match the file's extension against PRONOM's own
 * per-format extension list, used only when content identification finds
 * nothing. Only used when EXACTLY ONE format sharing that extension has no
 * byte signature of its own — a signature-bearing sibling would already
 * have been caught by matchByteSignatures() above if the file really were
 * that format, so it's excluded from the extension guess rather than
 * creating a false tie (e.g. ".txt" is also claimed by two obscure
 * signature-bearing formats — TRIM Context Reference File, ESRI ArcInfo
 * Coverage Annotation — but those never reach this fallback: if the bytes
 * actually matched them, they'd have been identified above already).
 * Genuinely ambiguous extensions (2+ signature-less formats sharing it,
 * e.g. several legacy ".doc" variants) are left unidentified rather than
 * guessed. */
let extensionMap = null;
function buildExtensionMap() {
  const byExt = new Map();
  for (const format of PRONOM_DATA.formats) {
    if (format.sig.length) continue;
    for (const ext of format.exts || []) {
      if (!byExt.has(ext)) byExt.set(ext, []);
      byExt.get(ext).push(format);
    }
  }
  const map = new Map();
  for (const [ext, formats] of byExt) if (formats.length === 1) map.set(ext, formats[0]);
  return map;
}

export function identifyByExtension(fileName) {
  if (!extensionMap) extensionMap = buildExtensionMap();
  const dot = fileName.lastIndexOf(".");
  if (dot < 0) return null;
  const format = extensionMap.get(fileName.slice(dot + 1).toLowerCase());
  return format ? { puid: format.puid, name: format.name, mime: format.mime, method: "extension" } : null;
}

/**
 * Identify file formats for each file by content (offline, PRONOM byte
 * signatures + the ZIP heuristic above).
 * @returns a Map of file id -> { puid, name, mime }, only for files that
 * matched something.
 *
 * Keyed by id rather than position in filesWithMeta for the same reason
 * austlang's identifyAllLanguages is (see that module): produced at
 * files:analyze, consumed a hook stage later at crate:built.
 *
 * Reading + matching every file is real work (two bounded reads per file,
 * up to ~2.5k signature checks each) — chunked with a yield every CHUNK
 * files so the tab stays responsive and the progress log can paint between
 * batches.
 */
const CHUNK = 10;

export async function identifyAllFormats(dirHandle, filesWithMeta, log = () => {}) {
  const total = filesWithMeta.length;
  log(`Identifying file formats for ${total} file(s) (offline PRONOM byte-signature match)…`, "muted");
  const byId = new Map();
  for (let i = 0; i < total; i++) {
    const file = filesWithMeta[i];
    const [headAb, tailAb] = await Promise.all([
      readFileBytesFromDirectory(dirHandle, file.relativePath, { start: 0, end: PRONOM_DATA.headWindow }),
      readFileBytesFromDirectory(dirHandle, file.relativePath, { start: -PRONOM_DATA.tailWindow }),
    ]);
    if (headAb !== null) {
      const headBuf = new Uint8Array(headAb);
      const tailBuf = tailAb ? new Uint8Array(tailAb) : headBuf;
      const result = identifyBuffers(headBuf, tailBuf) || identifyByExtension(file.fileName);
      if (result) {
        byId.set(file.id, result);
        const suffix = result.method === "extension" ? " (by extension, unverified)" : "";
        log(`  ${file.fileName} → ${result.name} (${result.puid})${suffix}`, "muted");
      }
    }
    if ((i + 1) % CHUNK === 0 || i + 1 === total) {
      log(`Format identification: ${i + 1}/${total} file(s)…`, "muted");
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  return byId;
}
