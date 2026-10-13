// Finds the people and places a folder's files talk about, by named entity
// recognition over each file's text, and links them into the crate: the File
// gets custom:participant → Person and custom:place → Place.
//
// All of it happens at files:prepare, during Process, on the crate the run was
// seeded with — so the people and places are already in the crate Process
// hands to Build (ctx.preparedCrate), and only an entity the crate holds by
// then (from the folder's existing crate, or edited in) can be reused. A File
// that is new to the crate is added here, bare; generic-input's scan at Build
// finds it and fills it in rather than adding a second one.
//
// Hook names are literal strings and core collection2crate functions arrive
// via createPlugin(deps) — see this repo's README.
import { progressFor } from "../../src/_progress.js";

let readFileBytes;

export function createPlugin(deps) {
  ({ readFileBytes } = deps);
  return plugin;
}

const PARTICIPANT = "custom:participant";
const PLACE = "custom:place";

// Added only when a file was actually linked through one, like austlang's.
// custom:participant usually arrives with the profile's fileProperties already.
const PROPERTY_DEFINITIONS = {
  [PARTICIPANT]: { "@id": "arcp://name,custom/terms#participant", "@type": "rdf:Property", name: "Participant", description: "A participant associated with the file." },
  [PLACE]: { "@id": "arcp://name,custom/terms#place", "@type": "rdf:Property", name: "Place", description: "A place named in the file's contents." },
};

/**
 * A name's @id: "#" and the name, spaces as underscores — "John Smith" is
 * "#John_Smith". Deliberately the obvious spelling, so an entity someone
 * already described by hand under that @id is found and reused rather than
 * duplicated.
 */
export const nameToId = (name) => `#${String(name).trim().replace(/\s+/g, "_")}`;

const refsOf = (value) => (Array.isArray(value) ? value : value ? [value] : [])
  .filter((v) => v !== "" && v != null);

function link(crate, fileId, property, id) {
  const refs = refsOf(crate.getProperty(fileId, property));
  if (refs.some((ref) => (ref?.["@id"] ?? ref) === id)) return false;
  crate.setProperty(fileId, property, [...refs.map((ref) => (ref?.["@id"] ? { "@id": ref["@id"] } : ref)), { "@id": id }]);
  return true;
}

/**
 * Link each file to the people and places found in it, reusing any entity
 * the crate already has under a name's @id and creating a Person or Place for
 * the rest. A File the crate doesn't hold yet is added, named from `fileNames`.
 *
 * @param {ROCrate} crate
 * @param {Object<string, {people: string[], places: string[]}>} namesByFile  keyed by File @id
 * @param {Object<string, string>} [fileNames]  File @id → file name, for a File added here
 * @returns {{ created: number, reused: number, links: number }}
 */
export function linkNamedEntities(crate, namesByFile, fileNames = {}) {
  const counts = { created: 0, reused: 0, links: 0 };
  const seen = new Set();
  const used = new Set();
  const kinds = [["people", "Person", PARTICIPANT], ["places", "Place", PLACE]];

  for (const [fileId, names] of Object.entries(namesByFile || {})) {
    if (!crate.getEntity(fileId)) {
      crate.addEntity({ "@id": fileId, "@type": "File", name: fileNames[fileId] || fileId.split("/").pop() });
    }
    for (const [key, type, property] of kinds) {
      for (const name of names?.[key] || []) {
        const id = nameToId(name);
        if (!seen.has(id)) {
          seen.add(id);
          if (crate.getEntity(id)) counts.reused++;
          else { crate.addEntity({ "@id": id, "@type": type, name }); counts.created++; }
        }
        if (link(crate, fileId, property, id)) { counts.links++; used.add(property); }
      }
    }
  }

  for (const property of used) {
    const definition = PROPERTY_DEFINITIONS[property];
    if (!crate.getEntity(definition["@id"])) crate.addEntity(definition);
  }
  return counts;
}

/**
 * The candidates a gazetteer knows as places. A gazetteer answers with its
 * nearest match, so only one whose name is the candidate's — or a spelling of
 * it the lookup tries itself, "Mt Isa" for "Mount Isa" — counts.
 *
 * @param {string[]} candidates
 * @param {(name: string) => Promise<{matchedName?: string}|null>} lookup
 * @returns {Promise<Set<string>>}
 */
export async function confirmPlaces(candidates, lookup) {
  const { normalizePlaceName, placeNameVariants } = await import("../../src/_place_lookup.js");
  const confirmed = new Set();
  for (const name of candidates) {
    const match = await lookup(name);
    if (!match) continue;
    const spellings = new Set([name, ...placeNameVariants(name)].map(normalizePlaceName));
    if (spellings.has(normalizePlaceName(match.matchedName))) confirmed.add(name);
  }
  return confirmed;
}

async function bytesOf(ctx, file) {
  try {
    if (file.handle?.getFile) return await (await file.handle.getFile()).arrayBuffer();
    if (ctx.dirHandle && file.relativePath) return await readFileBytes(ctx.dirHandle, file.relativePath);
  } catch {
    // Unreadable (moved, permission withdrawn): reported by the caller.
  }
  return null;
}

// Reading the files is most of the work without the gazetteer; with it, the
// lookups — one request or two per distinct candidate — are.
const READ_SHARE = 0.5;
const LOOKUP_TIMEOUT_MS = 8000;

const plugin = {
  name: "name-lookup",
  optionSchema: {
    key: "enableNameLookups", label: "Identify people and places named in files", default: false,
    hint: "Reads each .txt, .md, .docx and .pdf file and finds people's and places' names with named entity recognition. Links each file to a Person (as participant) or Place, reusing an entity whose @id is the name with # in front and underscores for spaces.",
    children: [
      { key: "nameLookupGazetteer", label: "Check other names against the Australian gazetteers", default: true,
        hint: "Looks up each capitalised name that wasn't recognised as a person or place in the Geoscience Australia and GHAP gazetteers, and treats exact matches as places. Needs the network." },
    ],
  },
  hooks: {
    "files:prepare": {
      priority: 50,
      weight: 4,
      activeWhen: (ctx) => !!ctx.options.enableNameLookups,
      handler: async (ctx) => {
        if (!ctx.options.enableNameLookups) return;
        if (!ctx.crate) {
          ctx.log("Name lookup: this host gives Process no crate to add people and places to — skipped.", "warn");
          return;
        }
        const { isReadableForNames, fileText, extractNames } = await import("./extract.js");
        const files = (ctx.filesWithMeta || []).filter((file) => isReadableForNames(file.fileName || file.name || ""));
        if (!files.length) {
          ctx.log("Name lookup: no .txt, .md, .docx or .pdf files to read.", "muted");
          return;
        }

        const gazetteer = ctx.options.nameLookupGazetteer !== false;
        const progress = progressFor(ctx);
        const readShare = gazetteer ? READ_SHARE : 1;
        progress.start("Finding people and places in files…");
        try {
          const namesByFile = {};
          const fileNames = {};
          let unreadable = 0;
          for (let index = 0; index < files.length; index++) {
            const file = files[index];
            const fileName = file.fileName || file.name;
            const bytes = await bytesOf(ctx, file);
            if (!bytes) unreadable++;
            else {
              try {
                namesByFile[file.id] = extractNames(await fileText(bytes, fileName));
                fileNames[file.id] = fileName;
              } catch (e) {
                ctx.log(`Name lookup: couldn't read ${file.relativePath}: ${e.message}`, "warn");
              }
            }
            progress.report(((index + 1) / files.length) * readShare, `Name lookup: read ${index + 1}/${files.length} file(s)…`);
          }
          if (unreadable) ctx.log(`Name lookup: ${unreadable} file(s) could not be read.`, "warn");

          if (gazetteer) {
            const candidates = [...new Set(Object.values(namesByFile).flatMap((names) => names.candidates))];
            if (candidates.length) {
              const { createPlaceLookupService } = await import("../../src/_place_lookup.js");
              // A timed-out lookup reads as "not a place", and the shared 2.5s
              // default loses the first few requests of a cold connection.
              const service = createPlaceLookupService({
                geoscienceAustralia: { exactOnly: true, timeoutMs: LOOKUP_TIMEOUT_MS },
                ghap: { timeoutMs: LOOKUP_TIMEOUT_MS },
              });
              await service.prefetch(candidates, (fraction, label) => progress.report(readShare + fraction * (1 - readShare), label));
              const confirmed = await confirmPlaces(candidates, (name) => service.lookup(name));
              for (const names of Object.values(namesByFile)) {
                names.places = [...names.places, ...names.candidates.filter((name) => confirmed.has(name))];
              }
              ctx.log(`Name lookup: the gazetteers know ${confirmed.size} of ${candidates.length} other name(s) as places.`, confirmed.size ? "ok" : "muted");
            }
          }

          const { created, reused, links } = linkNamedEntities(ctx.crate, namesByFile, fileNames);
          ctx.log(
            `Name lookup: ${links} link(s) from ${files.length} file(s) — ${created} new Person/Place entity(ies), ${reused} already in the crate.`,
            links ? "ok" : "muted",
          );
        } finally {
          progress.done();
        }
      },
    },
  },
};
