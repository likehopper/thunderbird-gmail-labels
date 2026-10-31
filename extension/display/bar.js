/**
 * Label bar injected at the top of the displayed message.
 */
(() => {
  const MAX_PICKER_ITEMS = 12;

  let bar = null;
  let lastState = null;

  const createElement = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };

  const sendAndRender = async request => render(await browser.runtime.sendMessage(request));

  function createPill(label, editable) {
    const pill = createElement("span", "gml-pill", label.name);
    if (label.id === "INBOX") pill.classList.add("gml-inbox");
    if (label.pending) {
      pill.classList.add("gml-pending");
      pill.title = translate("pendingTitle");
    }
    if (label.color?.backgroundColor) {
      pill.style.background = label.color.backgroundColor;
      pill.style.color = label.color.textColor;
    }
    if (editable && label.removable) {
      const removeButton = createElement("button", "gml-remove", "×");
      removeButton.title = label.id === "INBOX" ? translate("barArchive") : translate("barRemove", label.name);
      removeButton.addEventListener("click", () => {
        removeButton.disabled = true;
        sendAndRender({ command: "modify", removeLabelIds: [label.id] });
      });
      pill.append(removeButton);
    }
    return pill;
  }

  function createSetupLink(text) {
    const link = createElement("button", "gml-link", text);
    link.addEventListener("click", () => browser.runtime.sendMessage({ command: "openOptions" }));
    return link;
  }

  /** "+" button: search field with a filtered list, Up/Down/Enter/Escape. */
  function createAddControl(state) {
    const container = createElement("span", "gml-add");
    const addButton = createElement("button", "gml-plus", "+");
    addButton.title = translate("barAdd");
    addButton.addEventListener("click", () => openLabelPicker(container, state));
    container.append(addButton);
    return container;
  }

  function openLabelPicker(container, state) {
    const currentLabelIds = new Set(state.labels.map(label => label.id));
    const recentLabelIds = state.recentLabelIds ?? [];
    const recencyRank = label =>
      recentLabelIds.includes(label.id) ? recentLabelIds.indexOf(label.id) : recentLabelIds.length;
    // Most recently used labels first (stable sort: the others stay alphabetical)
    const choices = state.allLabels
      .filter(label => !currentLabelIds.has(label.id))
      .sort((first, second) => recencyRank(first) - recencyRank(second));
    const input = createElement("input", "gml-input");
    input.placeholder = translate("barInputPlaceholder");
    const menu = createElement("ul", "gml-menu");
    let items = [];
    let activeIndex = 0;

    const choose = item => {
      input.disabled = true;
      sendAndRender(item.request);
    };

    function updateMenu() {
      const typedText = input.value.trim();
      const search = typedText.toLowerCase();
      items = choices
        .filter(label => label.name.toLowerCase().includes(search))
        .slice(0, MAX_PICKER_ITEMS)
        .map(label => ({ text: label.name, request: { command: "modify", addLabelIds: [label.id] } }));
      // No "Create" entry if the label exists, even typed without its parents
      const labelExists = state.allLabels.some(label =>
        [label.name, label.name.split("/").pop()].some(name => name.toLowerCase() === search));
      if (typedText && !labelExists) {
        items.push({
          text: translate("createLabel", typedText),
          request: { command: "create", labelName: typedText },
        });
      }
      activeIndex = Math.min(activeIndex, Math.max(items.length - 1, 0));
      menu.replaceChildren(...items.map((item, index) => {
        const entry = createElement("li", index === activeIndex ? "gml-active" : "", item.text);
        // mousedown + preventDefault: choose before the field loses focus
        entry.addEventListener("mousedown", event => {
          event.preventDefault();
          choose(item);
        });
        return entry;
      }));
      menu.hidden = !items.length;
    }

    input.addEventListener("input", () => {
      activeIndex = 0;
      updateMenu();
    });
    input.addEventListener("keydown", event => {
      event.stopPropagation(); // no Thunderbird shortcuts (a, r…) while typing
      if (event.key === "ArrowDown") activeIndex = Math.min(activeIndex + 1, items.length - 1);
      else if (event.key === "ArrowUp") activeIndex = Math.max(activeIndex - 1, 0);
      else if (event.key === "Enter" && items[activeIndex]) choose(items[activeIndex]);
      else if (event.key === "Escape") render(lastState);
      else return;
      event.preventDefault();
      if (event.key.startsWith("Arrow")) updateMenu();
    });
    input.addEventListener("blur", () => {
      if (!input.disabled) render(lastState);
    });

    container.replaceChildren(input, menu);
    input.focus();
    updateMenu();
  }

  function render(state) {
    if (!state || ["none", "notfound"].includes(state.mode) || state.showBar === false) {
      bar?.remove();
      bar = null;
      return;
    }
    lastState = state;
    if (!bar) {
      bar = createElement("div", "gml-bar");
      document.body.prepend(bar);
    }
    const refreshButton = createElement("button", "gml-refresh", "⟳");
    refreshButton.title = translate("barRefresh");
    refreshButton.addEventListener("click", () => {
      refreshButton.disabled = true;
      sendAndRender({ command: "state", bypassCache: true, includeChoices: true });
    });
    bar.replaceChildren(refreshButton);
    switch (state.mode) {
      case "gmail":
      case "offline":
      case "local": {
        const editable = state.mode !== "local";
        for (const label of state.labels) bar.append(createPill(label, editable));
        if (!state.labels.length) bar.append(createElement("span", "gml-note", translate("barNoLabel")));
        if (editable && state.allLabels) bar.append(createAddControl(state));
        if (state.mode === "offline") {
          const since = new Date(state.since).toLocaleString(browser.i18n.getUILanguage(), {
            dateStyle: "short",
            timeStyle: "short",
          });
          const pendingNote = state.pendingChangeCount ? translate("barQueued", state.pendingChangeCount) : "";
          bar.append(createElement("span", "gml-note", translate("barOfflineSince", since) + pendingNote));
        }
        if (state.mode === "local") bar.append(createElement("span", "gml-note", translate("barOfflineLocal")));
        break;
      }
      case "unauthorized":
        bar.append(createSetupLink(translate("barAuthorize")));
        break;
      case "auth":
        bar.append(createSetupLink(translate("barAuthExpired")));
        break;
      default:
        bar.append(createElement("span", "gml-note", translate("barError", state.error)));
    }
  }

  const loadLabels = () => sendAndRender({ command: "state", includeChoices: true });

  browser.runtime.onMessage.addListener(request => {
    if (request?.command === "refresh") loadLabels();
  });
  loadLabels();
})();
