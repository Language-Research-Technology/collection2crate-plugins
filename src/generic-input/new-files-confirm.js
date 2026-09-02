// A checkbox file-tree for confirming which newly-discovered files (found by
// a generic-input scan but not yet in an existing crate) should actually be
// added as new File entities — see index.js's buildCrate and chaos2crate
// SPEC.md §6.1a. Built the same "no host markup, no HTML string" way as the
// rest of this app's own plugin UI, using the shared `openModal` helper and
// the host's own `.checkbox`/`.modal .actions` CSS conventions rather than
// inventing new ones.

// Turns a flat list of relative paths into a nested { name, children, isFile,
// path } tree, splitting on "/" the same way filesWithMeta's own folder
// grouping does.
function buildFileTree(paths) {
  const root = { name: "", children: new Map(), isFile: false };
  for (const relPath of paths) {
    const parts = relPath.split("/");
    let node = root;
    parts.forEach((part, i) => {
      const isFile = i === parts.length - 1;
      if (!node.children.has(part)) {
        node.children.set(part, { name: part, children: new Map(), isFile, path: isFile ? relPath : null });
      }
      node = node.children.get(part);
    });
  }
  return root;
}

function leafPaths(node) {
  if (node.isFile) return [node.path];
  return [...node.children.values()].flatMap(leafPaths);
}

// Renders `node`'s children as a <ul>. Returns { el, refresh } — refresh()
// recomputes every checkbox's checked/indeterminate state from `checkedSet`
// (a folder is checked only when every leaf beneath it is, indeterminate
// when some but not all are) and must be called after any change to it, from
// anywhere in the tree, since a folder's own state depends only on its
// leaves, not on which specific one changed.
function renderNode(node, checkedSet, onAnyChange, depth = 0) {
  const ul = document.createElement("ul");
  ul.style.cssText = `list-style:none; margin:0; padding:${depth === 0 ? "0" : "0 0 0 20px"};`;
  const refreshers = [];

  const children = [...node.children.values()].sort((a, b) => (
    a.isFile !== b.isFile ? (a.isFile ? 1 : -1) : a.name.localeCompare(b.name)
  ));

  for (const child of children) {
    const li = document.createElement("li");
    const row = document.createElement("label");
    row.className = "checkbox";
    row.style.margin = "3px 0";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    const text = document.createElement("span");
    text.textContent = child.isFile ? child.name : `${child.name}/`;
    row.append(checkbox, text);
    li.appendChild(row);

    const paths = leafPaths(child);
    refreshers.push(() => {
      const checkedCount = paths.filter((p) => checkedSet.has(p)).length;
      checkbox.checked = checkedCount === paths.length;
      checkbox.indeterminate = checkedCount > 0 && checkedCount < paths.length;
    });

    checkbox.addEventListener("change", () => {
      for (const p of paths) { if (checkbox.checked) checkedSet.add(p); else checkedSet.delete(p); }
      onAnyChange();
    });

    if (!child.isFile) {
      const sub = renderNode(child, checkedSet, onAnyChange, depth + 1);
      li.appendChild(sub.el);
      refreshers.push(sub.refresh);
    }
    ul.appendChild(li);
  }

  return { el: ul, refresh: () => refreshers.forEach((r) => r()) };
}

// Opens the confirmation modal and resolves to the array of confirmed paths
// (possibly empty — the user can uncheck everything), or null if dismissed —
// the caller treats null as "cancel the whole build", not "add nothing",
// since a dismissal made no explicit choice at all.
export async function confirmNewFiles({ newPaths, openModal }) {
  const checkedSet = new Set(newPaths); // default: everything checked
  const tree = buildFileTree(newPaths);

  return openModal({
    title: `${newPaths.length} new file${newPaths.length === 1 ? "" : "s"} found`,
    onDismiss: () => null,
    render(body, close) {
      const intro = document.createElement("p");
      intro.textContent =
        "These files aren't in the existing crate yet. Choose which to add — " +
        "anything left unchecked is skipped this build (you'll be asked again next time, unless it's removed from the folder).";
      body.appendChild(intro);

      const countLabel = document.createElement("p");
      countLabel.style.fontWeight = "600";
      const updateCount = () => { countLabel.textContent = `${checkedSet.size} of ${newPaths.length} selected`; };

      const { el: treeEl, refresh } = renderNode(tree, checkedSet, () => { updateCount(); refresh(); });
      refresh();
      updateCount();

      const scrollWrap = document.createElement("div");
      scrollWrap.style.cssText = "max-height:260px; overflow-y:auto; border:1px solid var(--border); border-radius:8px; padding:8px 12px; margin-bottom:16px;";
      scrollWrap.appendChild(treeEl);
      body.append(countLabel, scrollWrap);

      const actions = document.createElement("div");
      actions.className = "actions";
      const skipBtn = document.createElement("button");
      skipBtn.type = "button"; skipBtn.className = "secondary";
      skipBtn.textContent = "Add none";
      skipBtn.addEventListener("click", () => close([]));
      const confirmBtn = document.createElement("button");
      confirmBtn.type = "button";
      confirmBtn.textContent = "Add selected";
      confirmBtn.addEventListener("click", () => close([...checkedSet]));
      actions.append(skipBtn, confirmBtn);
      body.appendChild(actions);
    },
  });
}
