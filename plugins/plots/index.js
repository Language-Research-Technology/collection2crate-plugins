import embed from "vega-embed";
import { button, element, note } from "../../src/_panel.js";
import { createDefaultConfig, embedOptions, generatePlotSpecs, layoutSpan, validatePlotsConfig } from "./model.js";
import { openPlotsConfigEditor } from "./config/editor.js";

export const CONFIG_PATH = "_config/plots/config.json";

function afterLayout() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

export function createPlugin(deps = {}) {
  const { readFileTextFromDirectory, writeFileAtPath, openModal } = deps;
  return {
    name: "plots",
    visualisation: {
      label: "Plots",
      hint: "Build Vega and Vega-Lite plots from loaded RO-Crate tables.",
      render(container, { tables = [], dirHandle = null, log = () => {} }) {
        let config = createDefaultConfig(tables);
        let initialized = false;
        const status = element("p", { className: "field-hint" });
        const plotHost = element("div", { className: "plots-grid" });
        const configure = button("Configure plots…", { primary: true, onClick: () => editConfig() });
        const topbar = element("div", { className: "actions" }, [configure]);
        const empty = note("No plots configured yet. Choose Configure plots… to add a plot.");
        const loading = note("Loading plots configuration…");

        function show() {
          container.replaceChildren(
            element("h2", { text: "Plots" }),
            note("Create interactive Vega and Vega-Lite visualisations from tables loaded from this folder."),
            topbar,
            status,
            plotHost,
          );
        }

        async function editConfig() {
          if (!openModal) {
            status.textContent = "The host did not provide its configuration editor API.";
            return;
          }
          const edited = await openPlotsConfigEditor({ config, tables, openModal });
          if (!edited) return;
          try {
            const checked = validatePlotsConfig(edited);
            if (!dirHandle || !writeFileAtPath) {
              status.textContent = `Choose a collection folder before saving ${CONFIG_PATH}.`;
              return;
            }
            await writeFileAtPath(dirHandle, CONFIG_PATH, `${JSON.stringify(checked, null, 2)}\n`);
            config = checked;
            status.textContent = `Saved ${CONFIG_PATH}.`;
            await renderPlots();
          } catch (error) {
            status.textContent = `Could not save plots configuration: ${error.message}`;
            log(`Plots: could not save ${CONFIG_PATH}: ${error.message}`, "warn");
          }
        }

        async function renderPlots() {
          plotHost.replaceChildren();
          const { plots, missing } = await generatePlotSpecs(config, tables);
          if (!plots.length) {
            plotHost.append(empty);
            if (missing.length) status.textContent = `Configured datasets not currently loaded: ${missing.map((item) => item.name).join(", ")}.`;
            else if (!tables.length) status.textContent = "No tables loaded. Select an output folder containing roctable CSVs, then configure plots.";
            else status.textContent = "No plots configured yet.";
            return;
          }
          const grid = element("div", { className: "plots-grid-inner" });
          const pendingEmbeds = [];
          for (const result of plots) {
            const card = element("section", { className: "plots-card" });
            card.style.gridColumn = `span ${layoutSpan(result.plot)}`;
            const title = result.plot.makeSpec?.args?.title
              || result.plot.customSpec?.title
              || result.plot.dataset?.name
              || `Plot ${result.index + 1}`;
            card.append(element("h3", { text: Array.isArray(title) ? title.join(" ") : String(title) }));
            if (result.error) {
              card.append(note(`Plot ${result.index + 1}: ${result.error}`));
            } else {
              for (const warning of result.warnings || []) card.append(note(warning));
              const target = element("div", { className: "plots-view" });
              card.append(target);
              pendingEmbeds.push({ target, result });
            }
            grid.append(card);
          }
          plotHost.append(grid);
          // Vega's container sizing needs the plot targets to be attached and
          // laid out; embedding while detached makes autosize measure zero.
          await afterLayout();
          for (const { target, result } of pendingEmbeds) {
            const options = embedOptions(config, result.plot);
            try {
              const embedded = await embed(target, result.spec, options);
              if (typeof ResizeObserver !== "undefined" && embedded?.view) {
                let previousWidth = target.getBoundingClientRect().width;
                const observer = new ResizeObserver((entries) => {
                  const width = entries[0]?.contentRect.width || 0;
                  if (!width || Math.abs(width - previousWidth) < 1) return;
                  previousWidth = width;
                  void embedded.view.resize().runAsync();
                });
                observer.observe(target);
              }
            } catch (error) {
              if (options.actions === false || options.actions === undefined) {
                target.replaceChildren(note(`Could not render plot ${result.index + 1}: ${error.message}`));
                continue;
              }
              try {
                const embedded = await embed(target, result.spec, { ...options, actions: false });
                const warning = note(`Plot rendered without Vega action links: ${error.message}`);
                target.before(warning);
                if (typeof ResizeObserver !== "undefined" && embedded?.view) {
                  let previousWidth = target.getBoundingClientRect().width;
                  const observer = new ResizeObserver((entries) => {
                    const width = entries[0]?.contentRect.width || 0;
                    if (!width || Math.abs(width - previousWidth) < 1) return;
                    previousWidth = width;
                    void embedded.view.resize().runAsync();
                  });
                  observer.observe(target);
                }
              } catch (fallbackError) {
                target.replaceChildren(note(`Could not render plot ${result.index + 1}: ${fallbackError.message} (action-link attempt: ${error.message})`));
              }
            }
          }
          const missingNames = missing.map((item) => item.name);
          status.textContent = missingNames.length ? `Datasets not loaded: ${missingNames.join(", ")}.` : "";
        }

        async function initialize() {
          show();
          status.textContent = "";
          if (!dirHandle || !readFileTextFromDirectory) {
            status.textContent = `Choose a collection folder to load or save ${CONFIG_PATH}.`;
            await renderPlots();
            return;
          }
          try {
            const saved = await readFileTextFromDirectory(dirHandle, CONFIG_PATH);
            if (saved == null) {
              config = createDefaultConfig(tables);
              status.textContent = `No saved plots config. Create one at ${CONFIG_PATH}.`;
              await renderPlots();
              if (!initialized) await editConfig();
            } else {
              config = validatePlotsConfig(JSON.parse(saved));
              await renderPlots();
            }
          } catch (error) {
            status.textContent = `Could not load ${CONFIG_PATH}: ${error.message}. The saved file was left unchanged.`;
            config = createDefaultConfig(tables);
            await renderPlots();
          } finally {
            initialized = true;
          }
        }

        const style = element("style", { attrs: { id: "plots-panel-style" } });
        style.textContent = `
.plots-grid-inner { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px; }
.plots-card { min-width:0; border:1px solid var(--border); border-radius:var(--radius-sm); padding:12px; }
.plots-card h3 { margin:0 0 8px; font-size:1rem; }
.plots-view { display:block; width:100%; min-width:0; min-height:220px; overflow:auto; }
.plots-view.vega-embed { display:block; box-sizing:border-box; width:100%; max-width:100%; }
.plots-view.vega-embed.has-actions { height:320px; }
.plots-view.vega-embed > .chart-wrapper { width:100%; max-width:100%; }
@media(max-width:900px) { .plots-grid-inner { grid-template-columns:repeat(2,minmax(0,1fr)); } .plots-card[style*="span 3"] { grid-column:span 2 !important; } }
@media(max-width:600px) { .plots-grid-inner { grid-template-columns:1fr; } .plots-card { grid-column:span 1 !important; } }
`;
        if (!document.getElementById("plots-panel-style")) document.head.append(style);
        show();
        void initialize();
      },
    },
    outputPaths: [{ path: "_config/plots", kind: "dir" }],
  };
}
