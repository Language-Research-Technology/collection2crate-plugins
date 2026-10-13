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
import { generatedEntityId } from "../../src/_entity_ids.js";

let readFileBytes, readJsonFromFolder;

export function createPlugin(deps) {
  ({ readFileBytes, readJsonFromFolder } = deps);
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
 * the crate already has under a name's @id (merge's scheme, src/_entity_ids.js) and creating a Person or Place for
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
        const id = generatedEntityId(type, name);
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
 * The candidates a gazetteer knows as places, each marked exact or partial.
 * Exact: the gazetteer's name is the candidate's, or a spelling of it the
 * lookup tries itself ("Mt Isa" for "Mount Isa"). Partial: anything else it
 * answered with — GA's names starting with the candidate, GHAP's containing it
 * ("Murray Upper" for "Murray Upp"). Exact matches are ranked first, so a
 * partial one only stands where the gazetteer had nothing better.
 *
 * @param {string[]} candidates
 * @param {(name: string) => Promise<{matchedName?: string}|null>} lookup
 * @returns {Promise<Map<string, { exact: boolean, matchedName: string }>>}
 */
export async function confirmPlaces(candidates, lookup) {
  const { normalizePlaceName, placeNameVariants } = await import("../../src/_place_lookup.js");
  const confirmed = new Map();
  for (const name of candidates) {
    const match = await lookup(name);
    if (!match) continue;
    const spellings = new Set([name, ...placeNameVariants(name)].map(normalizePlaceName));
    confirmed.set(name, { exact: spellings.has(normalizePlaceName(match.matchedName)), matchedName: match.matchedName || "" });
  }
  return confirmed;
}

const hasGeometry = (place) => [].concat(place?.geo ?? []).some((ref) => ref && (ref["@id"] || typeof ref === "string"));

/**
 * Give each Place found by name the coordinates its lookup returned, as a
 * Geometry linked the way merge links one (setPlaceGeometry). A Place that
 * already points at a Geometry — entered by hand, or by an earlier run — is
 * left as it is.
 *
 * @param {ROCrate} crate
 * @param {Map<string, {latitude: number, longitude: number, asWKT: string}>} coordinatesByName
 * @returns {Promise<{ placed: number, kept: number }>}
 */
export async function addPlaceCoordinates(crate, coordinatesByName) {
  const { setPlaceGeometry } = await import("../../src/_place_lookup.js");
  const counts = { placed: 0, kept: 0 };
  for (const [name, match] of coordinatesByName) {
    const id = generatedEntityId("Place", name);
    const place = crate.getEntity(id);
    if (!place) continue;
    if (hasGeometry(place)) { counts.kept++; continue; }
    setPlaceGeometry(crate, id, name, match);
    counts.placed++;
  }
  return counts;
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
// lookups — one request or two per distinct place or candidate — are.
const READ_SHARE = 0.5;
const LOOKUP_TIMEOUT_MS = 8000;

const plugin = {
  name: "name-lookup",
  optionSchema: {
    key: "enableNameLookups", label: "Identify people and places named in files", default: false,
    hint: "Reads each .txt, .md, .docx and .pdf file and finds people's and places' names with named entity recognition. Links each file to a Person (as participant) or Place, reusing one already in the crate under the @id merge would give it (#john_smith, #place-mount-isa).",
    children: [
      { key: "nameLookupGazetteer", label: "Look names up in the Australian gazetteers", default: true,
        hint: "Uses Geoscience Australia and GHAP to treat other capitalised names that match a place as places, and to give places coordinates, preferring the region set as placeMatchRegion in the merge config. Needs the network.",
        children: [
          { key: "nameLookupExactOnly", label: "Exact place names only", default: false,
            hint: "Off: a name the gazetteers don't know exactly is still a place if one starts with or contains it (\"Murray Upp\" → Murray Upper), and takes its coordinates. On: only exact names count." },
        ] },
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

          let coordinates = new Map();
          if (gazetteer) {
            const { createPlaceLookupService, placeLookupSettings } = await import("../../src/_place_lookup.js");
            const { resolveMergeConfig } = await import("../../src/_merge_config.js");
            const { config, source } = await resolveMergeConfig(ctx.options, ctx.dirHandle, readJsonFromFolder);
            const settings = placeLookupSettings(config);
            if (settings.placeMatchRegion) ctx.log(`Name lookup: preferring places in ${settings.placeMatchRegion} (merge config: ${source}).`, "muted");
            // A timed-out lookup reads as "not a place", and GA's 2.5s default
            // loses the first few requests of a cold connection. GHAP has its own,
            // longer default.
            const exactOnly = !!ctx.options.nameLookupExactOnly;
            const service = createPlaceLookupService({
              ...settings,
              ...(exactOnly ? { exactOnly } : {}),
              geoscienceAustralia: { timeoutMs: LOOKUP_TIMEOUT_MS, ...settings.geoscienceAustralia },
              ghap: { ...settings.ghap },
            });

            const all = Object.values(namesByFile);
            const candidates = [...new Set(all.flatMap((names) => names.candidates))];
            const places = [...new Set(all.flatMap((names) => names.places))];
            await service.prefetch([...candidates, ...places], (fraction, label) => progress.report(readShare + fraction * (1 - readShare), label));

            const confirmed = await confirmPlaces(candidates, (name) => service.lookup(name));
            // The lookup already asked for exact names only; this also drops a
            // gazetteer's nearest answer to an exact query that isn't one.
            if (exactOnly) for (const [name, m] of confirmed) if (!m.exact) confirmed.delete(name);
            for (const names of all) {
              names.places = [...names.places, ...names.candidates.filter((name) => confirmed.has(name))];
            }
            if (candidates.length) {
              ctx.log(`Name lookup: the gazetteers know ${confirmed.size} of ${candidates.length} other name(s) as places.`, confirmed.size ? "ok" : "muted");
            }
            // Partial matches are the ones worth a second look, so name them.
            const partial = [...confirmed].filter(([, m]) => !m.exact);
            if (partial.length) {
              const shown = partial.slice(0, 10).map(([name, m]) => `${name} → ${m.matchedName}`).join("; ");
              ctx.log(`Name lookup: ${partial.length} place(s) by partial match: ${shown}${partial.length > 10 ? "; …" : ""}.`, "muted");
            }
            for (const name of [...places, ...confirmed.keys()]) {
              const match = await service.lookup(name);
              if (match) coordinates.set(name, match);
            }
          }

          const { created, reused, links } = linkNamedEntities(ctx.crate, namesByFile, fileNames);
          ctx.log(
            `Name lookup: ${links} link(s) from ${files.length} file(s) — ${created} new Person/Place entity(ies), ${reused} already in the crate.`,
            links ? "ok" : "muted",
          );
          if (coordinates.size) {
            const { placed, kept } = await addPlaceCoordinates(ctx.crate, coordinates);
            ctx.log(
              `Name lookup: coordinates for ${placed} place(s)${kept ? `; ${kept} already had their own, left as they were` : ""}.`,
              placed ? "ok" : "muted",
            );
          }
        } finally {
          progress.done();
        }
      },
    },
  },
};
