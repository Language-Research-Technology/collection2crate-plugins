// Whether a plugin's generated files are described in the RO-Crate.
//
// ca-data-prep and chat-export both write files under _outputs/ during
// Process. Each offers the same choice as a child option: include those files
// in the crate (the default), or leave them out. Leaving them out also takes
// out entities an earlier build added for them, since a build adds to the
// folder's existing crate rather than replacing it.

export const OUTPUTS_INCLUDE = "include";
export const OUTPUTS_IGNORE = "ignore";

/**
 * The child option node. A select whose placeholder (value "") is the
 * include choice, so a profile that doesn't offer the option — which forces
 * it to "" — keeps the files in the crate, as before the option existed.
 */
export function outputsInCrateOption(key, what) {
  return {
    key,
    type: "select",
    // Only crate:build reads it, so changing it needn't send the person back
    // to Process (collection2crate SPEC.md §4.4).
    stage: "build",
    label: `${what} in the RO-Crate`,
    placeholder: "Include in the RO-Crate",
    choices: () => [{ value: OUTPUTS_IGNORE, label: "Leave out of the RO-Crate" }],
    hint: `Include describes each generated file as a File entity. Leave out still writes the files to the folder, but the crate doesn't mention them.`,
  };
}

/** True unless the option asks for the outputs to be left out. */
export function includeOutputs(options, key) {
  return String(options?.[key] ?? "") !== OUTPUTS_IGNORE;
}

const normalise = (id) => String(id || "").replace(/^\.\//, "");

/**
 * Delete every entity whose @id lies under one of `dirs`, with every
 * reference to it, and any Annotation left with no body. In place.
 *
 * @param {ROCrate} crate
 * @param {string[]} dirs  folder-relative directories, e.g. "_outputs/csv"
 * @returns {number} how many entities were removed
 */
export function removeOutputEntities(crate, dirs) {
  if (!crate) return 0;
  const prefixes = dirs.map((dir) => `${normalise(dir).replace(/\/$/, "")}/`);
  const doomed = crate.getGraph()
    .map((entity) => entity["@id"])
    .filter((id) => prefixes.some((prefix) => normalise(id).startsWith(prefix)));
  for (const id of doomed) removeWithReferences(crate, id);

  // An annotation whose body was one of those files now annotates nothing.
  let orphans = 0;
  for (const entity of [...crate.getGraph()]) {
    const types = [].concat(entity["@type"] || []).map(String);
    if (!types.includes("Annotation")) continue;
    if ([].concat(entity.annotationBody ?? []).length) continue;
    removeWithReferences(crate, entity["@id"]);
    orphans++;
  }
  return doomed.length + orphans;
}

function removeWithReferences(crate, id) {
  crate.deleteEntity(id);
  for (const entity of crate.getGraph()) {
    for (const key of Object.keys(entity)) {
      if (key === "@id" || key === "@type") continue;
      const values = [].concat(entity[key] ?? []);
      const kept = values.filter((v) => !(v && typeof v === "object" && normalise(v["@id"]) === normalise(id)));
      if (kept.length === values.length) continue;
      if (kept.length) entity[key] = kept;
      else delete entity[key];
    }
  }
}
