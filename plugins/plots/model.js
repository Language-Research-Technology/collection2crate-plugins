import {
  barPlotCount, boxPlot, histogramPlot, scatterPlot,
} from "ro-crate-plots/lib/plots.js";

export const BUILDER_NAMES = ["barPlotCount", "scatterPlot", "boxPlot", "histogramPlot", "plotMapHeatmap"];

const builders = { barPlotCount, scatterPlot, boxPlot, histogramPlot };
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const clone = (value) => JSON.parse(JSON.stringify(value));

function uniqueHeaderNames(header) {
  const counts = new Map();
  return (header || []).map((raw, index) => {
    const base = String(raw || "").trim() || `column ${index + 1}`;
    const count = (counts.get(base) || 0) + 1;
    counts.set(base, count);
    return count === 1 ? base : `${base} (${count})`;
  });
}

export function tableToRows(table) {
  const names = uniqueHeaderNames(table?.header);
  return (table?.rows || []).map((row) => Object.fromEntries(
    names.map((name, index) => [name, row?.[index] ?? ""]),
  ));
}

function tableName(source, used) {
  const file = String(source).split("/").pop() || "dataset";
  const base = file.replace(/\.[^.]*$/, "") || "dataset";
  let name = base;
  let suffix = 2;
  while (used.has(name)) name = `${base} ${suffix++}`;
  used.add(name);
  return name;
}

export function createDefaultConfig(tables = []) {
  const datasets = {};
  const used = new Set();
  for (const table of tables) {
    const name = tableName(table.source, used);
    datasets[name] = { source: table.source };
  }
  return { plots: { globalConfig: { actions: false }, datasets, plotList: [] } };
}

export function validatePlotsConfig(input) {
  if (!isObject(input) || !isObject(input.plots)) throw new Error("Config must contain a 'plots' object.");
  const plots = input.plots;
  if (plots.globalConfig !== undefined && !isObject(plots.globalConfig)) {
    throw new Error("plots.globalConfig must be a JSON object.");
  }
  if (!isObject(plots.datasets)) throw new Error("plots.datasets must be an object of named datasets.");
  if (!Array.isArray(plots.plotList)) throw new Error("plots.plotList must be an array.");
  for (const [index, plot] of plots.plotList.entries()) {
    if (!isObject(plot)) throw new Error(`Plot ${index + 1} must be an object.`);
    if (!isObject(plot.dataset) || typeof plot.dataset.name !== "string" || !plot.dataset.name) {
      throw new Error(`Plot ${index + 1} must select a named dataset.`);
    }
    if (!Object.hasOwn(plots.datasets, plot.dataset.name)) {
      throw new Error(`Plot ${index + 1} refers to missing dataset '${plot.dataset.name}'.`);
    }
    const custom = isObject(plot.customSpec) && Object.keys(plot.customSpec).length > 0;
    const functionName = plot.makeSpec?.plotFunction;
    if (!custom && (typeof functionName !== "string" || !functionName.trim())) {
      throw new Error(`Plot ${index + 1} must select a builder or provide a custom spec.`);
    }
    if (plot.makeSpec && !isObject(plot.makeSpec.args)) {
      throw new Error(`Plot ${index + 1} makeSpec.args must be a JSON object.`);
    }
    if (plot.config !== undefined && !isObject(plot.config)) {
      throw new Error(`Plot ${index + 1} config must be a JSON object.`);
    }
    const span = plot.plotCardSpan ?? plot.span ?? 1;
    if (![1, 2, 3].includes(Number(span))) throw new Error(`Plot ${index + 1} width must be 1, 2, or 3 columns.`);
  }
  return clone(input);
}

export function datasetsForConfig(tables, config) {
  const bySource = new Map((tables || []).map((table) => [table.source, tableToRows(table)]));
  const datasets = {};
  const missing = [];
  for (const [name, descriptor] of Object.entries(config.plots.datasets || {})) {
    const source = typeof descriptor === "string" ? descriptor : descriptor?.source || descriptor?.path;
    const rows = source ? bySource.get(source) : null;
    if (!rows) { missing.push({ name, source: source || "" }); continue; }
    datasets[name] = rows;
  }
  return { datasets, missing };
}

export function mapRowsFromColumns(rows, {
  latitudeField = "lat", longitudeField = "lon", weightField,
} = {}) {
  let invalidCoordinates = 0;
  const data = (rows || []).flatMap((row) => {
    const lat = Number(row[latitudeField]);
    const lon = Number(row[longitudeField]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) { invalidCoordinates++; return []; }
    return [{ lat, lon, ...(weightField ? { weight: Number(row[weightField]) || 1 } : {}) }];
  });
  return { data, invalidCoordinates };
}

function bindCustomData(inputSpec, data, datasetName) {
  const spec = clone(inputSpec);
  const schema = String(spec.$schema || "");
  if (schema.includes("vega-lite")) {
    if (!spec.data?.values) spec.data = { ...(spec.data || {}), values: data };
    delete spec.data.name;
    delete spec.data.url;
  } else if (Array.isArray(spec.data)) {
    const target = spec.data.find((source) => source.name === datasetName) || spec.data.find((source) => source.name === "source");
    if (target && !target.values) {
      target.values = data;
      delete target.url;
    }
  }
  return spec;
}

export async function generatePlotSpecs(config, tables) {
  const validated = validatePlotsConfig(config);
  const { datasets, missing } = datasetsForConfig(tables, validated);
  const plots = await Promise.all(validated.plots.plotList.map(async (plot, index) => {
    const name = plot.dataset.name;
    const data = datasets[name];
    if (!data) return { index, plot, error: `Dataset '${name}' is not loaded.`, spec: null };
    const custom = isObject(plot.customSpec) && Object.keys(plot.customSpec).length > 0;
    try {
      if (custom) return { index, plot, spec: bindCustomData(plot.customSpec, data, name), error: null };
      const functionName = plot.makeSpec.plotFunction;
      let builder = builders[functionName];
      let args = clone(plot.makeSpec.args);
      let builderData = data;
      let warnings = [];
      if (functionName === "plotMapHeatmap") {
        ({ plotMapHeatmap: builder } = await import("./map.js"));
        const { latitudeField = "lat", longitudeField = "lon", weightField, ...mapOptions } = args;
        const mapped = mapRowsFromColumns(data, { latitudeField, longitudeField, weightField });
        builderData = mapped.data;
        if (!builderData.length) throw new Error(`No rows have numeric '${latitudeField}' and '${longitudeField}' coordinates.`);
        if (mapped.invalidCoordinates) warnings = [`${mapped.invalidCoordinates} row(s) skipped because their map coordinates were not numeric.`];
        args = mapOptions;
      }
      if (typeof builder !== "function") throw new Error(`Builder '${functionName}' is unavailable in this browser.`);
      const spec = await builder({ ...args, data: builderData });
      return { index, plot, spec, warnings, error: null };
    } catch (error) {
      return { index, plot, spec: null, error: error.message || String(error) };
    }
  }));
  return { plots, missing };
}

export function embedOptions(config, plot) {
  return { ...(config.plots.globalConfig || {}), ...(plot.config || {}) };
}

export function layoutSpan(plot) {
  return Number(plot.plotCardSpan ?? plot.span ?? 1);
}