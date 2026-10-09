import { button, checkbox, element, field, select } from "../../../src/_panel.js";
import { BUILDER_NAMES, validatePlotsConfig } from "../model.js";

const clone = (value) => JSON.parse(JSON.stringify(value));
const jsonText = (value) => JSON.stringify(value ?? {}, null, 2);
const parseJson = (text, label) => {
  try { return JSON.parse(text); }
  catch (error) { throw new Error(`${label}: ${error.message}`); }
};

const commonFields = [
  ["title", "Title", "text"], ["subtitle", "Subtitle", "text"],
];
const xFields = [
  ["xVar", "X field", "column"], ["xType", "X field type", "field-type"],
  ["xTitle", "X-axis title", "text"], ["xLabels", "X-axis labels (JSON)", "json"],
  ["xTimeUnit", "X-axis time unit", "text"], ["xTooltipTitle", "X tooltip title", "text"],
  ["xTooltipTimeUnit", "X tooltip time unit", "text"], ["yTitle", "Y-axis title", "text"],
];
const yFields = [
  ["yVar", "Y field", "column"], ["yType", "Y field type", "field-type"],
  ["yTitle", "Y-axis title", "text"], ["yLabels", "Y-axis labels (JSON)", "json"],
  ["yTimeUnit", "Y-axis time unit", "text"], ["yTooltipTitle", "Y tooltip title", "text"],
  ["yTooltipTimeUnit", "Y tooltip time unit", "text"],
];
const colorFields = [
  ["colorVar", "Color field", "column"], ["colorType", "Color field type", "field-type"],
  ["colorTitle", "Color legend title", "text"], ["colorLabels", "Color labels (JSON)", "json"],
  ["colorTooltipTitle", "Color tooltip title", "text"], ["palette", "Palette (name or JSON)", "json-or-text"],
];
const BUILDER_FIELDS = {
  barPlotCount: [...xFields.filter(([key]) => key !== "xType"), ["yTitle", "Y-axis title", "text"], ["yLabels", "Y-axis labels (JSON)", "json"], ["yTooltipTitle", "Y tooltip title", "text"], ...colorFields, ...commonFields],
  scatterPlot: [...xFields, ...yFields, ...colorFields, ...commonFields],
  boxPlot: [...xFields, ...yFields, ...colorFields, ...commonFields],
  histogramPlot: [
    ...xFields,
    ...yFields.filter(([key]) => key !== "yVar" && key !== "yType"),
    ["maxbins", "Maximum bins", "number"], ["minstep", "Minimum bin step", "number"],
    ["step", "Bin step", "number"], ["nice", "Use nice bin boundaries", "boolean"],
    ...colorFields, ...commonFields,
  ],
  plotMapHeatmap: [
    ["latitudeField", "Latitude column", "column"], ["longitudeField", "Longitude column", "column"],
    ["weightField", "Weight column (optional)", "column"], ["bandwidth", "Bandwidth (number or JSON pair)", "json-or-number"],
    ["nContours", "Contour count", "number"], ["opacity", "Heatmap opacity", "number"],
    ["palette", "Palette", "text"], ["zoom", "Map zoom (optional)", "number"],
    ["targetSizePx", "Map image size (px)", "number"], ["provider", "Map provider (JSON)", "json"],
    ...commonFields,
  ],
};

const LABEL_SOURCES = { xLabels: "xVar", yLabels: "yVar", colorLabels: "colorVar" };
const TRI_STATE = [{ value: "", label: "Inherit global" }, { value: "true", label: "On" }, { value: "false", label: "Off" }];
const EMBED_CONTROLS = [
  ["renderer", "Renderer", [{ value: "", label: "Inherit global" }, { value: "svg", label: "SVG" }, { value: "canvas", label: "Canvas" }]],
  ["tooltip", "Tooltips", TRI_STATE],
  ["defaultStyle", "Default chart styling", TRI_STATE],
  ["actions", "Action links", [{ value: "", label: "Inherit global" }, { value: "true", label: "Show" }, { value: "false", label: "Hide" }]],
  ["logLevel", "Log level", [
    { value: "", label: "Inherit global" }, { value: "0", label: "None" }, { value: "1", label: "Error" },
    { value: "2", label: "Warning" }, { value: "3", label: "Info" }, { value: "4", label: "Debug" },
  ]],
];

/** What ro-crate-plots uses when a field is left empty, mirroring lib/plots.js and lib/mapplots.js. */
function defaultPlaceholders(builder, args) {
  const text = (value) => (value === undefined || value === null ? "" : String(value));
  const x = text(args.xVar);
  const y = text(args.yVar);
  const color = text(args.colorVar);
  const xTitle = text(args.xTitle) || x;
  const colorTitle = text(args.colorTitle) || color;
  const counted = builder === "barPlotCount" || builder === "histogramPlot";
  const yTitle = counted ? `Count of ${xTitle || "the X field"}` : y;
  return {
    title: "No title", subtitle: "No subtitle",
    xTitle: x, xTooltipTitle: xTitle, xTimeUnit: "None", xTooltipTimeUnit: text(args.xTimeUnit) || "None",
    yTitle, yTooltipTitle: text(args.yTitle) || yTitle, yTimeUnit: "None", yTooltipTimeUnit: text(args.yTimeUnit) || "None",
    colorTitle: color, colorTooltipTitle: colorTitle,
    palette: builder === "plotMapHeatmap" ? "turbo" : "Default colors",
    maxbins: "Auto", minstep: "Auto", step: "Auto",
    bandwidth: "Auto (-1)", nContours: "10", opacity: "0.5", zoom: "Auto", targetSizePx: "300",
    provider: "OpenStreetMap (default)",
  };
}

const advanced = (summary, control) => element("details", { className: "plots-editor-advanced" }, [
  element("summary", { text: summary }), control,
]);

/** Dropdowns for one plot's Vega Embed overrides; unknown keys are left untouched. */
function embedControls(card, sync) {
  return EMBED_CONTROLS.map(([key, label, options]) => {
    const current = card.embed[key];
    const currentValue = current === undefined ? "" : String(current);
    const known = options.some((option) => option.value === currentValue);
    const control = select(
      known ? options : [...options, { value: "__keep", label: "Custom (unchanged)" }],
      { value: known ? currentValue : "__keep" },
    );
    control.addEventListener("change", () => {
      if (control.value === "__keep") return;
      if (control.value === "") delete card.embed[key];
      else if (key === "logLevel") card.embed[key] = Number(control.value);
      else if (control.value === "true" || control.value === "false") card.embed[key] = control.value === "true";
      else card.embed[key] = control.value;
      sync();
    });
    return field(label, control);
  });
}

/** Value-to-label rows, e.g. Female -> F, so long values do not crowd the plot. */
function labelsEditor({ label, labels, getValues, onChange, kind = "text" }) {
  const entries = Object.entries(labels && typeof labels === "object" ? labels : {});
  const wrap = element("div", { className: "plots-editor-labels" });
  const rows = element("div");
  const picker = element("select", { attrs: { "aria-label": `${label}: choose a value to label` } });
  const commit = () => onChange(Object.fromEntries(entries.filter(([, text]) => text !== "")));
  function refreshPicker() {
    const labelled = new Set(entries.map(([value]) => value));
    const available = getValues().filter((value) => !labelled.has(value));
    picker.replaceChildren(
      element("option", { text: available.length ? "Choose a value…" : "No more values", attrs: { value: "" } }),
      ...available.map((value) => element("option", { text: value, attrs: { value } })),
    );
    add.disabled = !available.length;
  }
  function renderRows(focusIndex) {
    rows.replaceChildren(...entries.map((entry, index) => {
      const valueInput = element("input", { attrs: { type: "text", value: entry[0], readonly: true, "aria-label": `${label}: value ${index + 1}` } });
      const labelInput = element("input", { attrs: { type: "text", value: entry[1], placeholder: kind === "color" ? "#ff69b4" : "Label shown", "aria-label": `${kind === "color" ? "Color" : "Label"} for ${entry[0]}` } });
      let labelControl = labelInput;
      if (kind === "color") {
        const swatch = element("input", { attrs: { type: "color", value: HEX_COLOR.test(entry[1]) ? entry[1] : "#888888", "aria-label": `Pick a color for ${entry[0]}` } });
        swatch.addEventListener("input", () => { labelInput.value = swatch.value; entry[1] = swatch.value; commit(); });
        labelInput.addEventListener("change", () => {
          if (HEX_COLOR.test(labelInput.value.trim())) swatch.value = labelInput.value.trim();
        });
        labelControl = element("div", { className: "plots-editor-color-control" }, [swatch, labelInput]);
      }
      labelInput.addEventListener("change", () => { entry[1] = labelInput.value.trim(); commit(); });
      const remove = button("Remove", { onClick: () => { entries.splice(index, 1); commit(); renderRows(); } });
      if (index === focusIndex) queueMicrotask(() => labelInput.focus());
      return element("div", { className: "plots-editor-label-row" }, [valueInput, labelControl, remove]);
    }));
    refreshPicker();
  }
  const add = button("+", {
    title: "Add a label for the chosen value",
    onClick: () => {
      if (!picker.value) return;
      entries.push([picker.value, ""]);
      renderRows(entries.length - 1);
    },
  });
  picker.addEventListener("focus", refreshPicker);
  picker.addEventListener("pointerdown", refreshPicker);
  wrap.append(
    element("strong", { text: label }),
    element("p", { className: "field-hint", text: kind === "color"
      ? "Pick a value, press +, then choose its color or type it as hex (for example #ff69b4) or a color name."
      : "Pick a value, press +, then type the label to show on the plot, for example F for Female." }),
    rows, element("div", { className: "actions" }, [picker, add]),
  );
  renderRows();
  return wrap;
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

// Named color schemes built into Vega, grouped as in its documentation.
const VEGA_SCHEMES = [
  ["Categorical", ["accent", "category10", "category20", "category20b", "category20c", "dark2", "paired", "pastel1", "pastel2", "set1", "set2", "set3", "tableau10", "tableau20"]],
  ["Single hue", ["blues", "greens", "greys", "oranges", "purples", "reds"]],
  ["Multi hue", ["bluegreen", "bluepurple", "goldgreen", "goldorange", "goldred", "greenblue", "orangered", "purplebluegreen", "purpleblue", "purplered", "redpurple", "yellowgreenblue", "yellowgreen", "yelloworangebrown", "yelloworangered", "darkblue", "darkgold", "darkgreen", "darkmulti", "darkred", "lightgreyred", "lightgreyteal", "lightmulti", "lightorange", "lighttealblue"]],
  ["Diverging", ["blueorange", "brownbluegreen", "purplegreen", "pinkyellowgreen", "purpleorange", "redblue", "redgrey", "redyellowblue", "redyellowgreen", "spectral"]],
  ["Perceptual", ["viridis", "magma", "inferno", "plasma", "cividis", "turbo", "rainbow", "sinebow"]],
];

/** Palette choice: default, a named Vega scheme, or a color per data value. */
function paletteEditor({ palette, getValues, onChange, allowCustom }) {
  const isMap = palette !== null && typeof palette === "object" && !Array.isArray(palette);
  const startMode = Array.isArray(palette) ? "list" : isMap ? "custom" : typeof palette === "string" && palette ? "named" : "default";
  const modes = [
    { value: "default", label: "Default colors" },
    { value: "named", label: "Named palette" },
    ...(allowCustom ? [{ value: "custom", label: "Color per value" }] : []),
    ...(startMode === "list" ? [{ value: "list", label: "Color list (unchanged)" }] : []),
  ];
  const modeSelect = select(modes, { value: startMode });
  const body = element("div");
  const wrap = element("div", { className: "plots-editor-labels" }, [
    element("strong", { text: "Palette" }), field("Colors", modeSelect), body,
  ]);

  function renderBody(mode) {
    body.replaceChildren();
    if (mode === "named") {
      const known = VEGA_SCHEMES.some(([, names]) => names.includes(palette));
      const schemeSelect = element("select", { attrs: { "aria-label": "Named palette" } }, [
        element("option", { text: "Choose a palette…", attrs: { value: "" } }),
        ...(typeof palette === "string" && palette && !known ? [element("option", { text: palette, attrs: { value: palette } })] : []),
        ...VEGA_SCHEMES.map(([group, names]) => element("optgroup", { attrs: { label: group } },
          names.map((name) => element("option", { text: name, attrs: { value: name } })))),
      ]);
      schemeSelect.value = typeof palette === "string" ? palette : "";
      schemeSelect.addEventListener("change", () => onChange(schemeSelect.value || undefined));
      body.append(field("Palette", schemeSelect));
    } else if (mode === "custom") {
      body.append(labelsEditor({
        label: "Color for each value", labels: isMap ? palette : {}, getValues, kind: "color", onChange,
      }));
    }
  }

  modeSelect.addEventListener("change", () => {
    if (modeSelect.value === "list") return;
    onChange(undefined);
    palette = undefined;
    renderBody(modeSelect.value);
  });
  renderBody(startMode);
  return wrap;
}

function uniqueDatasetName(source, used) {
  const leaf = String(source).split("/").pop() || "dataset";
  const base = leaf.replace(/\.[^.]*$/, "") || "dataset";
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) candidate = `${base} ${suffix++}`;
  used.add(candidate);
  return candidate;
}

function createEditorState(config) {
  const plots = config.plots;
  return {
    base: clone(config),
    globalOptions: clone(plots.globalConfig || {}),
    datasets: Object.entries(plots.datasets).map(([name, value]) => ({
      name,
      originalName: name,
      descriptor: typeof value === "string" ? { path: value } : clone(value),
      source: typeof value === "string" ? value : value?.source || value?.path || "",
    })),
    cards: plots.plotList.map((plot) => ({
      original: clone(plot),
      mode: plot.customSpec && Object.keys(plot.customSpec).length ? "custom" : "builder",
      name: plot.dataset?.name || "",
      title: typeof plot.makeSpec?.args?.title === "string"
        ? plot.makeSpec.args.title
        : typeof plot.customSpec?.title === "string" ? plot.customSpec.title : "",
      titleEdited: false,
      span: Number(plot.plotCardSpan ?? plot.span ?? 1),
      argsText: jsonText(plot.makeSpec?.args),
      customText: jsonText(plot.customSpec),
      embed: clone(plot.config || {}),
      builder: plot.makeSpec?.plotFunction || "barPlotCount",
    })),
    error: "",
  };
}

function ensureStyle() {
  if (document.getElementById("plots-editor-style")) return;
  const style = element("style", { attrs: { id: "plots-editor-style" } });
  style.textContent = `
.modal-panel.plots-config-modal { width: min(980px, 96vw); }
.plots-editor-scroll { max-height: min(70vh, 760px); overflow: auto; padding-right: 4px; }
.plots-editor-section { margin: 0 0 18px; }
.plots-editor-section > h3 { margin: 0 0 8px; font-size: 15px; }
.plots-editor-dataset, .plots-editor-plot { border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 10px; margin: 8px 0; }
.plots-editor-dataset { display: grid; grid-template-columns: minmax(9rem, 1fr) minmax(12rem, 2fr) auto; gap: 8px; align-items: end; }
.plots-editor-plot-head { display: grid; grid-template-columns: minmax(10rem, 1fr) minmax(10rem, 1fr) auto auto auto; gap: 8px; align-items: end; }
.plots-editor-json { width: 100%; min-height: 8rem; font: 12px/1.4 var(--mono); }
.plots-editor-plot-title { margin: 0 0 8px; font-size: 14px; }
.plots-editor-advanced { margin: 8px 0; }
.plots-editor-advanced > summary { cursor: pointer; font-size: 13px; }
.plots-editor-labels { margin: 10px 0; }
.plots-editor-label-row { display: grid; grid-template-columns: 1fr 1fr auto; gap: 8px; margin: 4px 0; }
.plots-editor-color-control { display: flex; gap: 6px; align-items: center; }
.plots-editor-color-control input[type="color"] { width: 2.5rem; padding: 0; flex: none; }
.plots-editor-error { color: var(--err); min-height: 1.2em; }
@media (max-width: 700px) { .plots-editor-plot-head, .plots-editor-dataset { grid-template-columns: 1fr 1fr; } }
`;
  document.head.append(style);
}

/** Edit a plots config; null means the modal was cancelled. */
export async function openPlotsConfigEditor({ config, tables, openModal }) {
  ensureStyle();
  const state = createEditorState(config);
  const tableSources = [...new Set((tables || []).map((table) => table.source))];

  while (true) {
    let saveConfig = () => undefined;
    const outcome = await openModal({
      title: "Configure plots",
      modalClassName: "plots-config-modal",
      onMount(body) {
        const scroll = element("div", { className: "plots-editor-scroll" });
        const intro = element("p", { text: "Bind loaded tables to dataset names, then add and order plots. Open the advanced sections to edit every builder argument and Vega option as JSON." });
        const error = element("p", { className: "plots-editor-error", attrs: { role: "alert" }, text: state.error });
        const sections = element("div");
        const globalSection = element("section", { className: "plots-editor-section" });
        const datasets = element("section", { className: "plots-editor-section" });
        const plots = element("section", { className: "plots-editor-section" });
        scroll.append(intro, error, sections);
        body.append(scroll);

        const globalTitle = element("h3", { text: "Global Vega Embed options" });
        const originalActions = state.globalOptions.actions;
        const actionOptions = originalActions && typeof originalActions === "object" ? originalActions : {};
        const exportOptions = actionOptions.export && typeof actionOptions.export === "object"
          ? actionOptions.export : {};
        const actionEnabled = checkbox("Show Vega action links", { checked: originalActions !== false });
        const exportEnabled = checkbox("Export actions", { checked: actionOptions.export !== false });
        const exportPng = checkbox("PNG export", { checked: exportOptions.png !== false });
        const exportSvg = checkbox("SVG export", { checked: exportOptions.svg !== false });
        const sourceAction = checkbox("View source", { checked: actionOptions.source !== false });
        const compiledAction = checkbox("View compiled Vega", { checked: actionOptions.compiled === true });
        const editorAction = checkbox("Open in Vega Editor", { checked: actionOptions.editor !== false });
        const rendererSelect = select([
          { value: "", label: "Default" },
          { value: "svg", label: "SVG" },
          { value: "canvas", label: "Canvas" },
        ], { value: state.globalOptions.renderer || "" });
        const tooltipSelect = select([
          { value: "", label: "Default" },
          { value: "true", label: "On" },
          { value: "false", label: "Off" },
        ], { value: typeof state.globalOptions.tooltip === "boolean" ? String(state.globalOptions.tooltip) : "" });
        const styleSelect = select([
          { value: "", label: "Default" },
          { value: "true", label: "On" },
          { value: "false", label: "Off" },
        ], { value: typeof state.globalOptions.defaultStyle === "boolean" ? String(state.globalOptions.defaultStyle) : "" });
        const logLevelSelect = select([
          { value: "", label: "Default (Warn)" },
          { value: "0", label: "None" },
          { value: "1", label: "Error" },
          { value: "2", label: "Warning" },
          { value: "3", label: "Info" },
          { value: "4", label: "Debug" },
        ], { value: state.globalOptions.logLevel == null ? "" : String(state.globalOptions.logLevel) });
        const actionDetails = element("div", { className: "actions" }, [
          exportEnabled.node, exportPng.node, exportSvg.node,
          sourceAction.node, compiledAction.node, editorAction.node,
        ]);
        const updateActionAvailability = () => {
          actionDetails.hidden = !actionEnabled.input.checked;
          exportPng.node.hidden = !actionEnabled.input.checked || !exportEnabled.input.checked;
          exportSvg.node.hidden = !actionEnabled.input.checked || !exportEnabled.input.checked;
        };
        actionEnabled.input.addEventListener("change", updateActionAvailability);
        exportEnabled.input.addEventListener("change", updateActionAvailability);
        updateActionAvailability();
        globalSection.append(
          globalTitle,
          element("div", { className: "actions" }, [
            field("Renderer", rendererSelect),
            field("Tooltips", tooltipSelect),
            field("Default chart styling", styleSelect),
            field("Log level", logLevelSelect),
          ]),
          actionEnabled.node,
          actionDetails,
        );

        const datasetHeading = element("h3", { text: "Datasets" });
        const datasetList = element("div");
        datasets.append(datasetHeading, datasetList);

        function renderDatasets() {
          datasetList.replaceChildren();
          for (const [index, dataset] of state.datasets.entries()) {
            const nameInput = element("input", { attrs: { type: "text", value: dataset.name, "aria-label": "Dataset name" } });
            const sourceSelect = element("select", { attrs: { "aria-label": `Table for ${dataset.name}` } });
            const available = [...new Set([...tableSources, ...(dataset.source && !tableSources.includes(dataset.source) ? [dataset.source] : [])])];
            sourceSelect.append(...available.map((source) => element("option", { text: source, attrs: { value: source } })));
            sourceSelect.value = dataset.source;
            nameInput.addEventListener("change", () => {
              const priorName = dataset.name;
              const nextName = nameInput.value.trim();
              if (!nextName) return;
              dataset.name = nextName;
              for (const card of state.cards) if (card.name === priorName) card.name = nextName;
              renderDatasets();
              renderPlots();
            });
            sourceSelect.addEventListener("change", () => { dataset.source = sourceSelect.value; renderPlots(); });
            const remove = button("Remove dataset", {
              title: "Remove dataset",
              onClick: () => {
                if (state.cards.some((card) => card.name === dataset.name)) {
                  state.error = `Remove plots using '${dataset.name}' before removing this dataset.`;
                  error.textContent = state.error;
                  return;
                }
                state.datasets.splice(index, 1);
                renderDatasets();
                renderPlots();
              },
            });
            datasetList.append(element("div", { className: "plots-editor-dataset" }, [
              field("Dataset name", nameInput), field("Loaded table", sourceSelect), remove,
            ]));
          }
          const addSource = selectTableSource();
          const addDataset = button("Add dataset", {
            onClick: () => {
              const source = addSource.value;
              if (!source || state.datasets.some((dataset) => dataset.source === source)) return;
              const used = new Set(state.datasets.map((dataset) => dataset.name));
              const name = uniqueDatasetName(source, used);
              state.datasets.push({ name, originalName: name, source, descriptor: {} });
              renderDatasets();
              renderPlots();
            },
          });
          datasetList.append(element("div", { className: "actions" }, [addSource, addDataset]));
        }

        function selectTableSource() {
          return element("select", { attrs: { "aria-label": "Select loaded table" } }, tableSources.map((source) => element("option", { text: source, attrs: { value: source } })));
        }

        function renderPlots() {
          plots.replaceChildren(element("h3", { text: "Plots" }));
          state.cards.forEach((card, index) => {
            const cardNode = element("article", { className: "plots-editor-plot" });
            const titleInput = element("input", { attrs: { type: "text", value: card.title, placeholder: "No title", "aria-label": `Plot ${index + 1} title` } });
            const datasetSelect = element("select", { attrs: { "aria-label": `Dataset for plot ${index + 1}` } });
            datasetSelect.append(...state.datasets.map((dataset) => element("option", { text: dataset.name, attrs: { value: dataset.name } })));
            datasetSelect.value = card.name;
            const builderSelect = element("select", { attrs: { "aria-label": `Builder for plot ${index + 1}` } });
            builderSelect.append(
              ...BUILDER_NAMES.map((name) => element("option", { text: name, attrs: { value: name } })),
              element("option", { text: "Custom Vega / Vega-Lite spec", attrs: { value: "custom" } }),
            );
            if (card.mode === "builder" && !BUILDER_NAMES.includes(card.builder)) {
              builderSelect.append(element("option", { text: `${card.builder} (not available)`, attrs: { value: card.builder } }));
            }
            builderSelect.value = card.mode === "custom" ? "custom" : card.builder;
            const spanSelect = element("select", { attrs: { "aria-label": `Width for plot ${index + 1}` } }, [1, 2, 3].map((width) => element("option", { text: `${width} column${width === 1 ? "" : "s"}`, attrs: { value: width } })));
            spanSelect.value = String(card.span);
            const plotHeading = () => card.title.trim() || `Plot ${index + 1}`;
            const heading = element("h4", { className: "plots-editor-plot-title", text: plotHeading() });
            titleInput.addEventListener("input", () => {
              card.title = titleInput.value;
              card.titleEdited = true;
              heading.textContent = plotHeading();
            });
            datasetSelect.addEventListener("change", () => { card.name = datasetSelect.value; renderPlots(); });
            builderSelect.addEventListener("change", () => {
              card.mode = builderSelect.value === "custom" ? "custom" : "builder";
              if (card.mode === "builder") card.builder = builderSelect.value;
              renderPlots();
            });
            spanSelect.addEventListener("change", () => { card.span = Number(spanSelect.value); });

            const moveUp = button("Move up", { title: "Move plot up", onClick: () => movePlot(index, -1) });
            const moveDown = button("Move down", { title: "Move plot down", onClick: () => movePlot(index, 1) });
            const remove = button("Remove plot", { title: "Remove plot", onClick: () => { state.cards.splice(index, 1); renderPlots(); } });
            const head = element("div", { className: "plots-editor-plot-head" }, [
              field("Title", titleInput), field("Dataset", datasetSelect),
              field("Plot type", builderSelect), field("Card width", spanSelect),
              element("div", { className: "actions" }, [moveUp, moveDown, remove]),
            ]);
            cardNode.append(heading, head);

            if (card.mode === "custom") {
              const customText = element("textarea", { className: "plots-editor-json", attrs: { "aria-label": `Custom spec JSON for plot ${index + 1}`, spellcheck: "false" } });
              customText.value = card.customText;
              customText.addEventListener("input", () => { card.customText = customText.value; });
              cardNode.append(field("Custom Vega or Vega-Lite specification", customText));
            } else {
              const argsText = element("textarea", { className: "plots-editor-json", attrs: { "aria-label": `Builder arguments JSON for plot ${index + 1}`, spellcheck: "false" } });
              argsText.value = card.argsText;
              const typedFields = element("div", { className: "actions" });
              const labelFields = element("div");
              function currentArgs() {
                const parsed = parseJson(card.argsText, `Plot ${index + 1} builder arguments`);
                return parsed && !Array.isArray(parsed) && typeof parsed === "object" ? parsed : {};
              }
              function currentTable() {
                const descriptor = state.datasets.find((dataset) => dataset.name === card.name);
                return tables.find((table) => table.source === descriptor?.source);
              }
              function fieldChoices() {
                return currentTable()?.header || [];
              }
              function distinctValues(column) {
                const table = currentTable();
                const position = table && column ? table.header.indexOf(column) : -1;
                if (position < 0) return [];
                return [...new Set(table.rows.map((row) => String(row[position] ?? "")).filter(Boolean))].slice(0, 200);
              }
              function setLabels(key, labels) {
                let args;
                try { args = currentArgs(); }
                catch (error) { state.error = error.message; return; }
                if (Object.keys(labels).length) args[key] = labels;
                else delete args[key];
                card.argsText = jsonText(args);
                argsText.value = card.argsText;
              }
              function setArgValue(key, value) {
                let args;
                try { args = currentArgs(); }
                catch (error) { state.error = error.message; return; }
                const empty = value === undefined || value === ""
                  || (value !== null && typeof value === "object" && !Array.isArray(value) && !Object.keys(value).length);
                if (empty) delete args[key];
                else args[key] = value;
                card.argsText = jsonText(args);
                argsText.value = card.argsText;
              }
              function updateArgument(key, kind, raw) {
                let args;
                try { args = currentArgs(); }
                catch (error) { state.error = error.message; return; }
                if (raw === "") delete args[key];
                else if (kind === "number") {
                  const value = Number(raw);
                  if (!Number.isFinite(value)) return;
                  args[key] = value;
                } else if (kind === "boolean") args[key] = raw === "true";
                else if (kind === "json" || kind === "json-or-number") {
                  try { args[key] = JSON.parse(raw); }
                  catch (error) { state.error = `${key}: ${error.message}`; return; }
                } else if (kind === "json-or-text") {
                  try { args[key] = JSON.parse(raw); } catch { args[key] = raw; }
                } else args[key] = raw;
                card.argsText = jsonText(args);
                argsText.value = card.argsText;
                refreshPlaceholders();
              }
              const args = currentArgs();
              const placeholderInputs = new Map();
              function refreshPlaceholders() {
                let current;
                try { current = currentArgs(); }
                catch { return; }
                const defaults = defaultPlaceholders(card.builder, current);
                for (const [key, input] of placeholderInputs) input.placeholder = defaults[key] ?? "";
              }
              for (const [key, label, kind] of BUILDER_FIELDS[card.builder] || []) {
                if (key === "title") continue;
                if (key === "palette") {
                  labelFields.append(paletteEditor({
                    palette: args.palette,
                    allowCustom: card.builder !== "plotMapHeatmap",
                    getValues: () => { try { return distinctValues(currentArgs().colorVar); } catch { return []; } },
                    onChange: (value) => setArgValue("palette", value),
                  }));
                  continue;
                }
                if (LABEL_SOURCES[key]) {
                  labelFields.append(labelsEditor({
                    label: label.replace(" (JSON)", ""),
                    labels: args[key],
                    getValues: () => { try { return distinctValues(currentArgs()[LABEL_SOURCES[key]]); } catch { return []; } },
                    onChange: (labels) => setLabels(key, labels),
                  }));
                  continue;
                }
                let control;
                const raw = args[key] === undefined ? "" : typeof args[key] === "object" ? jsonText(args[key]) : String(args[key]);
                if (kind === "column" || kind === "field-type") {
                  control = element("select", { attrs: { "aria-label": label } });
                  control.append(element("option", { text: "(not set)", attrs: { value: "" } }));
                  const values = kind === "column" ? fieldChoices() : ["quantitative", "temporal", "ordinal", "nominal"];
                  control.append(...values.map((value) => element("option", { text: value, attrs: { value } })));
                  control.value = raw;
                } else if (kind === "boolean") {
                  control = element("select", { attrs: { "aria-label": label } }, [
                    element("option", { text: "Default", attrs: { value: "" } }),
                    element("option", { text: "On", attrs: { value: "true" } }),
                    element("option", { text: "Off", attrs: { value: "false" } }),
                  ]);
                  control.value = raw;
                } else {
                  control = element("input", { attrs: { type: kind === "number" ? "number" : "text", value: raw, "aria-label": label } });
                  placeholderInputs.set(key, control);
                }
                control.addEventListener("change", () => updateArgument(key, kind, control.value));
                typedFields.append(field(label, control));
              }
              refreshPlaceholders();
              argsText.addEventListener("change", () => {
                card.argsText = argsText.value;
                try { parseJson(card.argsText, `Plot ${index + 1} builder arguments`); renderPlots(); }
                catch (error) { state.error = error.message; }
              });
              cardNode.append(typedFields, labelFields, advanced("All builder arguments (JSON)", argsText));
            }
            const embedJson = element("textarea", { className: "plots-editor-json", attrs: { "aria-label": `Vega Embed options JSON for plot ${index + 1}`, spellcheck: "false" } });
            embedJson.value = jsonText(card.embed);
            embedJson.addEventListener("change", () => {
              try {
                const parsed = parseJson(embedJson.value, `Plot ${index + 1} embed options`);
                if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error(`Plot ${index + 1} embed options must be a JSON object.`);
                card.embed = parsed;
                renderPlots();
              } catch (error) {
                state.error = error.message;
              }
            });
            cardNode.append(
              element("strong", { text: "Vega Embed options for this plot" }),
              element("div", { className: "actions" }, embedControls(card, () => { embedJson.value = jsonText(card.embed); })),
              advanced("Vega Embed options (JSON)", embedJson),
            );
            plots.append(cardNode);
          });

          const addType = element("select", { attrs: { "aria-label": "New plot type" } }, BUILDER_NAMES.map((name) => element("option", { text: name, attrs: { value: name } })));
          const addDatasetSelect = element("select", { attrs: { "aria-label": "Dataset for new plot" } }, state.datasets.map((dataset) => element("option", {
            text: dataset.name,
            attrs: { value: dataset.name },
          })));
          addDatasetSelect.value = state.cards.at(-1)?.name || state.datasets[0]?.name || "";
          const addPlotButton = button("Add plot", {
            primary: true,
            onClick: () => {
              const dataset = addDatasetSelect.value;
              if (!dataset) {
                state.error = "Add a dataset before adding a plot.";
                error.textContent = state.error;
                return;
              }
              state.cards.push({
                original: { dataset: { name: dataset }, makeSpec: { plotFunction: addType.value, args: {} }, generatedSpec: {}, customSpec: {}, config: {}, plotCardSpan: 1 },
                mode: "builder", builder: addType.value, name: dataset, title: "", span: 1,
                titleEdited: false, argsText: "{}", customText: "{}", embed: {},
              });
              renderPlots();
            },
          });
          addPlotButton.disabled = !state.datasets.length;
          plots.append(element("div", { className: "actions" }, [
            field("New plot type", addType),
            field("Use dataset", addDatasetSelect),
            addPlotButton,
          ]));
        }

        function movePlot(index, amount) {
          const target = index + amount;
          if (target < 0 || target >= state.cards.length) return;
          [state.cards[index], state.cards[target]] = [state.cards[target], state.cards[index]];
          renderPlots();
        }

        function collectConfig() {
          const next = clone(state.base);
          const globalConfig = clone(state.globalOptions);
          delete globalConfig.actions;
          if (actionEnabled.input.checked) {
            const priorExport = actionOptions.export && typeof actionOptions.export === "object"
              ? actionOptions.export : {};
            globalConfig.actions = {
              ...actionOptions,
              export: exportEnabled.input.checked
                ? { ...priorExport, png: exportPng.input.checked, svg: exportSvg.input.checked }
                : false,
              source: sourceAction.input.checked,
              compiled: compiledAction.input.checked,
              editor: editorAction.input.checked,
            };
          } else globalConfig.actions = false;
          if (rendererSelect.value) globalConfig.renderer = rendererSelect.value;
          if (tooltipSelect.value) globalConfig.tooltip = tooltipSelect.value === "true";
          if (styleSelect.value) globalConfig.defaultStyle = styleSelect.value === "true";
          if (logLevelSelect.value) globalConfig.logLevel = Number(logLevelSelect.value);
          next.plots.globalConfig = globalConfig;
          const datasets = {};
          for (const dataset of state.datasets) {
            if (!dataset.name) throw new Error("Every dataset needs a name.");
            if (Object.hasOwn(datasets, dataset.name)) throw new Error(`Dataset name '${dataset.name}' is duplicated.`);
            const descriptor = { ...clone(dataset.descriptor), source: dataset.source };
            datasets[dataset.name] = descriptor;
          }
          next.plots.datasets = datasets;
          next.plots.plotList = state.cards.map((card, index) => {
            const plot = clone(card.original);
            plot.dataset = { ...(plot.dataset || {}), name: card.name };
            plot.config = clone(card.embed);
            plot.plotCardSpan = card.span;
            plot.span = card.span;
            if (card.mode === "custom") {
              plot.customSpec = parseJson(card.customText, `Plot ${index + 1} custom spec`);
              if (!plot.customSpec || Array.isArray(plot.customSpec) || typeof plot.customSpec !== "object") {
                throw new Error(`Plot ${index + 1} custom spec must be a JSON object.`);
              }
              if (card.titleEdited) {
                if (card.title) plot.customSpec.title = card.title;
                else delete plot.customSpec.title;
              }
            } else {
              plot.makeSpec = { ...(plot.makeSpec || {}), plotFunction: card.builder, args: parseJson(card.argsText, `Plot ${index + 1} builder arguments`) };
              if (!plot.makeSpec.args || Array.isArray(plot.makeSpec.args) || typeof plot.makeSpec.args !== "object") {
                throw new Error(`Plot ${index + 1} builder arguments must be a JSON object.`);
              }
              if (card.titleEdited) {
                if (card.title) plot.makeSpec.args.title = card.title;
                else delete plot.makeSpec.args.title;
              }
              plot.customSpec = {};
            }
            return plot;
          });
          return validatePlotsConfig(next);
        }

        sections.append(globalSection, datasets, plots);
        renderDatasets();
        renderPlots();
        body.append(scroll);
        saveConfig = () => {
          try { return { config: collectConfig() }; }
          catch (error) { return { invalid: error.message }; }
        };
      },
      actions: [
        { label: "Cancel", value: null },
        { label: "Save configuration", primary: true, value: () => saveConfig() },
      ],
    });
    if (outcome === null) return null;
    if (outcome?.config) return outcome.config;
    if (outcome?.invalid) { state.error = outcome.invalid; continue; }
    return null;
  }
}