/**
 * All the Gmail filters of an account: search, sort, delete with undo, and opens the
 * filter window to create or edit one. Message counts load as rows become visible.
 * The optimizer merges the filters doing the same thing and lists the concurrent ones.
 */
const element = id => document.getElementById(id);
const send = request => browser.runtime.sendMessage(request);
const CONFIRM_DELAY = 4000;
const COUNTS_AT_ONCE = 3;
const EXPORT_URL_DURATION = 60 * 1000; // the download reads the file meanwhile
const ANSWER_TIMEOUT = 90 * 1000;

/** Rejects if the background script does not answer, rather than waiting forever. */
function withTimeout(promise) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(translate("errNoAnswer"))), ANSWER_TIMEOUT);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
const FIELD_OPTIONS = ["from", "to", "cc", "replyto", "subject"];
const STATE_OPTIONS = ["duplicate", "missingLabel", "forward"];
// Action name -> how to recognize it in a filter's action
const ACTION_TESTS = {
  archive: action => action.removeLabelIds?.includes("INBOX"),
  read: action => action.removeLabelIds?.includes("UNREAD"),
  star: action => action.addLabelIds?.includes("STARRED"),
  important: action => action.addLabelIds?.includes("IMPORTANT"),
  neverSpam: action => action.removeLabelIds?.includes("SPAM"),
  trash: action => action.addLabelIds?.includes("TRASH"),
  category: action => action.addLabelIds?.some(id => id.startsWith("CATEGORY_")),
  forward: action => Boolean(action.forward),
};

let email = null;
let filters = [];
let labelsById = new Map();
let isStale = false;
let duplicateIds = new Set();
let lastDeleted = [];
const selectedIds = new Set();
const sort = { column: "label", direction: 1 };
const counts = new Map(); // filter id -> { count, hasMore }
const countQueue = [];
let runningCounts = 0;

const labelName = id => labelsById.get(id)?.name ?? translate("labelDeleted");
const hasMissingLabel = filter => userLabelIds(filter.action).some(id => !labelsById.has(id));
const filterLabelText = filter => userLabelIds(filter.action).map(labelName).join(", ");

function setStatus(text, isError = false) {
  element("status").textContent = text ?? "";
  element("status").className = isError ? "error" : "";
}

function fillSelect(select, allTextKey, options) {
  const previousValue = select.value;
  const createOption = (value, text) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text;
    return option;
  };
  select.replaceChildren(createOption("", translate(allTextKey)),
    ...options.map(([value, text]) => createOption(value, text)));
  if (options.some(([value]) => value === previousValue)) select.value = previousValue;
}

function matchesFilters(filter) {
  const search = element("search").value.trim().toLowerCase();
  const query = fullQuery(filter.criteria);
  const labelId = element("labelFilter").value;
  const actionName = element("actionFilter").value;
  const fieldName = element("fieldFilter").value;
  const stateName = element("stateFilter").value;
  const states = {
    duplicate: duplicateIds.has(filter.id),
    missingLabel: hasMissingLabel(filter),
    forward: Boolean(filter.action.forward),
  };
  return (!search || `${filterLabelText(filter)} ${query}`.toLowerCase().includes(search)) &&
    (!labelId || userLabelIds(filter.action).includes(labelId)) &&
    (!actionName || ACTION_TESTS[actionName](filter.action)) &&
    (!fieldName || searchTerms(query).some(term => term.field === fieldName && !term.negated)) &&
    (!stateName || states[stateName]);
}

function compareFilters(first, second) {
  if (sort.column === "count") {
    return ((counts.get(first.id)?.count ?? -1) - (counts.get(second.id)?.count ?? -1)) * sort.direction;
  }
  const text = filter => sort.column === "label" ? filterLabelText(filter) : fullQuery(filter.criteria);
  return text(first).localeCompare(text(second)) * sort.direction;
}

function createTag(text, className = "tag") {
  const tag = document.createElement("span");
  tag.className = className;
  tag.textContent = text;
  return tag;
}

function renderCriteria(cell, filter) {
  const query = editableQuery(filter.criteria);
  const simple = Object.keys(otherCriteria(filter.criteria)).length ? null : parseSimpleQuery(query);
  if (!simple) {
    cell.append(createTag(fullQuery(filter.criteria), "query"));
    return;
  }
  const fieldNames = { from: "fieldFrom", to: "fieldTo", replyTo: "fieldReplyTo", subject: "fieldSubject" };
  cell.append(simple.values.join(" | "), " ", ...simple.fields.flatMap(field => [createTag(translate(fieldNames[field])), " "]));
}

function renderActions(cell, action) {
  const names = Object.keys(ACTION_TESTS).filter(name => ACTION_TESTS[name](action));
  cell.append(...names.flatMap(name => [createTag(translate(`listAction_${name}`)), " "]));
}

function formatCount({ count, hasMore }) {
  return `${count}${hasMore ? "+" : ""}`;
}

async function runCountQueue() {
  while (runningCounts < COUNTS_AT_ONCE && countQueue.length) {
    const { filter, cell } = countQueue.shift();
    if (counts.has(filter.id)) {
      cell.textContent = formatCount(counts.get(filter.id));
      continue;
    }
    runningCounts++;
    const requestEmail = email;
    send({ command: "filterListCount", email, query: fullQuery(filter.criteria) }).then(result => {
      runningCounts--;
      if (requestEmail === email) {
        if (result.error) {
          cell.textContent = "?";
          cell.title = result.error;
        } else {
          counts.set(filter.id, result);
          cell.textContent = formatCount(result);
        }
      }
      runCountQueue();
    });
  }
}

const countObserver = new IntersectionObserver(entries => {
  for (const entry of entries.filter(entry => entry.isIntersecting)) {
    countObserver.unobserve(entry.target);
    const filter = filters.find(candidate => candidate.id === entry.target.dataset.filterId);
    if (filter) countQueue.push({ filter, cell: entry.target });
  }
  runCountQueue();
});

/** Deletes on the second click, to avoid a dialog for each filter. */
function createConfirmedButton(textKey, onConfirm, button = document.createElement("button")) {
  let timer = null;
  button.textContent = translate(textKey);
  button.addEventListener("click", () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
      button.textContent = translate(textKey);
      onConfirm();
      return;
    }
    button.textContent = translate("listConfirm");
    timer = setTimeout(() => {
      timer = null;
      button.textContent = translate(textKey);
    }, CONFIRM_DELAY);
  });
  return button;
}

function createRow(filter) {
  const row = document.createElement("tr");
  const selectCell = document.createElement("td");
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = selectedIds.has(filter.id);
  checkbox.addEventListener("change", () => {
    if (checkbox.checked) selectedIds.add(filter.id);
    else selectedIds.delete(filter.id);
    renderSelection();
  });
  selectCell.append(checkbox);

  const labelCell = document.createElement("td");
  labelCell.textContent = filterLabelText(filter);
  if (hasMissingLabel(filter)) labelCell.className = "warning";
  const criteriaCell = document.createElement("td");
  renderCriteria(criteriaCell, filter);
  if (duplicateIds.has(filter.id)) {
    criteriaCell.append(" ", createTag(translate("listState_duplicate"), "tag alert"));
  }
  const actionsCell = document.createElement("td");
  renderActions(actionsCell, filter.action);

  const countCell = document.createElement("td");
  countCell.className = "count";
  countCell.dataset.filterId = filter.id;
  if (counts.has(filter.id)) countCell.textContent = formatCount(counts.get(filter.id));
  else if (!isStale) countObserver.observe(countCell);

  const buttonsCell = document.createElement("td");
  buttonsCell.className = "buttons";
  if (!isStale) {
    const editButton = document.createElement("button");
    editButton.textContent = translate("listEdit");
    editButton.addEventListener("click", () => openForm(filter.id));
    buttonsCell.append(editButton, " ",
      createConfirmedButton("listDelete", () => deleteFilters([filter])));
  }
  row.append(selectCell, labelCell, criteriaCell, actionsCell, countCell, buttonsCell);
  return row;
}

function renderSelection() {
  const count = selectedIds.size;
  element("selection").hidden = !count || isStale;
  element("selectionText").textContent = translate("listSelected", count);
}

function render() {
  countObserver.disconnect();
  countQueue.length = 0;
  const visibleFilters = filters.filter(matchesFilters).sort(compareFilters);
  element("rows").replaceChildren(...visibleFilters.map(createRow));
  element("total").textContent = visibleFilters.length === filters.length
    ? translate("listTotal", filters.length)
    : translate("listShown", visibleFilters.length, filters.length);
  renderSelection();
}

function showNotice(text, canUndo) {
  element("noticeText").textContent = text;
  element("notice").hidden = false;
  element("undo").hidden = !canUndo;
}

async function openForm(filterId) {
  const result = await send({ command: "filterFormOpen", email, filterId });
  if (result.error) setStatus(result.error, true);
}

/**
 * Saves a JSON copy in the downloads folder (a link with "download" does nothing in
 * Thunderbird). Returns the file path, or null after showing the error.
 */
async function exportFilters(filtersToExport) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(filtersToExport, null, 2)], { type: "application/json" }));
  const time = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
  try {
    const downloadId = await browser.downloads.download({ url, filename: `gmail-filters-${email}-${time}.json`, saveAs: false });
    const [download] = await browser.downloads.search({ id: downloadId });
    const path = download?.filename ?? "";
    setStatus(translate("exportSaved", path));
    return path;
  } catch (error) {
    setStatus(translate("errExport", error.message), true);
    return null;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), EXPORT_URL_DURATION);
  }
}

async function deleteFilters(filtersToDelete, backupPath = null) {
  document.body.classList.add("busy");
  setStatus();
  const deleted = [];
  let error = null;
  try {
    for (const filter of filtersToDelete) {
      const result = await withTimeout(send({ command: "filterDelete", email, filterId: filter.id }));
      if (result?.error || !result) {
        error = result?.error ?? translate("errNoAnswer");
        break;
      }
      deleted.push(filter);
    }
  } catch (caught) {
    error = caught.message;
  } finally {
    document.body.classList.remove("busy");
  }
  lastDeleted = deleted;
  const backupText = backupPath ? ` ${translate("exportSaved", backupPath)}` : "";
  if (deleted.length) showNotice(translate("listDeleted", deleted.length) + backupText, true);
  if (error) setStatus(error, true);
  selectedIds.clear();
  await loadFilters();
}

async function restoreDeletedFilters() {
  document.body.classList.add("busy");
  setStatus();
  const remaining = [...lastDeleted];
  while (remaining.length) {
    const result = await send({ command: "filterRestore", email, filter: remaining[0] });
    if (result.error) {
      setStatus(result.error, true);
      break;
    }
    remaining.shift();
  }
  document.body.classList.remove("busy");
  const restoredCount = lastDeleted.length - remaining.length;
  lastDeleted = remaining;
  showNotice(translate("listRestored", restoredCount), remaining.length > 0);
  await loadFilters();
}

// Optimizer: merges the filters doing the same thing, lists the concurrent ones
const LIMIT_MARGIN = 0.9; // room left to extend a merged filter later
const MAX_CONCURRENTS_SHOWN = 100;
let queryLimit = null;
let optimizationPlan = [];

const maxMergedLength = () => Math.floor(queryLimit.length * LIMIT_MARGIN);

function describeAction(action) {
  const names = Object.keys(ACTION_TESTS).filter(name => ACTION_TESTS[name](action))
    .map(name => translate(`listAction_${name}`));
  const labels = userLabelIds(action).map(labelName).join(", ") || translate("filterNoLabel");
  return names.length ? `${labels} (${names.join(", ")})` : labels;
}

function createQueryList(queries) {
  const list = document.createElement("ul");
  list.append(...queries.map(query => {
    const entry = document.createElement("li");
    entry.append(createTag(query, "query"));
    return entry;
  }));
  return list;
}

function createGroupItem(group) {
  const entry = document.createElement("li");
  const label = document.createElement("label");
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = true;
  group.checkbox = checkbox;
  const removed = group.removedItems ? ` · ${translate("optimizeRemoved", group.removedItems)}` : "";
  label.append(checkbox, ` ${describeAction(group.action)} : `,
    translate("optimizeGroup", group.filters.length, group.queries.length) + removed);
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = translate("optimizeDetails");
  const before = document.createElement("strong");
  before.textContent = translate("optimizeBefore");
  const after = document.createElement("strong");
  after.textContent = translate("optimizeAfter");
  details.append(summary, before, createQueryList(group.filters.map(filter => filter.criteria.query)),
    after, createQueryList(group.queries));
  entry.append(label, details);
  return entry;
}

function createConcurrentItem({ filters: pair, values }) {
  const entry = document.createElement("li");
  entry.append(`${values.join(", ")} : `);
  pair.forEach((filter, index) => {
    const openButton = document.createElement("button");
    openButton.textContent = translate("filterOpen");
    openButton.addEventListener("click", () => openForm(filter.id));
    entry.append(index ? " ↔ " : "", describeAction(filter.action), " ", createTag(fullQuery(filter.criteria), "query"),
      " ", openButton);
  });
  return entry;
}

function renderOptimizer() {
  if (element("optimizer").hidden) return;
  const prefix = queryLimit && !queryLimit.refused ? "≥ " : "";
  element("limitText").textContent = queryLimit
    ? translate("optimizeLimit", `${prefix}${queryLimit.length}`, formatDate(queryLimit.measuredAt), maxMergedLength())
    : translate("optimizeNoLimit");
  element("limitText").title = queryLimit?.refusal ?? ""; // Gmail's answer beyond the limit
  optimizationPlan = queryLimit ? optimizationGroups(filters, maxMergedLength()) : [];
  const before = optimizationPlan.reduce((total, group) => total + group.filters.length, 0);
  const after = optimizationPlan.reduce((total, group) => total + group.queries.length, 0);
  element("optimizeSummary").textContent = !queryLimit ? ""
    : optimizationPlan.length ? translate("optimizeSummary", optimizationPlan.length, before, after)
      : translate("optimizeNone");
  element("groups").replaceChildren(...optimizationPlan.map(createGroupItem));
  element("applyOptimize").hidden = !optimizationPlan.length;

  const concurrents = concurrentFilters(filters);
  element("concurrents").replaceChildren(...concurrents.slice(0, MAX_CONCURRENTS_SHOWN).map(createConcurrentItem));
  if (!concurrents.length) element("concurrents").textContent = translate("optimizeNoConcurrent");
  else if (concurrents.length > MAX_CONCURRENTS_SHOWN) {
    const more = document.createElement("li");
    more.className = "hint";
    more.textContent = translate("relatedMore", concurrents.length - MAX_CONCURRENTS_SHOWN);
    element("concurrents").append(more);
  }
}

async function openOptimizer() {
  element("optimizer").hidden = false;
  const result = await send({ command: "filterQueryLimit" });
  queryLimit = result.limit ?? null;
  renderOptimizer();
}

async function measureLimit() {
  document.body.classList.add("busy");
  element("limitText").textContent = translate("optimizeMeasuring");
  const result = await send({ command: "filterQueryLimitMeasure", email });
  document.body.classList.remove("busy");
  if (!result.error) queryLimit = result.limit;
  renderOptimizer();
  // Next to the button, where the measure was asked
  if (result.error) element("limitText").replaceChildren(createTag(result.error, "error"));
}

async function applyOptimization() {
  const chosen = optimizationPlan.filter(group => group.checkbox.checked);
  if (!chosen.length) return;
  const backupPath = await exportFilters(filters); // a copy of everything before, or nothing changes
  if (backupPath === null) return;
  document.body.classList.add("busy");
  setStatus();
  let created = 0;
  let deleted = 0;
  const kept = [];
  const errors = [];
  try {
    for (const [index, group] of chosen.entries()) {
      element("optimizeSummary").textContent = translate("optimizeProgress", index + 1, chosen.length, describeAction(group.action));
      const result = await withTimeout(send({
        command: "filterOptimizeGroup",
        email,
        filterIds: group.filters.map(filter => filter.id),
        queries: group.queries,
      }));
      if (result?.error || !result) {
        errors.push(`${describeAction(group.action)} : ${result?.error ?? translate("errNoAnswer")}`);
        continue;
      }
      created += result.created;
      deleted += result.deleted;
      kept.push(...result.kept);
    }
  } catch (error) {
    errors.push(error.message);
  } finally {
    // Whatever happens, the page must not stay greyed out
    document.body.classList.remove("busy");
  }
  showNotice([translate("optimizeDone", created, deleted),
    kept.length ? translate("optimizeKept", kept.length) : "",
    translate("exportSaved", backupPath)].filter(Boolean).join(" "), false);
  await loadFilters();
  if (errors.length) setStatus(errors.join(" — "), true);
}

function findDuplicateIds() {
  const idsByKey = new Map();
  for (const filter of filters) {
    const key = filterKey(filter.criteria, filter.action);
    idsByKey.set(key, [...(idsByKey.get(key) ?? []), filter.id]);
  }
  return new Set([...idsByKey.values()].filter(ids => ids.length > 1).flat());
}

function fillFilterSelects() {
  const usedLabelIds = [...new Set(filters.flatMap(filter => userLabelIds(filter.action)))];
  fillSelect(element("labelFilter"), "listAllLabels", usedLabelIds
    .map(id => [id, labelName(id)])
    .sort((first, second) => first[1].localeCompare(second[1])));
  fillSelect(element("actionFilter"), "listAllActions",
    Object.keys(ACTION_TESTS).map(name => [name, translate(`listAction_${name}`)]));
  fillSelect(element("fieldFilter"), "listAllFields",
    FIELD_OPTIONS.map(name => [name, translate(`listField_${name}`)]));
  fillSelect(element("stateFilter"), "listAllStates",
    STATE_OPTIONS.map(name => [name, translate(`listState_${name}`)]));
}

async function loadFilters() {
  element("total").textContent = translate("loading");
  const result = await send({ command: "filterListRead", email });
  if (result.error) {
    filters = [];
    setStatus(result.error, true);
  } else {
    filters = result.filters;
    labelsById = new Map(result.labels.map(label => [label.id, label]));
    isStale = result.stale;
    duplicateIds = findDuplicateIds();
  }
  element("offline").hidden = !isStale;
  element("new").disabled = isStale;
  element("optimize").disabled = isStale;
  if (isStale) element("optimizer").hidden = true;
  fillFilterSelects();
  render();
  renderOptimizer();
}

async function selectAccount(newEmail) {
  email = newEmail;
  counts.clear();
  selectedIds.clear();
  lastDeleted = [];
  element("notice").hidden = true;
  setStatus();
  await loadFilters();
}

function setUpListeners() {
  element("account").addEventListener("change", event => selectAccount(event.target.value));
  element("new").addEventListener("click", () => openForm());
  element("export").addEventListener("click", () => exportFilters(filters));
  element("undo").addEventListener("click", restoreDeletedFilters);
  element("optimize").addEventListener("click", openOptimizer);
  element("closeOptimizer").addEventListener("click", () => (element("optimizer").hidden = true));
  element("measure").addEventListener("click", measureLimit);
  createConfirmedButton("optimizeApply", applyOptimization, element("applyOptimize"));
  createConfirmedButton("listDeleteSelected", () => {
    const selectedFilters = filters.filter(filter => selectedIds.has(filter.id));
    // A copy before a deletion in bulk, or nothing is deleted
    exportFilters(selectedFilters).then(backupPath => backupPath !== null && deleteFilters(selectedFilters, backupPath));
  }, element("deleteSelected"));
  element("search").addEventListener("input", render);
  for (const id of ["labelFilter", "actionFilter", "fieldFilter", "stateFilter"]) {
    element(id).addEventListener("change", render);
  }
  element("selectAll").addEventListener("change", event => {
    selectedIds.clear();
    if (event.target.checked) filters.filter(matchesFilters).forEach(filter => selectedIds.add(filter.id));
    render();
  });
  for (const button of document.querySelectorAll("button.sort")) {
    button.addEventListener("click", () => {
      sort.direction = sort.column === button.dataset.sort ? -sort.direction : 1;
      sort.column = button.dataset.sort;
      render();
    });
  }
  browser.runtime.onMessage.addListener(request => {
    if (request?.command === "filtersChanged" && request.email === email) loadFilters();
  });
}

(async () => {
  localizePage();
  setUpListeners();
  const accounts = (await send({ command: "accounts" })).filter(account => account.authorized);
  if (!accounts.length) return setStatus(translate("listNoAccount"), true);
  element("account").replaceChildren(...accounts.map(account => {
    const option = document.createElement("option");
    option.value = account.email;
    option.textContent = account.email;
    return option;
  }));
  const requestedEmail = new URLSearchParams(location.search).get("email");
  if (accounts.some(account => account.email === requestedEmail)) element("account").value = requestedEmail;
  await selectAccount(element("account").value);
})();
