# Analysis plugins

Two plugins to port from chaos2crate's `src/analysis-plugins/`: a concordance
(KWIC) explorer and an n-gram analyser. Neither exists in this repo yet; this
is what they should be when they do.

They are not build plugins. A build plugin taps the pipeline, mutates `ctx` and
writes files; these read text that a build already produced and let a person
explore it — interactive panels on collection2crate's Visualise page, doing
nothing until someone types in them. Everything below follows from that one
difference.

## The contract

A plugin declares analysis the way it declares anything else — as a member on
the same registry entry, in the one `REGISTRY`:

```js
export function createPlugin(deps) {
  return {
    name: "concordance",
    analysis: {
      label: "Concordance (KWIC)",
      hint: "Search for a word or phrase and see every occurrence in context.",
      render(container, ctx) { /* … */ },
    },
  };
}
```

- `label` names the panel in the Visualise sidebar; `hint` is the one-line
  description shown with it.
- `render(container, ctx)` builds the panel's DOM inside `container`, an empty
  element the host owns. It is called each time the panel is shown, and may be
  called again when the loaded documents change; it must not assume it is the
  first call, and must not retain anything between calls except through `ctx`.
- `ctx` carries `{ documents, log }` — the documents described below, and the
  host's logger for anything worth putting in the build log.

A plugin may declare `analysis` alongside `hooks`, or on its own. These two
declare no hooks at all: they never run during a build, so they register
nothing on the bus, and `registerAllPlugins` skips them as it already skips any
plugin with no `hooks`. No second registry, no separate selection mechanism —
a deployment that leaves a plugin out of `PLUGINS` gets neither its taps nor
its panel.

## The documents

`ctx.documents` is a flat list, one entry per line, row or utterance:

```js
{ id: "_outputs/csv/interview-01.csv#12",  // path + row, unique
  source: "_outputs/csv/interview-01.csv", // for display and grouping
  speaker: "CHI",                          // "" when the format has none
  text: "the actual line of text" }
```

Flat, not nested by file, because both plugins iterate the corpus and report
which source each result came from. One line per entry, not one per file, is
what makes n-grams stop at line boundaries rather than running across an
utterance break (see below).

Loading is the **host's** job, not a plugin's: collection2crate owns the folder
handle. It offers the directories plugins declared as `outputPaths` — which is
how `_outputs/csv/` (ca-data-prep), `_outputs/chat/` (chat-export) and
`_outputs/logs/` become the things a person can analyse — and reads three
shapes:

| Extension | Parsed as | `speaker` from |
|---|---|---|
| `.csv` | a `text` column, or every cell joined when there is none | a `speakerId`/`speaker` column, if present |
| `.cha` | CHAT utterance lines (`*CHI:\t…`); `@`-prefixed header lines are metadata, not text | the tier label |
| anything else | one non-empty line per document | — |

A directory is only offered when it exists *and* holds a supported file, so a
declared output that holds HTML or images never appears as a dead option.

## What collection2crate has to add

Host-side work this spec depends on, none of it done yet:

- `composeAnalysisPanels()` in `src/plugins/index.js`, alongside
  `composeOptionSchema()` and the others, returning every plugin's `analysis`
  member in registry order.
- A Visualise page that lists those panels in its left rail and renders the
  chosen one in the right column, replacing today's fixed chart UI or sitting
  beside it as another entry.
- The document loader described above, in the host rather than in a plugin.

## Shared helpers

`src/_csv.js` in this repo, next to `_progress.js`: `csvField(value)` (quote
when the value holds a comma, quote or newline; double any quote),
`buildCsvText(header, rows)`, and `downloadCsv(filename, text)`. Both plugins
offer the same two result actions and must escape identically.

Results are **copied or downloaded, never written into the folder**. Analysis
is exploratory — a person tries twenty searches and keeps one — and a plugin
that wrote each attempt into `_outputs/` would be filing drafts as crate
content. If a particular analysis is worth keeping, it belongs in the crate by
a deliberate act, which is a separate feature from either of these.

## Styling

Use the host's existing vocabulary — `.field`, `.actions`, `.button`,
`.data-table`, `.table-scroll`, `.empty-note`, `.mono` — rather than
plugin-specific class names. chaos2crate's versions carried their own `kwic-*`
and `ngram-*` CSS, which is why they looked like guests on the page. Anything
genuinely specific to a panel (the keyword column's centring, the numeric
columns' alignment) is a handful of rules the plugin ships with its own
prefixed class.

---

## concordance

Keyword-in-context: find every match of a search term across the loaded
documents and show it with a few words of context either side. Follows the
[LADAL concordancing tutorial](https://ladal.edu.au/tutorials/concordancing/).

**Controls.** A query box and Search button (Enter searches too), three
checkboxes — case sensitive, whole word, regex — and a context size in words,
1–20, default 5.

**Matching.** The query is escaped to a literal unless *regex* is on, wrapped
in `\b…\b` when *whole word* is on (and not regex), and compiled with `g`, plus
`i` unless *case sensitive*. A zero-length match advances the index by one
rather than looping forever. An invalid pattern reports the engine's own
message next to the query box and leaves the previous results alone.

**Context.** Take the raw text either side of the match, split on whitespace,
and keep the last N words on the left and the first N on the right. Character
slicing then word trimming, rather than tokenising each document up front:
same window, far less work, and it keeps the keyword exactly as it appeared.

**Results.** A table of source, speaker, left context, keyword, right context.
Sort by left or by right context (the two orderings a concordance is read in),
and copy or save as CSV with those five columns; the saved file is
`concordance-<slug of query>.csv`. At most 2000 rows are rendered, with the
count stating both numbers when it is capped — exports carry every match.

**Testable seam.** `search(documents, query, options) → rows`, pure and
exported: matching, context windows, the zero-length guard and the regex
failure path are all reachable without a DOM.

---

## ngrams

Contiguous word sequences ranked by frequency, with association measures for
bigrams. Follows the [LADAL collocations
tutorial](https://ladal.edu.au/tutorials/collocations/collocations.html).

**Controls.** N-gram size 1–5 (default 2), minimum frequency (default 2), an
Analyze button, case-sensitive and remove-stopwords checkboxes, and a filter
box that narrows the rendered rows without recomputing.

**Tokenising.** Letters, marks and digits, with an optional internal apostrophe
or hyphen: `/[\p{L}\p{M}\p{N}]+(?:['’-][\p{L}\p{M}\p{N}]+)*/gu`. Punctuation is
dropped rather than kept as a token. **This differs from chaos2crate's
`[A-Za-z0-9]+`**, which silently drops every non-ASCII letter — unusable for
the orthographies this tool exists to serve. Lowercased unless *case sensitive*.

**Counting.** Every n-gram, plus every unigram and the token total regardless
of `n`, since the bigram measures need them. **An n-gram never spans two
documents**: each entry is its own utterance or line, so the window slides
within one and stops at its end. Rows below the minimum frequency are dropped,
as are rows containing a stopword when that option is on.

**Association measures**, bigrams only, where `O` is the pair's count, `f1`/`f2`
the two words' unigram counts and `N` the token total:

```
expected = f1 * f2 / N
MI       = log2(O / expected)          # null when expected is 0
t-score  = (O - expected) / sqrt(O)
```

The tutorial's third measure, log-ratio, is `log2((O/N)/(E/N))` — algebraically
identical to `log2(O/E)`, the same number as MI — so it is not offered as a
separate column.

**Stopwords.** A short list of English function words, enough to take `the of a`
out of a frequency list. It is English and nothing else, so **the option
defaults to off and is labelled "Remove English stopwords"** — the opposite of
chaos2crate, where it defaults on. Dropping `ngu`, `kari` or `yi` from an
Australian language corpus because they collide with an English list is a worse
failure than a noisy first page of results, and it is invisible to whoever hit
Analyze.

**Results.** A table of n-gram and count, plus MI and t-score columns when
`n` is 2; sort by frequency, and by MI or t-score when those columns exist.
Copy or save as CSV — `ngrams-n<N>.csv` — carrying whichever columns are shown.
Same 2000-row render cap and full-set export as the concordance.

**Testable seam.** `analyzeNgrams(documents, options) → rows`, pure and
exported: counting, the document boundary, the frequency and stopword filters,
and both measures against hand-worked numbers.

---

## Open questions

- **Does the Visualise page keep its chart UI?** These two are tables. The
  existing chart view reads a crate's tabular files directly; one of the three
  has to become a panel among the others, and it may as well be the chart.
- **Should a corpus's own language decide the stopword list?** The crate knows
  its subject languages when AUSTLANG ran. Defaulting the list off is the
  conservative answer until there is a real one.
- **Whether `.log.txt` files should be offered at all.** They are ca-data-prep's
  processing logs, not corpus text, and searching them concordance-style is
  meaningless. Excluding by name is easy but arbitrary; leaving them in offers
  a person a choice they can't evaluate.
