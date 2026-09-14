// Concordance (KWIC — keyword in context): every occurrence of a search term
// across the loaded documents, with a few words either side. Follows the LADAL
// concordancing tutorial (https://ladal.edu.au/tutorials/concordancing/).
//
// A visualisation panel, not a build plugin: it taps no hook, runs during no
// build, and does nothing until someone types in it (SPEC-PLUGINS.md).

import { buildCsvText, copyText, downloadCsv } from "../../src/_csv.js";
import { button, checkbox, dataTable, element, field, note, numberInput } from "../../src/_panel.js";

// Rendering every row of a corpus-wide match set locks the page up for no
// benefit — nobody reads row 4000. Exports carry everything.
const MAX_RENDERED_ROWS = 2000;

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A filesystem-safe stub of the query, for the saved file's name. */
function slugify(value) {
  const slug = String(value || "").trim().toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
  return slug.slice(0, 40) || "query";
}

function buildMatcher(query, { regex, wholeWord, caseSensitive }) {
  let pattern = regex ? query : escapeRegExp(query);
  if (!regex && wholeWord) pattern = `\\b${pattern}\\b`;
  return new RegExp(pattern, caseSensitive ? "g" : "gi");
}

// Slice the raw text either side of the match and trim to whole words, rather
// than tokenising every document up front: the same window, a fraction of the
// work, and the keyword survives exactly as it was written.
function contextWords(text, count, fromEnd) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return (fromEnd ? words.slice(-count) : words.slice(0, count)).join(" ");
}

/**
 * Every match of `query` across `documents`, in document order.
 *
 * @param {Array<{source: string, speaker?: string, text: string}>} documents
 * @param {string} query
 * @param {{regex?: boolean, wholeWord?: boolean, caseSensitive?: boolean, windowSize?: number}} options
 * @returns {Array<{source, speaker, left, keyword, right}>}
 */
export function search(documents, query, options = {}) {
  const windowSize = options.windowSize || 5;
  const matcher = buildMatcher(query, options);
  const results = [];
  for (const doc of documents || []) {
    matcher.lastIndex = 0;
    let match;
    while ((match = matcher.exec(doc.text || ""))) {
      // A pattern that can match nothing ("x*") would otherwise never advance.
      if (match[0] === "") { matcher.lastIndex++; continue; }
      results.push({
        source: doc.source,
        speaker: doc.speaker || "",
        left: contextWords(doc.text.slice(0, match.index), windowSize, true),
        keyword: match[0],
        right: contextWords(doc.text.slice(match.index + match[0].length), windowSize, false),
      });
    }
  }
  return results;
}

const COLUMNS = ["source", "speaker", "left", "keyword", "right"];

export function createPlugin() {
  return {
    name: "concordance",
    visualisation: {
      label: "Concordance",
      hint: "Search for a word or phrase and see every occurrence in context.",
      render(container, { documents = [] }) {
        let results = [];
        let query = "";

        const queryInput = element("input", {
          attrs: { type: "search", placeholder: "Word or phrase…", "aria-label": "Search term" },
        });
        const caseSensitive = checkbox("Case sensitive");
        const wholeWord = checkbox("Whole word");
        const regex = checkbox("Regex");
        const windowInput = numberInput({ value: 5, min: 1, max: 20 });
        const status = element("p", { className: "field-hint" });
        const count = element("span", { className: "field-hint" });
        // Left context is right-aligned so it runs up against the keyword: a
        // concordance is read down the column of what precedes the word, and
        // ragged-left text hides exactly the thing being compared.
        const { body, node: table } = dataTable([
          "Source", "Speaker",
          { label: "Left context", className: "kwic-left" },
          { label: "Keyword", className: "kwic-keyword" },
          "Right context",
        ]);
        const resultsWrap = element("div", { attrs: { hidden: true } });

        const csv = () => buildCsvText(COLUMNS, results.map((r) => COLUMNS.map((c) => r[c])));

        function renderRows() {
          body.replaceChildren();
          const shown = results.slice(0, MAX_RENDERED_ROWS);
          for (const row of shown) {
            body.append(element("tr", {}, [
              element("td", { text: row.source, attrs: { title: row.source } }),
              element("td", { text: row.speaker }),
              element("td", { text: row.left, className: "kwic-left" }),
              element("td", { text: row.keyword, className: "kwic-keyword" }),
              element("td", { text: row.right }),
            ]));
          }
          count.textContent = results.length > shown.length
            ? `${results.length} matches (showing the first ${shown.length})`
            : `${results.length} match${results.length === 1 ? "" : "es"}`;
        }

        function runSearch() {
          query = queryInput.value.trim();
          if (!query) { status.textContent = "Enter a word or phrase to search for."; return; }
          if (!documents.length) { status.textContent = "No text loaded — choose an output folder."; return; }
          let found;
          try {
            found = search(documents, query, {
              caseSensitive: caseSensitive.input.checked,
              wholeWord: wholeWord.input.checked,
              regex: regex.input.checked,
              windowSize: Math.min(20, Math.max(1, parseInt(windowInput.value, 10) || 5)),
            });
          } catch (e) {
            // An invalid regex is the person's typing, not a failure: say what
            // the engine said and leave the last good results on screen.
            status.textContent = `Invalid pattern: ${e.message}`;
            return;
          }
          results = found;
          status.textContent = "";
          resultsWrap.hidden = false;
          renderRows();
        }

        const sortBy = (key) => () => {
          results = [...results].sort((a, b) => a[key].localeCompare(b[key]));
          renderRows();
        };
        const copyButton = button("Copy CSV", {
          onClick: async () => {
            if (!results.length) return;
            const ok = await copyText(csv());
            status.textContent = ok ? "" : "The browser would not give access to the clipboard.";
            if (ok) {
              const label = copyButton.textContent;
              copyButton.textContent = "Copied";
              setTimeout(() => { copyButton.textContent = label; }, 1500);
            }
          },
        });

        queryInput.addEventListener("keydown", (event) => { if (event.key === "Enter") runSearch(); });

        resultsWrap.append(
          element("div", { className: "actions" }, [
            count,
            button("Sort by left context", { onClick: sortBy("left") }),
            button("Sort by right context", { onClick: sortBy("right") }),
            copyButton,
            button("Save CSV", {
              onClick: () => results.length && downloadCsv(`concordance-${slugify(query)}.csv`, csv()),
            }),
          ]),
          table,
        );

        container.replaceChildren(
          element("div", { className: "actions" }, [queryInput, button("Search", { primary: true, onClick: runSearch })]),
          element("div", { className: "actions" }, [
            caseSensitive.node, wholeWord.node, regex.node,
            field("Context (words)", windowInput, { inline: false }),
          ]),
          status,
          resultsWrap,
        );

        status.textContent = documents.length
          ? `${documents.length} line(s) loaded. Enter a word or phrase to search for.`
          : "No text loaded — choose an output folder.";
      },
    },
  };
}
