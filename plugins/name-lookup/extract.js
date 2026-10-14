// Named entity recognition over a file's text: the people's and places' names
// it mentions. compromise (and its lexicon) and the PDF reader are imported
// here, and this module is itself only imported when the plugin's option is
// on, so none of them reaches the main bundle of a build that never asks.
import nlp from "compromise";
import { extractDocumentText, decodePlainText } from "../ca-data-prep/process.js";

// What can be read as text. Anything else (audio, images, spreadsheets) is
// skipped without a word — most of a language-resources folder isn't prose.
const PLAIN_TEXT = /\.(txt|md|markdown)$/i;
const WORD = /\.docx$/i;
const PDF = /\.pdf$/i;

export const isReadableForNames = (fileName) =>
  PLAIN_TEXT.test(fileName) || WORD.test(fileName) || PDF.test(fileName);

// unpdf is pdf.js built to run without a worker, so the same call works in the
// browser and under node (the tests). Its own pdf.js build loads on first use.
async function pdfText(bytes) {
  const { extractText } = await import("unpdf");
  const { text } = await extractText(new Uint8Array(bytes), { mergePages: true });
  return text;
}

/** The text of one file, from its bytes; "" for a type this doesn't read. */
export async function fileText(bytes, fileName) {
  if (!bytes) return "";
  if (WORD.test(fileName)) return extractDocumentText(bytes);
  if (PDF.test(fileName)) return pdfText(bytes);
  if (PLAIN_TEXT.test(fileName)) return decodePlainText(bytes);
  return "";
}

// compromise reads "John Smith's family" as two people, "John" and "Smith's";
// without the possessive it reads one. A curly apostrophe is common in Word.
const POSSESSIVE = /(\p{L})['’]s\b/gu;

// Punctuation after a word that ends a name: "George Watson, Jambun" is two.
const BREAK_AFTER = /[,.;:!?()\[\]"“”]/;

// The names in a view, honorifics dropped ("Mrs. Mary O'Brien" → "Mary
// O'Brien"), each word without the punctuation around it ("Palm Island." →
// "Palm Island"), so a name is spelled the same wherever it occurs. A match
// running across a comma or full stop is split there, and a piece of three
// letters or fewer is dropped.
// One to three letters is an initial, an abbreviation or a stray fragment
// ("M", "T", "Mt", "Dr") far more often than a name. Counted over the whole
// name, so "M. Dixon" stays; a real three-letter place (Ayr) goes too.
export const MIN_NAME_LETTERS = 4;
const tooShort = (name) => (name.match(/\p{L}/gu) || []).length < MIN_NAME_LETTERS;

function namesOf(view) {
  const out = new Set();
  for (const match of view.not("#Honorific").json({ terms: { text: true, post: true } })) {
    let words = [];
    const flush = () => {
      const name = words.join(" ").trim();
      if (name && !tooShort(name)) out.add(name);
      words = [];
    };
    for (const term of match.terms) {
      if (term.text) words.push(term.text);
      if (BREAK_AFTER.test(term.post || "")) flush();
    }
    flush();
  }
  return [...out];
}

/**
 * The distinct names in `text`, in the order first seen: compromise's people
 * and places, and every other proper-noun phrase as a `candidate` — compromise
 * knows few places outside its lexicon (Yarrabah, Kuranda), so those are left
 * for a gazetteer to decide.
 */
export function extractNames(text) {
  const doc = nlp(String(text || "").replace(POSSESSIVE, "$1"));
  const people = namesOf(doc.people());
  const places = namesOf(doc.places());
  const known = new Set([...people, ...places]);
  const candidates = namesOf(doc.match("#ProperNoun+").not("(#Person|#Place)")).filter((name) => !known.has(name));
  return { people, places, candidates };
}
