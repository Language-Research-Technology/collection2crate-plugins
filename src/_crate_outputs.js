// Whether a plugin's generated files are described in the RO-Crate.
//
// ca-data-prep and chat-export both write files under _outputs/ during
// Process. Each offers the same choice as a child checkbox: include those
// files in the crate, or leave them out. Leaving them out also takes
// out entities an earlier build added for them, since a build adds to the
// folder's existing crate rather than replacing it.

/**
 * The child option node: a checkbox, ticked to describe the files in the
 * crate. collection2crate starts a checkbox unticked unless the profile names
 * it in `buildOptions.plugins`, and forces it off when the profile doesn't
 * offer it — so a profile that offers the parent option should offer this one
 * too, and list it in `plugins` to keep the files in the crate by default.
 */
export function outputsInCrateOption(key, what) {
  return {
    key,
    label: `Include ${what} in the RO-Crate`,
    hint: "Ticked, each generated file is described as a File entity. Unticked, the files are still written to the folder, but the crate doesn't mention them.",
    // Only crate:build reads it, so changing it needn't send the person back
    // to Process (collection2crate SPEC.md §4.4).
    stage: "build",
  };
}

/** Whether the option asks for the outputs to be described in the crate. */
export function includeOutputs(options, key) {
  return options?.[key] === true;
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
