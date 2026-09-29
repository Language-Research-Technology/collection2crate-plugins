// NRC Word-Emotion Association Lexicon (Mohammad & Turney, 2013), bundled as
// nrc-lexicon-data.json (word → categories), converted from nrc_lexicon.csv.
// Free for research/educational use; commercial use needs the lexicon
// author's permission — see README.md.
import NRC_DATA from "./nrc-lexicon-data.json" with { type: "json" };

let lexicon;

export function loadLexicon() {
  if (!lexicon) lexicon = new Map(Object.entries(NRC_DATA).map(([word, categories]) => [word, new Set(categories)]));
  return lexicon;
}
