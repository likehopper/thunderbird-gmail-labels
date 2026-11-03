/**
 * Gmail filter logic shared by the background script and the pages: the search of a
 * filter, the terms of a search, and the comparison with existing filters.
 */
const TERM_PATTERN = /(-?)(?:([a-z]+):)?("[^"]*"|\([^()]*\)|[^\s(){}"]+)/gi;
const NEGATED_GROUP_PATTERN = /-[({][^(){}]*[)}]/g;
const SYSTEM_LABEL_PATTERN = /^(INBOX|STARRED|IMPORTANT|TRASH|SPAM|UNREAD|SENT|DRAFT|CATEGORY_\w+)$/;

const uniqueSorted = values => [...new Set(values)].sort();

const fieldSearch = (operator, value) => /[\s|]/.test(value)
  ? `${operator}:(${value.split(/\s*\|\s*/).join(" OR ")})`
  : `${operator}:${value}`;

/** The part of a filter's criteria edited in the form, as a Gmail search. */
function editableQuery(criteria = {}) {
  const parts = ["from", "to", "subject"]
    .filter(field => criteria[field])
    .map(field => fieldSearch(field, criteria[field]));
  if (criteria.query) parts.push(criteria.query);
  return parts.join(" ");
}

/** The criteria the form does not edit, always kept as they are. */
function otherCriteria(criteria = {}) {
  const { from, to, subject, query, ...others } = criteria;
  return others;
}

/** Search matching the same messages as all the criteria of a filter. */
function fullQuery(criteria = {}) {
  const parts = [editableQuery(criteria)];
  if (criteria.negatedQuery) parts.push(`-{${criteria.negatedQuery}}`);
  if (criteria.hasAttachment) parts.push("has:attachment");
  if (criteria.size) {
    parts.push(`${criteria.sizeComparison === "smaller" ? "smaller" : "larger"}:${criteria.size}`);
  }
  return parts.filter(Boolean).join(" ");
}

function parseTerms(text, negated, terms) {
  for (const [, minus, field, rawValue] of text.matchAll(TERM_PATTERN)) {
    if (/^(OR|AND)$/.test(rawValue)) continue;
    const values = rawValue.startsWith("(")
      ? rawValue.slice(1, -1).split(/\s+OR\s+|\s+/)
      : [rawValue.replace(/"/g, "")];
    for (const value of values.filter(value => value && value !== "OR")) {
      terms.push({ field: field?.toLowerCase() ?? null, value: value.toLowerCase(), negated: negated || Boolean(minus) });
    }
  }
}

/** Terms of a Gmail search: { field, value, negated }. */
function searchTerms(query) {
  const terms = [];
  const rest = query.replace(NEGATED_GROUP_PATTERN, group => {
    parseTerms(group.slice(2, -1), true, terms);
    return " ";
  });
  parseTerms(rest, false, terms);
  return terms;
}

/** True when any single term of the search is enough to match a message. */
function isOrSearch(query) {
  const search = query.trim();
  const terms = searchTerms(search);
  if (!terms.length || terms.some(term => term.negated)) return false;
  if (/^\{[^{}]*\}$/.test(search)) return true;
  if (/^[a-z]+:\([^()]*\bOR\b[^()]*\)$/i.test(search)) return true;
  return terms.length === 1;
}

/** { values, fields } when the form can show this search (each value in the same fields), or null. */
function parseSimpleQuery(query) {
  if (!isOrSearch(query)) return null;
  const terms = searchTerms(query);
  const operatorsByValue = new Map();
  for (const term of terms) {
    if (!operatorsByValue.has(term.value)) operatorsByValue.set(term.value, new Set());
    operatorsByValue.get(term.value).add(term.field);
  }
  const operatorKeys = [...operatorsByValue.values()].map(operators => uniqueSorted(operators).join(" "));
  if (operatorKeys.some(key => key !== operatorKeys[0])) return null;
  const operators = [...operatorsByValue.values()][0];
  if (operators.has("to") !== operators.has("cc")) return null;
  const fields = [];
  for (const operator of operators) {
    if (operator === "cc") continue;
    const field = { from: "from", to: "to", replyto: "replyTo", subject: "subject" }[operator];
    if (!field) return null;
    fields.push(field);
  }
  return { values: [...operatorsByValue.keys()], fields };
}

function searchKey(query) {
  if (isOrSearch(query)) {
    return `any ${uniqueSorted(searchTerms(query).map(term => `${term.field}:${term.value}`)).join(" ")}`;
  }
  return `all ${query.trim().toLowerCase().replace(/\s+/g, " ")}`;
}

const actionKey = (action = {}) => JSON.stringify([
  uniqueSorted(action.addLabelIds ?? []),
  uniqueSorted(action.removeLabelIds ?? []),
  action.forward ?? "",
]);

/** Two filters with the same key are duplicates. */
const filterKey = (criteria, action) => `${searchKey(fullQuery(criteria))}|${actionKey(action)}`;

const userLabelIds = (action = {}) => (action.addLabelIds ?? []).filter(id => !SYSTEM_LABEL_PATTERN.test(id));
const archives = (action = {}) => (action.removeLabelIds ?? []).includes("INBOX");

/** A domain covers its addresses and subdomains. */
function valueCovers(broadValue, narrowValue) {
  return broadValue === narrowValue ||
    narrowValue.endsWith(`@${broadValue}`) ||
    (broadValue.includes(".") && narrowValue.endsWith(`.${broadValue}`));
}

const isAddressLike = value => /[@.]/.test(value);

function termsOverlap(firstTerm, secondTerm) {
  const sameValue = valueCovers(firstTerm.value, secondTerm.value) || valueCovers(secondTerm.value, firstTerm.value);
  return sameValue && (firstTerm.field === secondTerm.field || isAddressLike(firstTerm.value));
}

/**
 * Filters related to these criteria and this action, the most important first. Kinds:
 * "duplicate", "covered" (same label, already matches all these terms), "related" (same
 * label, a common term), "overlap" (other label or none, a common term).
 */
function findRelatedFilters(filters, criteria, action, ignoredFilterId = null) {
  const ranks = { duplicate: 0, covered: 1, related: 2, overlap: 3 };
  const key = filterKey(criteria, action);
  const query = editableQuery(criteria);
  const positiveTerms = searchTerms(query).filter(term => !term.negated);
  const labelIds = userLabelIds(action);

  return filters.flatMap(filter => {
    if (filter.id === ignoredFilterId) return [];
    const archiveDiffers = archives(action) !== archives(filter.action);
    if (filterKey(filter.criteria, filter.action) === key) return [{ filter, kind: "duplicate", archiveDiffers }];
    const existingQuery = editableQuery(filter.criteria);
    const existingTerms = searchTerms(existingQuery).filter(term => !term.negated);
    const hasCommonTerm = positiveTerms.some(term => existingTerms.some(other => termsOverlap(term, other)));
    if (!hasCommonTerm) return [];
    const sameLabel = userLabelIds(filter.action).some(id => labelIds.includes(id));
    const isCovered = isOrSearch(existingQuery) && !filter.criteria.negatedQuery && positiveTerms.every(term =>
      existingTerms.some(other => other.field === term.field && valueCovers(other.value, term.value)));
    const kind = !sameLabel ? "overlap" : isCovered ? "covered" : "related";
    return [{ filter, kind, archiveDiffers }];
  }).sort((first, second) => ranks[first.kind] - ranks[second.kind]);
}

/**
 * True when a term of the filter matches these message addresses ({ from, to, replyTo }
 * and subject). Exact for OR searches, approximate otherwise (any term is enough).
 */
function filterMatchesMessage(filter, { from, to, replyTo, subject = "" }) {
  const addressesByOperator = { from, to, cc: to, replyto: replyTo };
  const allAddresses = [...from, ...to, ...replyTo];
  const lowerSubject = subject.toLowerCase();
  return searchTerms(editableQuery(filter.criteria)).some(({ field, value, negated }) => {
    if (negated) return false;
    if (field === "subject") return lowerSubject.includes(value);
    const addresses = field ? addressesByOperator[field] : allAddresses;
    return Boolean(addresses?.some(address => valueCovers(value, address)) ||
      (!field && lowerSubject.includes(value)));
  });
}

const orSearchItems = query => {
  const search = query.trim();
  return (search.startsWith("{") ? search.slice(1, -1) : search).match(/[^\s"]*"[^"]*"|\S+/g) ?? [];
};

const isPlainOrSearch = search => isOrSearch(search) &&
  (/^\{[^{}]*\}$/.test(search.trim()) || orSearchItems(search).length === 1);

/** Only a plain OR search, without other criteria, can be merged with another one. */
function isMergeableFilter(filter) {
  const { query, ...otherFilterCriteria } = filter.criteria ?? {};
  return Boolean(query) && !Object.keys(otherFilterCriteria).length && isPlainOrSearch(query);
}

/** Items without duplicates nor those covered by another item of the same field (its domain). */
function withoutRedundantItems(items) {
  const unique = [...new Map(items.map(item => [item.toLowerCase(), item])).values()];
  const terms = unique.map(item => searchTerms(item)[0]);
  return unique.filter((item, index) => !terms.some((other, otherIndex) => otherIndex !== index &&
    other && terms[index] && other.field === terms[index].field && other.value !== terms[index].value &&
    valueCovers(other.value, terms[index].value)));
}

/** OR searches of at most maxLength characters holding all the items. */
function splitOrSearch(items, maxLength) {
  const queries = [];
  let current = [];
  const asQuery = list => list.length > 1 ? `{${list.join(" ")}}` : list[0];
  for (const item of items) {
    if (current.length && asQuery([...current, item]).length > maxLength) {
      queries.push(asQuery(current));
      current = [];
    }
    current.push(item);
  }
  if (current.length) queries.push(asQuery(current));
  return queries;
}

/**
 * Filters doing exactly the same thing (same action key) merged into as few OR searches
 * as maxLength allows: { action, filters, queries, removedItems }, only when it saves a
 * filter or a redundant term.
 */
function optimizationGroups(filters, maxLength) {
  const filtersByAction = new Map();
  for (const filter of filters.filter(isMergeableFilter)) {
    const key = actionKey(filter.action);
    filtersByAction.set(key, [...(filtersByAction.get(key) ?? []), filter]);
  }
  return [...filtersByAction.values()].flatMap(group => {
    const allItems = group.flatMap(filter => orSearchItems(filter.criteria.query));
    const items = withoutRedundantItems(allItems);
    const queries = splitOrSearch(items, maxLength);
    const removedItems = allItems.length - items.length;
    if (queries.length >= group.length && !removedItems) return [];
    return [{ action: group[0].action, filters: group, queries, removedItems }];
  });
}

/**
 * Filters sharing a term but doing different things: Gmail applies both, so the
 * message gets both actions. [{ filters: [first, second], values }]
 */
function concurrentFilters(filters) {
  const entries = filters.map(filter => ({
    filter,
    key: actionKey(filter.action),
    terms: searchTerms(editableQuery(filter.criteria)).filter(term => !term.negated),
  }));
  const pairs = [];
  entries.forEach((first, index) => {
    for (const second of entries.slice(index + 1)) {
      if (first.key === second.key) continue;
      const values = new Set();
      for (const term of first.terms) {
        for (const other of second.terms) {
          if (termsOverlap(term, other)) values.add(term.value.length <= other.value.length ? term.value : other.value);
        }
      }
      if (values.size) pairs.push({ filters: [first.filter, second.filter], values: [...values] });
    }
  });
  return pairs;
}

/** The search of this filter extended with a new search, or null if they can't be merged. */
function mergedQuery(filter, query, action) {
  const { query: existingQuery, ...otherExistingCriteria } = filter.criteria ?? {};
  if (!existingQuery || Object.keys(otherExistingCriteria).length) return null;
  if (actionKey(filter.action) !== actionKey(action)) return null;
  if (!isPlainOrSearch(existingQuery) || !isPlainOrSearch(query)) return null;
  const items = [...new Set([...orSearchItems(existingQuery), ...orSearchItems(query)])];
  return items.length > 1 ? `{${items.join(" ")}}` : items[0];
}
