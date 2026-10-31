/**
 * Popup: check / uncheck the labels of the displayed message.
 * Order: the message's labels, the most recently used ones, then all the others.
 */
const element = id => document.getElementById(id);
let tabId = null;
let state = null;

const send = request => browser.runtime.sendMessage({ ...request, tabId });

function setStatus(text) {
  element("status").textContent = text ?? "";
}

function createSetupButton(text) {
  const button = document.createElement("button");
  button.textContent = text;
  button.addEventListener("click", () => send({ command: "openOptions" }).then(() => window.close()));
  return button;
}

async function applyChange(request) {
  document.body.classList.add("busy");
  const nextState = await send(request);
  document.body.classList.remove("busy");
  if (nextState.mode === "gmail" || nextState.mode === "offline") {
    state = nextState;
    render();
  } else {
    setStatus(translate("popupError", nextState.error ?? nextState.mode));
  }
}

function createHeading(text) {
  const entry = document.createElement("li");
  entry.className = "heading";
  entry.textContent = text;
  return entry;
}

function createLabelEntry(label, checked) {
  const entry = document.createElement("li");
  const row = document.createElement("label");
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = checked;
  checkbox.addEventListener("change", () => applyChange(checkbox.checked
    ? { command: "modify", addLabelIds: [label.id] }
    : { command: "modify", removeLabelIds: [label.id] }));
  const swatch = document.createElement("span");
  swatch.className = "swatch";
  if (label.color?.backgroundColor) swatch.style.background = label.color.backgroundColor;
  row.append(checkbox, swatch, label.name);
  entry.append(row);
  return entry;
}

function renderUnavailableState() {
  element("filter").hidden = true;
  const messages = {
    none: translate("popupNone"),
    notfound: translate("popupNotFound"),
    local: translate("popupLocal"),
    unauthorized: translate("popupUnauthorized", state.email),
    auth: translate("popupAuthExpired"),
  };
  setStatus(messages[state.mode] ?? translate("popupError", state.error));
  if (state.mode === "unauthorized" || state.mode === "auth") {
    document.body.append(createSetupButton(translate("popupOpenSetup")));
  }
}

function render() {
  const list = element("list");
  list.replaceChildren();
  element("create").hidden = true;
  setStatus();

  if (state.mode === "offline") {
    setStatus(state.pendingChangeCount
      ? translate("popupOfflineQueued", state.pendingChangeCount)
      : translate("popupOffline"));
  } else if (state.mode !== "gmail") {
    renderUnavailableState();
    return;
  }

  const typedText = element("filter").value.trim();
  const search = typedText.toLowerCase();
  const currentLabelIds = new Set(state.labels.map(label => label.id));
  const labelsById = new Map(state.allLabels.map(label => [label.id, label]));
  const matches = state.allLabels.filter(label => !search || label.name.toLowerCase().includes(search));

  const selectedLabels = matches.filter(label => currentLabelIds.has(label.id));
  const recentLabels = (state.recentLabelIds ?? [])
    .map(id => labelsById.get(id))
    .filter(label => label && !currentLabelIds.has(label.id) && matches.includes(label));
  const otherLabels = matches.filter(label => !currentLabelIds.has(label.id) && !recentLabels.includes(label));

  const sections = [
    [translate("popupOnMessage"), selectedLabels, true],
    [translate("popupRecent"), recentLabels, false],
    [translate("popupAll"), otherLabels, false],
  ];
  for (const [title, labels, checked] of sections) {
    if (!labels.length) continue;
    list.append(createHeading(title), ...labels.map(label => createLabelEntry(label, checked)));
  }

  // No "Create" button if the label exists, even typed without its parents
  const labelExists = state.allLabels.some(label =>
    [label.name, label.name.split("/").pop()].some(name => name.toLowerCase() === search));
  if (typedText && !labelExists) {
    element("create").textContent = translate("createLabel", typedText);
    element("create").hidden = false;
  }
}

element("filter").addEventListener("input", render);
element("filter").addEventListener("keydown", event => {
  if (event.key !== "Enter") return;
  const checkboxes = [...document.querySelectorAll("#list input")];
  if (checkboxes.length === 1) checkboxes[0].click();
  else if (!element("create").hidden) element("create").click();
});
element("create").addEventListener("click", () => {
  const labelName = element("filter").value.trim();
  element("filter").value = "";
  applyChange({ command: "create", labelName });
});

(async () => {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  tabId = tab.id;
  localizePage();
  setStatus(translate("loading"));
  state = await send({ command: "state", includeChoices: true });
  render();
  element("filter").focus();
})();
