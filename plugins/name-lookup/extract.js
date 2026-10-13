// Named entity recognition over a file's text: the people's and places' names
// it mentions. compromise (and its lexicon) is imported here, and this module
// is itself only imported when the plugin's option is on, so neither reaches
// the main bundle of a build that never asks for it.
import nlp from "compromise";
import { extractDocumentText, decodePlainText } from "../ca-data-prep/process.js";

// What can be read as text. Anything else (audio, images, spreadsheets) is
// skipped without a word — most of a language-resources folder isn't prose.
const PLAIN_TEXT = /\.(txt|md|markdown)$/i;
const WORD = /\.docx$/i;

export const isReadableForNames = (fileName) => PLAIN_TEXT.test(fileName) || WORD.test(fileName);

/** The text of one file, from its bytes; "" for a type this doesn't read. */
export async function fileText(bytes, fileName) {
  if (!bytes) return "";
  if (WORD.test(fileName)) return extractDocumentText(bytes);
  if (PLAIN_TEXT.test(fileName)) return decodePlainText(bytes);
  return "";
}

// compromise reads "John Smith's family" as two people, "John" and "Smith's";
// without the possessive it reads one. A curly apostrophe is common in Word.
const POSSESSIVE = /(\p{L})['’]s\b/gu;

// The words of a match, honorifics dropped ("Mrs. Mary O'Brien" → "Mary
// O'Brien"), each without the punctuation around it ("Palm Island." → "Palm
// Island"), so a name is spelled the same wherever it occurs.
function namesOf(view) {
  const out = new Set();
  for (const match of view.not("#Honorific").json({ terms: { text: true } })) {
    const name = match.terms.map((term) => term.text).filter(Boolean).join(" ").trim();
    if (name) out.add(name);
  }
  return [...out];
}

/** The distinct person and place names in `text`, in the order first seen. */
export function extractNames(text) {
  const doc = nlp(String(text || "").replace(POSSESSIVE, "$1"));
  return { people: namesOf(doc.people()), places: namesOf(doc.places()) };
}
