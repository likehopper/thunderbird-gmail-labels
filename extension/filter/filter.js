/**
 * Gmail filter window, in four modes: "suggest" (opened after a message is moved to a
 * label folder or a label is added), "message" (context menu of a message), "new" and
 * "edit" (opened from the filter list).
 * The criterion (address, domain or keyword) is searched in the checked fields; the
 * resulting Gmail search stays editable. Existing filters are compared as you type.
 */
const element = id => document.getElementById(id);
const proposalId = new URLSearchParams(location.search).get("id");
const FIELD_NAMES = {
  from: translate("fieldFrom"),
  to: translate("fieldTo"),
  replyTo: translate("fieldReplyTo"),
  subject: translate("fieldSubject"),
};
const ALL_ADDRESS_FIELDS = ["from", "to", "replyTo"];
// Domains shared by everyone: a filter on them would make no sense
const PUBLIC_DOMAIN = /^(gmail|googlemail|hotmail|outlook|live|yahoo|icloud|me|free|orange|wanadoo|laposte|sfr)\./;
const MIN_SEARCH_LENGTH = 3;
const COUNT_DELAY = 400;
const CLOSE_DELAY = 1200;
const WARNING_CLOSE_DELAY = 6000;
const CONFIRM_DELAY = 4000;
const MAX_RELATED_SHOWN = 5;
const MAX_OVERLAPS_SHOWN = 10;
// Checkboxes: [list of action labels, label id]
const ACTION_BOXES = {
  archive: ["removeLabelIds", "INBOX"],
  read: ["removeLabelIds", "UNREAD"],
  neverSpam: ["removeLabelIds", "SPAM"],
  star: ["addLabelIds", "STARRED"],
  important: ["addLabelIds", "IMPORTANT"],
  trash: ["addLabelIds", "TRASH"],
};
const CATEGORY_IDS = ["PERSONAL", "SOCIAL", "PROMOTIONS", "UPDATES", "FORUMS"].map(name => `CATEGORY_${name}`);

let proposal = null;
let labelsById = new Map();

const send = request => browser.runtime.sendMessage({ ...request, proposalId });

function setStatus(text, isError = false) {
  element("status").textContent = text ?? "";
  element("status").className = isError ? "error" : "";
}

async function closeWindow() {
  await browser.windows.remove((await browser.windows.getCurrent()).id);
}

function quoteSearchValue(value) {
  const cleanValue = value.replace(/"/g, "");
  return /[\s(){}]/.test(cleanValue) ? `"${cleanValue}"` : cleanValue;
}

/** Checked values, the keyword split on "|"; a value covered by another one (its domain) is dropped. */
function checkedValues() {
  const values = [...document.querySelectorAll("input[name=value]:checked")].flatMap(checkbox =>
    checkbox.value === "keyword" ? element("keyword").value.split("|") : [checkbox.value]);
  const unique = [...new Set(values.map(value => value.trim()).filter(Boolean))];
  return unique.filter(value => !unique.some(other => other !== value && valueCovers(other.toLowerCase(), value.toLowerCase())));
}

/** Several terms between braces mean OR for Gmail: each value is searched in each checked field. */
function buildQuery() {
  const values = checkedValues();
  const fields = [...document.querySelectorAll("input[name=field]:checked")].map(checkbox => checkbox.value);
  if (!values.length || !fields.length) return "";
  const terms = values.flatMap(value => {
    const searchValue = quoteSearchValue(value);
    return fields.flatMap(field => ({
      from: [`from:${searchValue}`],
      to: [`to:${searchValue}`, `cc:${searchValue}`],
      replyTo: [`replyto:${searchValue}`], // undocumented operator, but recognized by Gmail
      subject: [`subject:${searchValue}`],
    })[field]);
  });
  return terms.length > 1 ? `{${terms.join(" ")}}` : terms[0];
}

/** The criteria the form doesn't show are kept, like unchanged structured fields. */
function buildCriteria() {
  const query = element("query").value.trim();
  const originalCriteria = proposal.filter?.criteria;
  if (originalCriteria && query === editableQuery(originalCriteria)) return originalCriteria;
  return { ...otherCriteria(originalCriteria), ...(query ? { query } : {}) };
}

/** The labels and options the form doesn't show are kept. */
function buildAction() {
  const { addLabelIds = [], removeLabelIds = [], ...otherOptions } = proposal.filter?.action ?? {};
  const shownLabelId = userLabelIds({ addLabelIds })[0];
  const boxIds = list => Object.values(ACTION_BOXES)
    .filter(([listName]) => listName === list)
    .map(([, labelId]) => labelId);
  const lists = {
    addLabelIds: addLabelIds.filter(id =>
      id !== shownLabelId && !boxIds("addLabelIds").includes(id) && !CATEGORY_IDS.includes(id)),
    removeLabelIds: removeLabelIds.filter(id => !boxIds("removeLabelIds").includes(id)),
  };
  for (const [boxId, [listName, labelId]] of Object.entries(ACTION_BOXES)) {
    if (element(boxId).checked) lists[listName].push(labelId);
  }
  for (const selectId of ["label", "category"]) {
    if (element(selectId).value) lists.addLabelIds.push(element(selectId).value);
  }
  return {
    ...otherOptions,
    ...(lists.addLabelIds.length ? { addLabelIds: lists.addLabelIds } : {}),
    ...(lists.removeLabelIds.length ? { removeLabelIds: lists.removeLabelIds } : {}),
  };
}

/** Addresses then domains, each with the fields where it appears. */
function buildCandidates(addressesByField) {
  const fieldsByValue = new Map();
  const addCandidate = (value, field) => {
    if (!fieldsByValue.has(value)) fieldsByValue.set(value, new Set());
    fieldsByValue.get(value).add(field);
  };
  for (const [field, addresses] of Object.entries(addressesByField)) {
    addresses.forEach(address => addCandidate(address, field));
  }
  for (const [field, addresses] of Object.entries(addressesByField)) {
    for (const address of addresses) {
      const domain = address.slice(address.indexOf("@") + 1);
      if (!PUBLIC_DOMAIN.test(domain)) addCandidate(domain, field);
    }
  }
  return [...fieldsByValue].map(([value, fields]) => ({
    value,
    fields: [...fields],
    isDomain: !value.includes("@"),
  }));
}

function checkFields(fields) {
  for (const checkbox of document.querySelectorAll("input[name=field]")) {
    checkbox.checked = fields.includes(checkbox.value);
  }
}

/** Adds the fields of a newly checked value, or takes them if it is the only one. */
function addFields(fields) {
  if (document.querySelectorAll("input[name=value]:checked").length === 1) return checkFields(fields);
  for (const checkbox of document.querySelectorAll("input[name=field]")) {
    if (fields.includes(checkbox.value)) checkbox.checked = true;
  }
}

let countTimer = null;
let latestCountId = 0;

function refreshQuery() {
  element("query").value = buildQuery();
  refreshChecks();
}

function refreshChecks() {
  renderRelatedFilters();
  scheduleCount();
}

const countWithMore = (count, hasMore) => `${count}${hasMore ? "+" : ""}`;

function resetSearchResults() {
  element("count").textContent = "";
  element("broad").hidden = true;
  element("samplePanel").hidden = true;
  element("overlaps").replaceChildren();
}

function scheduleCount() {
  clearTimeout(countTimer);
  latestCountId++;
  resetSearchResults();
  countTimer = setTimeout(async () => {
    const query = fullQuery(buildCriteria());
    if (!query) return;
    const countId = ++latestCountId;
    element("count").textContent = translate("filterSearching");
    const result = await send({ command: "filterCount", query });
    if (countId !== latestCountId) return; // a newer search has started
    element("count").className = result.error ? "hint error" : "hint";
    element("count").textContent = result.error
      ? result.error
      : result.mailboxCount === 0
        ? translate("filterNoMatch")
        : translate("filterMatches",
          countWithMore(result.mailboxCount, result.hasMoreInMailbox),
          countWithMore(result.inboxCount, result.hasMoreInInbox));
    if (result.error) return;
    renderBroadWarning(query, result);
    if (result.mailboxCount) renderSample(query, countId);
  }, COUNT_DELAY);
}

/** A search matching too much: a public domain, very short terms or many messages. */
function renderBroadWarning(query, { hasMoreInMailbox }) {
  const terms = searchTerms(query).filter(term => !term.negated);
  const isVague = terms.some(({ value }) => value.length < MIN_SEARCH_LENGTH || PUBLIC_DOMAIN.test(value));
  element("broad").hidden = !isVague && !hasMoreInMailbox;
  element("broad").textContent = translate("filterTooBroad");
}

function formatMessageLine({ from, subject, date }) {
  const dateText = date ? `${formatDate(date)} · ` : "";
  return `${dateText}${from} · ${subject || translate("noSubject")}`;
}

async function renderSample(query, countId) {
  const sample = await send({ command: "filterSample", query });
  if (countId !== latestCountId || sample.error) return;
  element("preview").replaceChildren(...sample.preview.map(message => {
    const entry = document.createElement("li");
    entry.textContent = formatMessageLine(message);
    return entry;
  }));
  element("labelSummary").textContent = sample.labelCounts.length
    ? translate("filterLabelSummary", sample.sampleSize, sample.labelCounts
      .map(([labelId, count]) => `${labelsById.get(labelId)?.name ?? labelId} (${count})`).join(", "))
    : translate("filterNoLabelSummary", sample.sampleSize);
  element("samplePanel").hidden = false;
}

function describeFilter(filter) {
  const labelNames = userLabelIds(filter.action).map(id => labelsById.get(id)?.name ?? translate("labelDeleted"));
  return `${labelNames.join(", ") || translate("filterNoLabel")} : ${fullQuery(filter.criteria)}`;
}

function createFilterButton(textKey, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = translate(textKey);
  button.addEventListener("click", onClick);
  return button;
}

function createOpenButton(filter) {
  return createFilterButton("filterOpen", () =>
    send({ command: "filterFormOpen", email: proposal.email, filterId: filter.id }));
}

function renderRelatedFilters() {
  const criteria = buildCriteria();
  const action = buildAction();
  const related = element("query").value.trim()
    ? findRelatedFilters(proposal.filters, criteria, action, proposal.filter?.id)
    : [];
  const hasDuplicate = related.some(({ kind }) => kind === "duplicate");
  element("create").disabled = hasDuplicate;

  element("related").replaceChildren(...related.slice(0, MAX_RELATED_SHOWN).map(({ filter, kind, archiveDiffers }) => {
    const entry = document.createElement("li");
    entry.className = kind === "duplicate" ? "error" : "warning";
    const text = document.createElement("span");
    text.textContent = translate(`related_${kind}`, describeFilter(filter)) +
      (archiveDiffers && kind !== "duplicate" ? ` ${translate("relatedArchive")}` : "");
    entry.append(text, " ", createOpenButton(filter));
    const merged = kind === "related" || kind === "covered"
      ? mergedQuery(filter, element("query").value, action)
      : null;
    if (merged && merged !== filter.criteria.query && proposal.mode !== "edit") {
      entry.append(" ", createFilterButton("filterMerge", () => mergeInto(filter, merged)));
    }
    return entry;
  }));
  if (related.length > MAX_RELATED_SHOWN) {
    const entry = document.createElement("li");
    entry.className = "hint";
    entry.textContent = translate("relatedMore", related.length - MAX_RELATED_SHOWN);
    element("related").append(entry);
  }
}

async function analyzeOverlaps() {
  const query = fullQuery(buildCriteria());
  const list = element("overlaps");
  const showLine = text => {
    const entry = document.createElement("li");
    entry.textContent = text;
    list.append(entry);
    return entry;
  };
  list.replaceChildren();
  showLine(translate("filterAnalyzing", proposal.filters.length));
  const result = await send({ command: "filterOverlaps", query });
  list.replaceChildren();
  if (result.error) return (showLine(result.error).className = "error");
  if (!result.overlaps.length) return showLine(translate("filterNoOverlap"));
  for (const { filterId, count, hasMore } of result.overlaps.slice(0, MAX_OVERLAPS_SHOWN)) {
    const filter = proposal.filters.find(entry => entry.id === filterId);
    showLine(translate("filterOverlap", countWithMore(count, hasMore), describeFilter(filter)))
      .append(" ", createOpenButton(filter));
  }
  if (result.overlaps.length > MAX_OVERLAPS_SHOWN) {
    showLine(translate("relatedMore", result.overlaps.length - MAX_OVERLAPS_SHOWN));
  }
}

function renderCandidates(candidates) {
  const container = element("values");
  for (const candidate of candidates) {
    const row = document.createElement("label");
    row.className = "option";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.name = "value";
    checkbox.value = candidate.value;
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) addFields(candidate.fields);
      refreshQuery();
    });
    row.append(checkbox, candidate.isDomain ? translate("filterDomain", candidate.value) : candidate.value);
    for (const field of candidate.fields) {
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = FIELD_NAMES[field];
      row.append(" ", tag);
    }
    container.append(row);
  }
}

function addSelectOption(select, value, text) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = text;
  select.append(option);
}

function fillActionControls(action, labelId) {
  addSelectOption(element("label"), "", translate("filterNoLabel"));
  const userLabels = proposal.labels
    .filter(label => label.type === "user")
    .sort((first, second) => first.name.localeCompare(second.name));
  userLabels.forEach(label => addSelectOption(element("label"), label.id, label.name));
  element("label").value = labelId ?? "";

  addSelectOption(element("category"), "", translate("filterNoCategory"));
  CATEGORY_IDS.forEach(id => addSelectOption(element("category"), id, translate(`sys${id}`)));
  element("category").value = action.addLabelIds?.find(id => CATEGORY_IDS.includes(id)) ?? "";

  for (const [boxId, [listName, id]] of Object.entries(ACTION_BOXES)) {
    element(boxId).checked = action[listName]?.includes(id) ?? false;
  }
}

/** After a move or a label ("suggest"), or from the context menu of a message ("message"). */
function setUpSuggestion() {
  const subject = proposal.subject || translate("noSubject");
  if (proposal.mode === "suggest") {
    const otherMessages = proposal.messageCount > 1
      ? translate("filterIntroMore", proposal.messageCount - 1)
      : "";
    element("intro").textContent = translate("filterIntro", subject, otherMessages, proposal.labelName);
    element("ignore").hidden = false;
  } else {
    element("intro").textContent = translate("filterIntroMessage", subject);
  }
  element("intro").hidden = false;

  const candidates = buildCandidates(proposal.addresses);
  renderCandidates(candidates);
  const candidate = (proposal.preferDomain && candidates.find(entry => entry.isDomain)) || candidates[0];
  const checkboxes = [...document.querySelectorAll("input[name=value]")];
  (checkboxes.find(checkbox => checkbox.value === candidate?.value) ?? checkboxes.at(-1)).checked = true;
  if (proposal.preferDomain) checkFields(ALL_ADDRESS_FIELDS);
  else checkFields(candidate?.fields ?? ["from"]);
  refreshQuery();
}

/** Guided fields if the form can rebuild the search, otherwise the search alone. */
function setUpEdition() {
  const query = editableQuery(proposal.filter.criteria);
  const simple = parseSimpleQuery(query);
  element("query").value = query;
  if (simple) {
    document.querySelector("input[value=keyword]").checked = true;
    element("keyword").value = simple.values.join(" | ");
    checkFields(simple.fields);
  } else {
    element("criterionSection").hidden = true;
    element("fieldsSection").hidden = true;
  }
  const others = Object.entries(otherCriteria(proposal.filter.criteria))
    .map(([name, value]) => `${name}: ${value}`);
  element("otherCriteria").textContent = translate("filterOtherCriteria", others.join(", "));
  element("otherCriteria").hidden = !others.length;
  if (proposal.filter.action.forward) {
    element("otherActions").textContent = translate("filterForwardKept", proposal.filter.action.forward);
    element("otherActions").hidden = false;
  }
  element("existingNote").hidden = false;
  element("delete").hidden = false;
  refreshChecks();
}

function setUpNewFilter() {
  document.querySelector("input[value=keyword]").checked = true;
  checkFields(ALL_ADDRESS_FIELDS);
  refreshQuery();
}

async function runCommand(command, parameters = {}) {
  document.body.classList.add("busy");
  const result = await send({ command, ...parameters });
  document.body.classList.remove("busy");
  if (result?.error) setStatus(result.error, true);
  return result;
}

function showSaveResult(result, doneKey, doneAppliedKey) {
  const appliedText = result.appliedCount ? translate(doneAppliedKey, result.appliedCount) : translate(doneKey);
  const warnings = [result.hasMore ? translate("filterApplyLimit") : "", result.warning ?? ""].filter(Boolean);
  setStatus([appliedText, ...warnings].join(" "), Boolean(result.warning));
  setTimeout(closeWindow, warnings.length ? WARNING_CLOSE_DELAY : CLOSE_DELAY);
}

const existingMessagesChoice = () => document.querySelector("input[name=existing]:checked").value;

async function mergeInto(filter, query) {
  setStatus(translate("filterCreating"));
  const result = await runCommand("filterSave", {
    criteria: { query },
    action: filter.action,
    targetFilterId: filter.id,
    applyQuery: element("query").value.trim(),
    existingMessages: existingMessagesChoice(),
  });
  if (!result.error) showSaveResult(result, "filterMerged", "filterMergedApplied");
}

async function saveFilter() {
  const criteria = buildCriteria();
  const action = buildAction();
  const query = fullQuery(criteria);
  if (!query) return setStatus(translate("filterNeedCriterion"), true);
  if (!Object.keys(action).length) return setStatus(translate("filterNeedAction"), true);
  setStatus(translate("filterCreating"));
  const result = await runCommand("filterSave", {
    criteria,
    action,
    targetFilterId: proposal.filter?.id,
    applyQuery: query,
    existingMessages: existingMessagesChoice(),
  });
  if (result.error) return;
  if (proposal.mode === "edit") showSaveResult(result, "filterSaved", "filterSavedApplied");
  else showSaveResult(result, "filterCreated", "filterCreatedApplied");
}

/** Deletes on the second click, like in the filter list. */
let deleteTimer = null;

async function deleteEditedFilter() {
  if (!deleteTimer) {
    element("delete").textContent = translate("listConfirm");
    deleteTimer = setTimeout(() => {
      deleteTimer = null;
      element("delete").textContent = translate("filterDelete");
    }, CONFIRM_DELAY);
    return;
  }
  clearTimeout(deleteTimer);
  deleteTimer = null;
  element("delete").textContent = translate("filterDelete");
  if ((await runCommand("filterDeleteEdited")).error) return;
  setStatus(translate("filterDeleted"));
  setTimeout(closeWindow, CLOSE_DELAY);
}

function setUpListeners() {
  const keywordCheckbox = document.querySelector("input[value=keyword]");
  element("keyword").addEventListener("input", () => {
    if (element("keyword").value.trim()) keywordCheckbox.checked = true;
    refreshQuery();
  });
  keywordCheckbox.addEventListener("change", refreshQuery);
  document.querySelectorAll("input[name=field]")
    .forEach(checkbox => checkbox.addEventListener("change", refreshQuery));
  element("allFields").addEventListener("click", () => {
    checkFields(ALL_ADDRESS_FIELDS);
    refreshQuery();
  });
  element("query").addEventListener("input", refreshChecks);
  for (const id of ["label", "category", ...Object.keys(ACTION_BOXES)]) {
    element(id).addEventListener("change", renderRelatedFilters);
  }
  element("analyze").addEventListener("click", analyzeOverlaps);
  element("create").addEventListener("click", saveFilter);
  element("delete").addEventListener("click", deleteEditedFilter);
  element("ignore").addEventListener("click", async () => {
    if (!(await runCommand("filterIgnoreFolder")).error) closeWindow();
  });
  element("dismiss").addEventListener("click", () =>
    (proposal.mode === "suggest" ? send({ command: "filterDismiss" }) : Promise.resolve()).then(closeWindow));
}

(async () => {
  localizePage();
  proposal = await send({ command: "proposal" });
  if (proposal.error) {
    element("heading").textContent = translate("filterTitle");
    setStatus(proposal.error, true);
    document.querySelectorAll("fieldset, label, .buttons button:not(#dismiss)")
      .forEach(node => (node.hidden = true));
    element("dismiss").textContent = translate("filterClose");
    element("dismiss").addEventListener("click", closeWindow);
    return;
  }

  labelsById = new Map(proposal.labels.map(label => [label.id, label]));
  const isEdition = proposal.mode === "edit";
  const action = proposal.filter?.action ?? {};
  element("heading").textContent = translate(
    isEdition ? "filterEditHeading" : proposal.mode === "suggest" ? "filterHeading" : "filterNewHeading");
  document.title = element("heading").textContent;
  element("create").textContent = translate(isEdition ? "filterSave" : "filterCreate");
  if (proposal.mode !== "suggest") element("dismiss").textContent = translate("filterClose");
  fillActionControls(action, proposal.labelId ?? userLabelIds(action)[0]);

  setUpListeners();
  if (isEdition) setUpEdition();
  else if (proposal.mode === "new") setUpNewFilter();
  else setUpSuggestion();
})();
