// Finds the people and places a folder's files talk about, by named entity
// recognition over each file's text, and links them into the crate: the File
// gets custom:participant → Person and custom:place → Place.
//
// Split across the two halves of a run like ca-data-prep: reading and NER are
// the slow part and happen at files:prepare, during Process; the entities go
// in at crate:build, during Build, after merge — so a person or place merge
// has just described is the one a file is linked to, not a second copy of it.
// The names are carried between the two on ctx.namesByFile.
//
// Hook names are literal strings and core collection2crate functions arrive
// via createPlugin(deps) — see this repo's README.
import { countedProgress } from "../../src/_progress.js";

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
 * already described by hand (or merged from a spreadsheet) under that @id is
 * found and reused rather than duplicated.
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
 * the rest. A file the crate doesn't hold (excluded since Process) is passed by.
 *
 * @param {ROCrate} crate
 * @param {Object<string, {people: string[], places: string[]}>} namesByFile  keyed by File @id
 * @returns {{ created: number, reused: number, links: number }}
 */
export function linkNamedEntities(crate, namesByFile) {
  const counts = { created: 0, reused: 0, links: 0 };
  const seen = new Set();
  const used = new Set();
  const kinds = [["people", "Person", PARTICIPANT], ["places", "Place", PLACE]];

  for (const [fileId, names] of Object.entries(namesByFile || {})) {
    if (!crate.getEntity(fileId)) continue;
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

async function bytesOf(ctx, file) {
  try {
    if (file.handle?.getFile) return await (await file.handle.getFile()).arrayBuffer();
    if (ctx.dirHandle && file.relativePath) return await readFileBytes(ctx.dirHandle, file.relativePath);
  } catch {
    // Unreadable (moved, permission withdrawn): reported by the caller.
  }
  return null;
}

const plugin = {
  name: "name-lookup",
  optionSchema: {
    key: "enableNameLookups", label: "Identify people and places named in files", default: false,
    hint: "Reads each .txt, .md and .docx file and finds people's and places' names with named entity recognition — offline, no network. Links each file to a Person (as participant) or Place, reusing an entity whose @id is the name with # in front and underscores for spaces.",
  },
  hooks: {
    "files:prepare": {
      priority: 50,
      weight: 4,
      activeWhen: (ctx) => !!ctx.options.enableNameLookups,
      handler: async (ctx) => {
        if (!ctx.options.enableNameLookups) return;
        const { isReadableForNames, fileText, extractNames } = await import("./extract.js");
        const files = (ctx.filesWithMeta || []).filter((file) => isReadableForNames(file.fileName || file.name || ""));
        ctx.namesByFile = {};
        if (!files.length) {
          ctx.log("Name lookup: no .txt, .md or .docx files to read.", "muted");
          return;
        }

        const tick = countedProgress(ctx, files.length, "Finding people and places in files…");
        let unreadable = 0;
        for (let index = 0; index < files.length; index++) {
          const file = files[index];
          const bytes = await bytesOf(ctx, file);
          if (!bytes) unreadable++;
          else {
            try {
              const names = extractNames(await fileText(bytes, file.fileName || file.name));
              if (names.people.length || names.places.length) ctx.namesByFile[file.id] = names;
            } catch (e) {
              ctx.log(`Name lookup: couldn't read ${file.relativePath}: ${e.message}`, "warn");
            }
          }
          tick(index, `Name lookup: ${index + 1}/${files.length} file(s)…`);
        }
        tick.done();

        if (unreadable) ctx.log(`Name lookup: ${unreadable} file(s) could not be read.`, "warn");
        const found = Object.keys(ctx.namesByFile).length;
        ctx.log(`Name lookup: found names in ${found} of ${files.length} file(s).`, found ? "ok" : "muted");
      },
    },
    "crate:build": {
      priority: 75,
      weight: 1,
      activeWhen: (ctx) => !!ctx.options.enableNameLookups,
      handler: (ctx) => {
        if (!ctx.namesByFile) return;
        const { created, reused, links } = linkNamedEntities(ctx.crate, ctx.namesByFile);
        ctx.log(
          `Name lookup: ${links} link(s) from files — ${created} new Person/Place entity(ies), ${reused} already in the crate.`,
          links ? "ok" : "muted",
        );
      },
    },
  },
};
