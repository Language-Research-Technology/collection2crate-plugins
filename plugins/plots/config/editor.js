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
  ["xTooltipTimeUnit", "X tooltip time unit", "text"],
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
// Only scatterPlot takes Y time units; boxPlot and histogramPlot ignore them.
const yFieldsWithoutTimeUnits = yFields.filter(([key]) => key !== "yTimeUnit" && key !== "yTooltipTimeUnit");
const invalidValuesField = ["invalidValues", "Missing or invalid values", "invalid-values"];
const BUILDER_FIELDS = {
  barPlotCount: [...xFields.filter(([key]) => key !== "xType"), ["yTitle", "Y-axis title", "text"], ["yLabels", "Y-axis labels (JSON)", "json"], ["yTooltipTitle", "Y tooltip title", "text"], ["sort", "Bar order", "sort-count"], ...colorFields, invalidValuesField, ...commonFields],
  scatterPlot: [...xFields, ...yFields, ...colorFields, invalidValuesField, ...commonFields],
  boxPlot: [...xFields, ...yFieldsWithoutTimeUnits, ["sort", "Category order", "sort-order"], ...colorFields, invalidValuesField, ...commonFields],
  histogramPlot: [
    ...xFields,
    ...yFieldsWithoutTimeUnits.filter(([key]) => key !== "yVar" && key !== "yType"),
    ["maxbins", "Maximum bins", "number"], ["minstep", "Minimum bin step", "number"],
    ["step", "Bin step", "number"], ["nice", "Use nice bin boundaries", "boolean"],
    ...colorFields, invalidValuesField, ...commonFields,
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

/** The section of a plot card a builder argument belongs to, so each variable's controls sit together. */
function argumentGroup(builder, key) {
  if (builder === "plotMapHeatmap") {
    if (["latitudeField", "longitudeField", "weightField"].includes(key)) return "Location columns";
    if (["bandwidth", "nContours", "opacity", "palette"].includes(key)) return "Heatmap";
    if (["zoom", "targetSizePx", "provider"].includes(key)) return "Base map";
    return "Other";
  }
  if (key === "sort") return builder === "barPlotCount" ? "X axis" : "Other";
  if (/^x[A-Z]/.test(key)) return "X axis";
  if (/^y[A-Z]/.test(key)) return "Y axis";
  if (/^color[A-Z]/.test(key) || key === "palette") return "Color";
  if (["maxbins", "minstep", "step", "nice"].includes(key)) return "Bins";
  return "Other";
}

const GROUP_SYMBOLS = {
  "X axis": "↔", "Y axis": "↕", Color: "●", Bins: "▥", Other: "⋯",
  "Location columns": "⌖", Heatmap: "◍", "Base map": "▦", "Vega Embed options for this plot": "⚙",
};

/** A section heading with a small symbol to scan by; the symbol is hidden from screen readers. */
function groupLegend(name) {
  const symbol = GROUP_SYMBOLS[name];
  return element("legend", {}, [
    ...(symbol ? [element("span", { className: "plots-editor-group-symbol", text: symbol, attrs: { "aria-hidden": "true" } })] : []),
    element("span", { text: name }),
  ]);
}

/** "X-axis title" reads as "Axis title" once it sits under an X axis heading. */
function groupedLabel(label, group) {
  const prefix = { "X axis": /^X[ -]/, "Y axis": /^Y[ -]/, Color: /^Color /i }[group];
  if (!prefix || !prefix.test(label)) return label;
  const rest = label.replace(prefix, "");
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

const LABEL_SOURCES = { xLabels: "xVar", yLabels: "yVar", colorLabels: "colorVar" };
const INVALID_VALUE_CHOICES = [
  { value: "show", label: "Show and flag them" },
  { value: "hide", label: "Hide them" },
];
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
    xType: builder === "scatterPlot" ? "quantitative" : "",
    yType: builder === "scatterPlot" ? "quantitative" : "",
    invalidValues: "show",
  };
}

const TIME_UNIT_AXES = { xTimeUnit: "x", xTooltipTimeUnit: "x", yTimeUnit: "y", yTooltipTimeUnit: "y" };

/** Time units only mean something on a temporal axis; one already set stays visible so it can be cleared. */
function showTimeUnit(builder, args, key) {
  const axis = TIME_UNIT_AXES[key];
  if (!axis) return true;
  if (args[key] !== undefined && args[key] !== "") return true;
  // barPlotCount takes no xType and always draws its X field as nominal.
  const type = builder === "barPlotCount" && axis === "x"
    ? "nominal"
    : args[`${axis}Type`] || defaultPlaceholders(builder, args)[`${axis}Type`];
  return type === "temporal";
}

/** The categorical field a box plot sorts, mirroring boxPlot's choice of which axis is nominal. */
function boxPlotCategoryField(args) {
  const continuous = (type) => type === "quantitative" || type === "temporal";
  if (continuous(args.xType)) return args.yVar;
  if (continuous(args.yType)) return args.xVar;
  if (args.xType === "nominal") return args.xVar;
  if (args.yType === "nominal") return args.yVar;
  return undefined;
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

/** Ordered values shown first on a category axis; values left out keep their default order after them. */
function orderEditor({ values, getValues, onChange }) {
  const entries = Array.isArray(values) ? values.map(String) : [];
  const rows = element("div");
  const picker = element("select", { attrs: { "aria-label": "Choose a value to place next" } });
  function refreshPicker() {
    const placed = new Set(entries);
    const available = getValues().filter((value) => !placed.has(value));
    picker.replaceChildren(
      element("option", { text: available.length ? "Choose a value…" : "No more values", attrs: { value: "" } }),
      ...available.map((value) => element("option", { text: value, attrs: { value } })),
    );
    add.disabled = !available.length;
    addRest.disabled = !available.length;
  }
  function renderRows() {
    rows.replaceChildren(...entries.map((value, index) => {
      const move = (amount) => {
        const target = index + amount;
        if (target < 0 || target >= entries.length) return;
        [entries[index], entries[target]] = [entries[target], entries[index]];
        onChange([...entries]);
        renderRows();
      };
      const up = button("Up", { title: `Move ${value} earlier`, onClick: () => move(-1) });
      const down = button("Down", { title: `Move ${value} later`, onClick: () => move(1) });
      const remove = button("Remove", { onClick: () => { entries.splice(index, 1); onChange([...entries]); renderRows(); } });
      up.disabled = index === 0;
      down.disabled = index === entries.length - 1;
      return element("div", { className: "plots-editor-order-row" }, [
        element("span", { text: `${index + 1}. ${value}` }), up, down, remove,
      ]);
    }));
    refreshPicker();
  }
  const add = button("+", {
    title: "Place the chosen value next",
    onClick: () => {
      if (!picker.value) return;
      entries.push(picker.value);
      onChange([...entries]);
      renderRows();
    },
  });
  const addRest = button("Add the rest", {
    title: "Place every remaining value in its current order",
    onClick: () => {
      const placed = new Set(entries);
      entries.push(...getValues().filter((value) => !placed.has(value)));
      onChange([...entries]);
      renderRows();
    },
  });
  picker.addEventListener("focus", refreshPicker);
  picker.addEventListener("pointerdown", refreshPicker);
  const wrap = element("div", {}, [
    element("p", { className: "field-hint", text: "Listed values come first, in this order; any others follow in their default order." }),
    rows, element("div", { className: "actions" }, [picker, add, addRest]),
  ]);
  renderRows();
  return wrap;
}

/** Category order: library default, by count (bar plots only), or an explicit list. */
function sortEditor({ label, sort, byCount, getValues, onChange }) {
  const startMode = Array.isArray(sort) ? "custom"
    : byCount && (sort === "descending" || sort === "ascending") ? sort
      : sort === undefined ? "default" : "keep";
  const modes = [
    { value: "default", label: "Default order" },
    ...(byCount ? [
      { value: "descending", label: "Most frequent first" },
      { value: "ascending", label: "Least frequent first" },
    ] : []),
    { value: "custom", label: "Custom order" },
    ...(startMode === "keep" ? [{ value: "keep", label: "Custom (unchanged)" }] : []),
  ];
  const modeSelect = select(modes, { value: startMode });
  const body = element("div");
  const renderBody = (mode) => {
    body.replaceChildren(...(mode === "custom"
      ? [orderEditor({ values: Array.isArray(sort) ? sort : [], getValues, onChange: (values) => onChange(values.length ? values : undefined) })]
      : []));
  };
  modeSelect.addEventListener("change", () => {
    const mode = modeSelect.value;
    if (mode === "keep") return;
    sort = mode === "descending" || mode === "ascending" ? mode : undefined;
    onChange(sort);
    renderBody(mode);
  });
  renderBody(startMode);
  return element("div", { className: "plots-editor-labels" }, [
    element("strong", { text: label }), field("Order", modeSelect), body,
  ]);
}

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

// Distinct hues, readable with white text in light and dark themes, to tell plot cards apart at a glance.
const PLOT_HUES = ["#2563eb", "#0f766e", "#c2410c", "#7c3aed", "#be123c", "#4d7c0f", "#a16207", "#0e7490"];
const plotHues = new WeakMap();
let nextPlotHue = 0;
/** A card keeps its hue when reordered, so a moved plot is still recognisable. */
function hueFor(card) {
  if (!plotHues.has(card)) plotHues.set(card, PLOT_HUES[nextPlotHue++ % PLOT_HUES.length]);
  return plotHues.get(card);
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
.plots-editor-plot { padding: 0 10px 10px; overflow: hidden; margin: 18px 0; border-left: 6px solid var(--plot-hue, var(--accent)); box-shadow: 0 1px 4px rgb(0 0 0 / 0.08); }
.plots-editor-plot-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin: 0 -10px 10px; padding: 8px 10px; background: var(--accent-soft); background: color-mix(in srgb, var(--plot-hue) 14%, var(--panel)); border-bottom: 2px solid var(--plot-hue); }
.plots-editor-plot-number { min-width: 1.9em; padding: 1px 7px; border-radius: 999px; background: var(--plot-hue); color: #fff; font-size: 13px; font-weight: 700; text-align: center; }
.plots-editor-plot-toolbar > .plots-editor-plot-title { flex: 1 1 12rem; margin: 0; font-size: 15px; }
.plots-editor-plot-buttons { display: flex; gap: 6px; flex-wrap: wrap; }
.plots-editor-plot-buttons > .button { padding: 5px 12px; font-weight: 600; }
.plots-editor-plot-buttons > .button.danger:hover:not(:disabled) { border-color: var(--err); background: var(--err); color: #fff; }
[data-theme="dark"] .plots-editor-plot-buttons > .button.danger:hover:not(:disabled) { color: #101319; }
.plots-editor-plot-head { display: grid; grid-template-columns: minmax(10rem, 2fr) minmax(10rem, 1fr) minmax(10rem, 1fr) auto; gap: 8px; align-items: end; }
.plots-editor-json { width: 100%; min-height: 8rem; font: 12px/1.4 var(--mono); }
.plots-editor-plot-title { margin: 0 0 8px; font-size: 14px; }
.plots-editor-advanced { margin: 8px 0; }
.plots-editor-advanced > summary { cursor: pointer; font-size: 13px; }
/* Sections are shaded panels, not outlined boxes, so they stand apart without adding lines. */
.plots-editor-group { border: 0; border-radius: var(--radius-sm); margin: 8px 0; padding: 8px 10px; min-width: 0; background: var(--accent-soft); background: color-mix(in srgb, var(--text) 5%, var(--panel)); }
/* Floating the legend keeps it inside the panel instead of on its top edge. */
.plots-editor-group > legend { float: left; width: 100%; padding: 0; margin: 0 0 6px; font-size: 12px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--text); }
.plots-editor-group > legend + * { clear: both; }
.plots-editor-group-symbol { display: inline-block; width: 1.3em; margin-right: 4px; text-align: center; color: var(--plot-hue, var(--muted)); font-size: 14px; letter-spacing: 0; }
.plots-editor-group-inputs { display: grid; grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr)); gap: 8px; align-items: end; }
.plots-editor-group-inputs > .field { min-width: 0; margin-bottom: 0; }
.plots-editor-group-inputs > .field > :is(input, select) { width: 100%; box-sizing: border-box; }
/* Sub-editors (value labels, palette, order) rank below their section's legend and above field labels. */
.plots-editor-group .plots-editor-labels { margin: 10px 0 2px; padding-left: 10px; border-left: 2px solid var(--border); }
.plots-editor-labels > strong { display: block; font-size: 13px; font-weight: 600; color: var(--text); margin-bottom: 2px; }
.plots-editor-labels .field-hint { font-size: 12px; margin: 0 0 6px; }
.plots-editor-labels { margin: 10px 0; }
.plots-editor-label-row { display: grid; grid-template-columns: 1fr 1fr auto; gap: 8px; margin: 4px 0; }
.plots-editor-order-row { display: grid; grid-template-columns: 1fr auto auto auto; gap: 8px; align-items: center; margin: 4px 0; }
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
  nextPlotHue = 0; // each opening colours plots by their saved order
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
            cardNode.style.setProperty("--plot-hue", hueFor(card));
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

            const moveUp = button("↑ Move up", { title: "Move this plot earlier in the panel", onClick: () => movePlot(index, -1) });
            const moveDown = button("↓ Move down", { title: "Move this plot later in the panel", onClick: () => movePlot(index, 1) });
            const remove = button("✕ Remove plot", { title: "Remove this plot (Cancel discards all unsaved edits)", onClick: () => { state.cards.splice(index, 1); renderPlots(); } });
            remove.classList.add("danger");
            moveUp.disabled = index === 0;
            moveDown.disabled = index === state.cards.length - 1;
            const toolbar = element("div", { className: "plots-editor-plot-toolbar" }, [
              element("span", { className: "plots-editor-plot-number", text: String(index + 1), attrs: { title: `Plot ${index + 1} of ${state.cards.length}`, "aria-label": `Plot ${index + 1} of ${state.cards.length}` } }),
              heading,
              element("div", { className: "plots-editor-plot-buttons", attrs: { role: "group", "aria-label": `Plot ${index + 1} actions` } }, [moveUp, moveDown, remove]),
            ]);
            const head = element("div", { className: "plots-editor-plot-head" }, [
              field("Title", titleInput), field("Dataset", datasetSelect),
              field("Plot type", builderSelect), field("Card width", spanSelect),
            ]);
            cardNode.append(toolbar, head);

            if (card.mode === "custom") {
              const customText = element("textarea", { className: "plots-editor-json", attrs: { "aria-label": `Custom spec JSON for plot ${index + 1}`, spellcheck: "false" } });
              customText.value = card.customText;
              customText.addEventListener("input", () => { card.customText = customText.value; });
              cardNode.append(field("Custom Vega or Vega-Lite specification", customText));
            } else {
              const argsText = element("textarea", { className: "plots-editor-json", attrs: { "aria-label": `Builder arguments JSON for plot ${index + 1}`, spellcheck: "false" } });
              argsText.value = card.argsText;
              const groups = new Map();
              function groupFor(key) {
                const name = argumentGroup(card.builder, key);
                if (!groups.has(name)) {
                  const inputs = element("div", { className: "plots-editor-group-inputs" });
                  const editors = element("div");
                  const node = element("fieldset", { className: "plots-editor-group" }, [groupLegend(name), inputs, editors]);
                  groups.set(name, { name, node, inputs, editors });
                }
                return groups.get(name);
              }
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
                refreshTimeUnits();
              }
              const args = currentArgs();
              const placeholderInputs = new Map();
              const timeUnitFields = new Map();
              function refreshTimeUnits() {
                let current;
                try { current = currentArgs(); }
                catch { return; }
                // style, not the hidden attribute: the host's .field rule sets display and would override it.
                for (const [key, node] of timeUnitFields) node.style.display = showTimeUnit(card.builder, current, key) ? "" : "none";
              }
              function refreshPlaceholders() {
                let current;
                try { current = currentArgs(); }
                catch { return; }
                const defaults = defaultPlaceholders(card.builder, current);
                for (const [key, input] of placeholderInputs) input.placeholder = defaults[key] ?? "";
              }
              for (const [key, label, kind] of BUILDER_FIELDS[card.builder] || []) {
                if (key === "title") continue;
                const group = groupFor(key);
                const shortLabel = groupedLabel(label, group.name);
                if (key === "palette") {
                  group.editors.append(paletteEditor({
                    palette: args.palette,
                    allowCustom: card.builder !== "plotMapHeatmap",
                    getValues: () => { try { return distinctValues(currentArgs().colorVar); } catch { return []; } },
                    onChange: (value) => setArgValue("palette", value),
                  }));
                  continue;
                }
                if (key === "sort") {
                  const categoryField = () => {
                    const current = currentArgs();
                    return card.builder === "boxPlot" ? boxPlotCategoryField(current) : current.xVar;
                  };
                  group.editors.append(sortEditor({
                    label,
                    sort: args.sort,
                    byCount: kind === "sort-count",
                    getValues: () => { try { return distinctValues(categoryField()); } catch { return []; } },
                    onChange: (value) => setArgValue("sort", value),
                  }));
                  continue;
                }
                if (LABEL_SOURCES[key]) {
                  group.editors.append(labelsEditor({
                    label: shortLabel.replace(" (JSON)", ""),
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
                  const fallback = defaultPlaceholders(card.builder, args)[key];
                  control.append(element("option", { text: fallback ? `Default (${fallback})` : "(not set)", attrs: { value: "" } }));
                  const values = kind === "column" ? fieldChoices() : ["quantitative", "temporal", "ordinal", "nominal"];
                  control.append(...values.map((value) => element("option", { text: value, attrs: { value } })));
                  control.value = raw;
                } else if (kind === "invalid-values") {
                  const known = INVALID_VALUE_CHOICES.some((choice) => choice.value === raw);
                  control = select([
                    { value: "", label: "Default (show and flag them)" },
                    ...INVALID_VALUE_CHOICES,
                    ...(raw && !known ? [{ value: raw, label: `${raw} (not recognised)` }] : []),
                  ], { value: raw });
                  control.setAttribute("aria-label", label);
                  control.title = "Rows with blank or unparseable values in the plotted fields. A warning above the plot counts them either way.";
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
                const fieldNode = field(shortLabel, control);
                if (TIME_UNIT_AXES[key]) timeUnitFields.set(key, fieldNode);
                group.inputs.append(fieldNode);
              }
              refreshPlaceholders();
              refreshTimeUnits();
              argsText.addEventListener("change", () => {
                card.argsText = argsText.value;
                try { parseJson(card.argsText, `Plot ${index + 1} builder arguments`); renderPlots(); }
                catch (error) { state.error = error.message; }
              });
              // "Other" holds plot-wide settings, so it closes the card's sections whatever order they were met in.
              const ordered = [...groups.values()].sort((a, b) => (a.name === "Other") - (b.name === "Other"));
              cardNode.append(...ordered.map((group) => group.node), advanced("All builder arguments (JSON)", argsText));
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
            cardNode.append(element("fieldset", { className: "plots-editor-group" }, [
              groupLegend("Vega Embed options for this plot"),
              element("div", { className: "plots-editor-group-inputs" }, embedControls(card, () => { embedJson.value = jsonText(card.embed); })),
              advanced("Vega Embed options (JSON)", embedJson),
            ]));
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