// The @id given to an entity made from a name — a Person or Place merged from
// a spreadsheet cell, or found in a file's text by name-lookup. One scheme, so
// the same name reaches the same entity whichever plugin met it first:
// "John Smith" → "#john_smith", a Place "Mount Isa" → "#place-mount-isa".

export function slugifyEntityValue(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function generatedEntityId(type, value) {
  const slug = slugifyEntityValue(value).replace(/-/g, "_") || "entity";
  if (type === "Place") return `#place-${slugifyEntityValue(value) || "place"}`;
  return `#${slug}`;
}
