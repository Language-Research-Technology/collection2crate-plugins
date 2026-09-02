// The in-app editor for a roctable config: one collapsible heading per
// discovered @type (tick to select it as a table), each unrolling to a list
// of its properties (include/expand/load_text/join), an expanded property
// further unrolling to its own one-hop sub-properties. Built the same
// "no host markup, no HTML string" way as new-files-confirm.js, using the
// host's own `.checkbox`/`.modal .actions`/`.secondary`/`.hint` CSS.
//
// The working copy is mutated directly by each control's own change handler
// rather than re-derived from DOM state at the end — Save just resolves
// with whatever the working copy currently is.

function cloneConfig(config) {
  return JSON.parse(JSON.stringify(config));
}

function allTypeNames(config) {
  return [...new Set([...Object.keys(config.tables || {}), ...Object.keys(config.potential_tables || {})])].sort();
}

function tableEntry(config, type) {
  return config.tables[type] || config.potential_tables[type];
}

function isSelected(config, type) {
  return Object.prototype.hasOwnProperty.call(config.tables, type);
}

function setTableSelected(config, type, selected) {
  const entry = tableEntry(config, type);
  if (selected) {
    delete config.potential_tables[type];
    config.tables[type] = entry;
  } else {
    delete config.tables[type];
    config.potential_tables[type] = entry;
  }
}

function checkboxWithLabel(text, checked, onChange) {
  const label = document.createElement("label");
  label.className = "checkbox";
  label.style.cssText = "gap:4px; font-size:13px; margin-right:14px;";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = checked;
  input.addEventListener("change", () => onChange(input.checked));
  const span = document.createElement("span");
  span.textContent = text;
  label.append(input, span);
  return label;
}

function includedCount(properties) {
  const values = Object.values(properties || {});
  return { included: values.filter((p) => p.include).length, total: values.length };
}

// A one-hop expanded sub-property row: include only (rename exists in the
// config format but has no UI control yet — see docs/crate2tables-spec.md).
function renderSubPropertyRow(properties, name) {
  const propConfig = properties[name];
  const wrap = document.createElement("div");
  wrap.style.padding = "2px 0";
  wrap.appendChild(checkboxWithLabel(name, propConfig.include !== false, (checked) => { propConfig.include = checked; }));
  return wrap;
}

// One property of a selected/potential table: include/expand/load_text/join,
// unrolling to its own sub-properties (discoverExpandedProperties' nested
// `properties` map) when expand is checked and that map already exists —
// it only appears after the type has been through a build with expand:true
// set, so a freshly-checked expand shows a hint instead until then.
function renderPropertyRow(properties, name, onIncludeChange) {
  const propConfig = properties[name];
  const row = document.createElement("div");
  row.style.cssText = "display:flex; align-items:center; flex-wrap:wrap; padding:3px 0;";

  const subPanel = document.createElement("div");
  subPanel.style.cssText = `margin:2px 0 6px 26px; ${propConfig.expand ? "" : "display:none;"}`;

  function renderSubPanel() {
    subPanel.replaceChildren();
    if (propConfig.properties && Object.keys(propConfig.properties).length) {
      for (const subName of Object.keys(propConfig.properties).sort()) {
        subPanel.appendChild(renderSubPropertyRow(propConfig.properties, subName));
      }
    } else {
      const hint = document.createElement("div");
      hint.className = "hint";
      hint.textContent = "Sub-properties appear here after the next build re-discovers this expansion.";
      subPanel.appendChild(hint);
    }
  }
  renderSubPanel();

  const includeCb = checkboxWithLabel(name, !!propConfig.include, (checked) => {
    propConfig.include = checked;
    onIncludeChange();
  });

  const expandCb = checkboxWithLabel("expand", !!propConfig.expand, (checked) => {
    propConfig.expand = checked;
    subPanel.style.display = checked ? "block" : "none";
    if (checked) renderSubPanel();
  });

  const joinSelect = document.createElement("select");
  joinSelect.disabled = !propConfig.load_text;
  const opts = [["", "(plain text)"], ["csv", "join as CSV rows"]];
  for (const [value, text] of opts) {
    const opt = document.createElement("option");
    opt.value = value; opt.textContent = text;
    joinSelect.appendChild(opt);
  }
  joinSelect.value = propConfig.join || "";
  joinSelect.addEventListener("change", () => {
    if (joinSelect.value) propConfig.join = joinSelect.value; else delete propConfig.join;
  });

  const loadTextCb = checkboxWithLabel("load text", !!propConfig.load_text, (checked) => {
    propConfig.load_text = checked;
    joinSelect.disabled = !checked;
    if (!checked) { delete propConfig.join; joinSelect.value = ""; }
  });

  const joinWrap = document.createElement("span");
  joinWrap.style.cssText = "font-size:13px; display:flex; align-items:center; gap:4px;";
  const joinLabel = document.createElement("span");
  joinLabel.textContent = "join:";
  joinLabel.className = "hint";
  joinWrap.append(joinLabel, joinSelect);

  row.append(includeCb, expandCb, loadTextCb, joinWrap);

  const container = document.createElement("div");
  container.append(row, subPanel);
  return container;
}

// One @type heading — a checkbox (select this type as a table) plus a
// disclosure toggle unrolling to its properties. `onSelectionChange` redraws
// the whole list, since selecting/deselecting moves the type between
// config.tables/config.potential_tables — simplest to just re-render rather
// than track two possible positions for the same row.
function renderTypeRow(config, type, onSelectionChange) {
  const entry = tableEntry(config, type);
  const properties = entry.properties || {};

  const wrap = document.createElement("div");
  wrap.style.cssText = "border-bottom:1px solid var(--border); padding:6px 0;";

  const head = document.createElement("div");
  head.style.cssText = "display:flex; align-items:center; gap:8px;";

  const selectCb = document.createElement("input");
  selectCb.type = "checkbox";
  selectCb.checked = isSelected(config, type);
  selectCb.addEventListener("change", () => {
    setTableSelected(config, type, selectCb.checked);
    onSelectionChange();
  });

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "secondary";
  toggle.style.cssText = "padding:2px 8px; font-size:12px; line-height:1.4;";
  toggle.textContent = "▸";

  const summary = document.createElement("span");
  summary.style.fontWeight = "600";

  function updateSummary() {
    const { included, total } = includedCount(properties);
    summary.textContent = `${type} — ${included}/${total} propert${total === 1 ? "y" : "ies"} shown`;
  }
  updateSummary();

  head.append(selectCb, toggle, summary);
  wrap.appendChild(head);

  const propsPanel = document.createElement("div");
  propsPanel.style.cssText = "margin:8px 0 4px 28px; display:none;";
  wrap.appendChild(propsPanel);

  let built = false;
  toggle.addEventListener("click", () => {
    const expanded = propsPanel.style.display !== "none";
    propsPanel.style.display = expanded ? "none" : "block";
    toggle.textContent = expanded ? "▸" : "▾";
    if (!expanded && !built) {
      built = true;
      for (const propName of Object.keys(properties).sort()) {
        propsPanel.appendChild(renderPropertyRow(properties, propName, updateSummary));
      }
    }
  });

  return wrap;
}

// Opens the editor and resolves to the edited config, or null if dismissed
// without an explicit Save/Cancel choice — the caller (index.js) treats
// null as "no change was confirmed", not "clear everything".
export async function openConfigTreeEditor({ config, openModal }) {
  const working = cloneConfig(config);

  return openModal({
    title: "Configure RO-Crate tables",
    onDismiss: () => null,
    render(body, close) {
      const intro = document.createElement("p");
      intro.textContent = "Tick a type to export it as a table. Expand a type to choose which properties become columns, and whether each one is expanded, has its file text loaded, or joined as CSV rows.";
      body.appendChild(intro);

      const listWrap = document.createElement("div");
      listWrap.style.cssText = "max-height:420px; overflow-y:auto; border:1px solid var(--border); border-radius:8px; padding:4px 12px; margin-bottom:16px;";
      body.appendChild(listWrap);

      function renderList() {
        listWrap.replaceChildren();
        const types = allTypeNames(working);
        if (!types.length) {
          const empty = document.createElement("p");
          empty.className = "hint";
          empty.textContent = "No entity types were found in this crate.";
          listWrap.appendChild(empty);
          return;
        }
        for (const type of types) {
          listWrap.appendChild(renderTypeRow(working, type, renderList));
        }
      }
      renderList();

      const actions = document.createElement("div");
      actions.className = "actions";
      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button"; cancelBtn.className = "secondary";
      cancelBtn.textContent = "Cancel";
      cancelBtn.addEventListener("click", () => close(null));
      const saveBtn = document.createElement("button");
      saveBtn.type = "button";
      saveBtn.textContent = "Save configuration";
      saveBtn.addEventListener("click", () => close(working));
      actions.append(cancelBtn, saveBtn);
      body.appendChild(actions);
    },
  });
}
