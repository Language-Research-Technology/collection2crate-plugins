// Runs the selected MASP profile's validator against the built crate and
// logs pass/fail — automatic whenever a profile is selected, no
// optionSchema. ro-crate-masp is a heavy dependency (pulls in the whole
// validator library), so it's still dynamically imported here, same as
// before this was extracted from processFolder — deps.loadMasp is a thunk
// chaos2crate hands in (`() => import("../masp.js")`) rather than a
// direct import, so masp.js stays dynamically imported from chaos2crate's
// own tree and this package never statically references it. See this
// repo's README for the createPlugin(deps) contract.
let loadMasp;

export function createPlugin(deps) {
  ({ loadMasp } = deps);
  return plugin;
}

const plugin = {
  name: "validate-crate",
  hooks: {
    "crate:validate": async (ctx) => {
      const { crate, selectedProfileData, log } = ctx;
      if (!selectedProfileData) return;
      try {
        const graph = crate?.getJson?.()["@graph"] || [];
        const entityCount = Array.isArray(graph) ? graph.length : 0;
        log(`Validating crate against profile (${entityCount} entities)…`, "muted");
        const { validateBuiltCrate } = await loadMasp();
        // ro-crate-masp's onProgress fires once per profile class rule (not
        // per entity — see that repo's validateTargetCrateGraph), so this
        // stays a handful of lines even on a large crate, matching the
        // (done/total) log convention austlang's language matcher uses to
        // drive chaos2crate's sub-progress bar.
        const result = await validateBuiltCrate(selectedProfileData.validator, crate, (progress) => {
          log(`Validating crate against profile: ${progress.current}/${progress.total} rule(s)…`, "muted");
        });
        if (result.ok) {
          log("Profile validation passed — crate conforms to the selected profile.", "ok");
        } else {
          log(`Profile validation found ${result.errors.length} issue(s):`, "warn");
          for (const e of result.errors) log(`  • ${e.message}`, "warn");
        }
      } catch (e) {
        log(`Profile validation could not run: ${e.message}`, "warn");
      }
    },
  },
};
