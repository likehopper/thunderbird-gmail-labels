/**
 * When a message is moved to a folder matching a Gmail label, or a label is added,
 * suggests (filter/filter.html window) creating the equivalent Gmail filter: an
 * address, a domain or a keyword, searched in From, To/Cc, Reply-to and/or Subject.
 * Suggests nothing if an existing filter already adds this label for this sender.
 * The same window creates or edits filters from the filter list (filter-list/), and
 * creates one from the context menu of a message.
 */
const MAX_COUNTED_MESSAGES = 500;
const MAX_EXISTING_MESSAGES_UPDATED = 5000;
const SAMPLE_SIZE = 50;
const SAMPLE_REQUESTS_AT_ONCE = 10;
const PREVIEW_SIZE = 5;
const OVERLAP_SEARCHES_AT_ONCE = 5;

const proposals = new Map(); // proposal id -> proposal (only one at a time)
const dismissedProposals = new Set(); // "Not now" keys, for the session
let proposalWindowId = null;
let filterListTabId = null;

const folderKey = folder => `${folder.accountId}|${folder.path}`;
const hasOpenEditor = () => [...proposals.values()].some(proposal => proposal.mode !== "suggest");

function extractAddresses(headerValues) {
  const addresses = new Set();
  for (const headerValue of headerValues) {
    for (const match of headerValue.matchAll(/[^\s<>,;:"'()]+@[^\s<>,;:"'()]+\.[a-z]{2,}/gi)) {
      addresses.add(match[0].toLowerCase());
    }
  }
  return [...addresses];
}

async function readMessageAddresses(message, ownAddress) {
  let replyTo = [];
  try {
    replyTo = (await browser.messages.getFull(message.id)).headers?.["reply-to"] ?? [];
  } catch (error) {
    console.warn("Gmail Labels: unreadable Reply-To", error);
  }
  return {
    from: extractAddresses([message.author ?? ""]),
    to: extractAddresses([...(message.recipients ?? []), ...(message.ccList ?? [])])
      .filter(address => address !== ownAddress),
    replyTo: extractAddresses(replyTo),
  };
}

async function proposeFilterAfterMove(messagesBefore, messagesAfter) {
  const settings = await loadStore("settings", {});
  if (settings.proposeFilters === false || !messagesAfter?.length) return;
  const message = messagesAfter[0];
  const targetFolder = message.folder;
  const sourceFolder = messagesBefore?.[0]?.folder;
  // Only a move to a label folder of the same account (not trash, spam, [Gmail]/…)
  if (!targetFolder || !sourceFolder || targetFolder.accountId !== sourceFolder.accountId) return;
  if (targetFolder.specialUse?.length || /^\/\[(Gmail|Google Mail)\]/.test(targetFolder.path)) return;
  if ((settings.ignoredFolders ?? []).includes(folderKey(targetFolder))) return;

  const account = await browser.accounts.get(targetFolder.accountId);
  const email = account?.type === "imap" && account.identities?.[0]?.email?.toLowerCase();
  if (!email || !(await loadStore("tokens", {}))[email]) return;

  const labelsById = await listLabels(email, true);
  const labelId = folderLabelId(targetFolder, labelsById);
  if (!labelId) return;

  await proposeFilter({
    message,
    email,
    labelsById,
    labelId,
    ignoreKey: folderKey(targetFolder),
    messageCount: messagesAfter.length,
  });
}

/** Label added from the bar or the button: same suggestion as for a move. */
async function proposeFilterForLabel(message, email, labelId) {
  const settings = await loadStore("settings", {});
  if (settings.proposeFilters === false) return;
  const labelsById = await listLabels(email);
  const label = labelsById.get(labelId);
  if (label?.type !== "user") return;
  // Same key as the label's folder, so "don't suggest again" applies to both cases
  const ignoreKey = `${message.folder.accountId}|/${label.name}`;
  if ((settings.ignoredFolders ?? []).includes(ignoreKey)) return;
  await proposeFilter({ message, email, labelsById, labelId, ignoreKey, messageCount: 1 });
}

async function proposeFilter({ message, email, labelsById, labelId, ignoreKey, messageCount }) {
  if (hasOpenEditor()) return; // never replace a filter being edited
  const addresses = await readMessageAddresses(message, email);
  const sender = addresses.from[0] ?? "";
  const dismissalKey = `${ignoreKey}|${sender}`;
  if (dismissedProposals.has(dismissalKey)) return;

  const filters = await listFilters(email).catch(error => {
    if (error instanceof AuthError) return []; // the window will show the error
    throw error;
  });
  const alreadyCovered = sender &&
    findRelatedFilters(filters, { query: `from:${sender}` }, { addLabelIds: [labelId] })
      .some(({ kind }) => kind === "duplicate" || kind === "covered");
  if (alreadyCovered) return;

  const { preferDomain = false } = await loadStore("settings", {});
  const proposalId = crypto.randomUUID();
  proposals.clear();
  proposals.set(proposalId, {
    mode: "suggest",
    dismissalKey,
    ignoreKey,
    email,
    labelId,
    labelName: labelsById.get(labelId).name,
    subject: message.subject,
    messageCount,
    addresses,
    preferDomain,
    filters,
    labels: [...labelsById.values()],
  });
  await showProposalWindow(proposalId);
}

/** From the context menu: the same choices as a suggestion, the label of the folder preselected. */
async function openFilterFormForMessage(message, email) {
  const [filters, labelsById, addresses] = await Promise.all([
    listFilters(email).catch(error => {
      if (error instanceof AuthError) return []; // the window will show the error
      throw error;
    }),
    listLabels(email),
    readMessageAddresses(message, email),
  ]);
  const { preferDomain = false } = await loadStore("settings", {});
  const folderLabel = labelsById.get(folderLabelId(message.folder, labelsById));
  const proposalId = crypto.randomUUID();
  proposals.clear();
  proposals.set(proposalId, {
    mode: "message",
    email,
    labelId: folderLabel?.type === "user" ? folderLabel.id : null,
    subject: message.subject,
    addresses,
    preferDomain,
    filters,
    labels: [...labelsById.values()],
  });
  await showProposalWindow(proposalId);
}

/** Creation (no filterId) or edition, from the filter list. */
async function openFilterForm(email, filterId) {
  const [filters, labelsById] = await Promise.all([listFilters(email), listLabels(email)]);
  const filter = filterId ? filters.find(entry => entry.id === filterId) : null;
  if (filterId && !filter) throw new Error(translate("errFilterGone"));
  const proposalId = crypto.randomUUID();
  proposals.clear();
  proposals.set(proposalId, {
    mode: filter ? "edit" : "new",
    email,
    filter,
    filters,
    labels: [...labelsById.values()],
  });
  await showProposalWindow(proposalId);
  return {};
}

async function showProposalWindow(proposalId) {
  const url = `/filter/filter.html?id=${proposalId}`;
  if (proposalWindowId != null) {
    try {
      const [tab] = await browser.tabs.query({ windowId: proposalWindowId });
      await browser.tabs.update(tab.id, { url });
      await browser.windows.update(proposalWindowId, { focused: true });
      return;
    } catch {
      proposalWindowId = null;
    }
  }
  const proposalWindow = await browser.windows.create({ type: "popup", url, width: 620, height: 780 });
  proposalWindowId = proposalWindow.id;
}

browser.windows.onRemoved.addListener(windowId => {
  if (windowId !== proposalWindowId) return;
  proposalWindowId = null;
  proposals.clear();
});

browser.messages.onMoved.addListener((originalMessages, movedMessages) => {
  proposeFilterAfterMove(originalMessages?.messages, movedMessages?.messages).catch(error => {
    if (!(error instanceof OfflineError)) console.warn("Gmail Labels: filter suggestion failed", error);
  });
});

function getProposal(proposalId) {
  const proposal = proposals.get(proposalId);
  if (!proposal) throw new Error(translate("errProposalExpired"));
  return proposal;
}

const inInbox = query => `in:inbox (${query})`;

/** Existing matching messages: in the whole mailbox and in the inbox. */
async function countMatchingMessages(proposalId, query) {
  const { email } = getProposal(proposalId);
  const [mailbox, inbox] = await Promise.all([
    searchMessages(email, query, MAX_COUNTED_MESSAGES),
    searchMessages(email, inInbox(query), MAX_COUNTED_MESSAGES),
  ]);
  return {
    mailboxCount: mailbox.ids.length,
    hasMoreInMailbox: mailbox.hasMore,
    inboxCount: inbox.ids.length,
    hasMoreInInbox: inbox.hasMore,
  };
}

/** Most recent matching messages, and the personal labels they already have. */
async function sampleMatchingMessages(proposalId, query) {
  const { email } = getProposal(proposalId);
  const { ids } = await searchMessages(email, query, SAMPLE_SIZE);
  const messages = [];
  for (let start = 0; start < ids.length; start += SAMPLE_REQUESTS_AT_ONCE) {
    messages.push(...await Promise.all(ids.slice(start, start + SAMPLE_REQUESTS_AT_ONCE)
      .map(id => getMessageSummary(email, id))));
  }
  const labelCounts = new Map();
  for (const labelId of messages.flatMap(message => userLabelIds({ addLabelIds: message.labelIds }))) {
    labelCounts.set(labelId, (labelCounts.get(labelId) ?? 0) + 1);
  }
  return {
    preview: messages.slice(0, PREVIEW_SIZE),
    sampleSize: messages.length,
    labelCounts: [...labelCounts].sort((first, second) => second[1] - first[1]),
  };
}

/** Number of messages this search has in common with each other filter. */
async function findOverlappingFilters(proposalId, query) {
  const { email, filters, filter: editedFilter } = getProposal(proposalId);
  const queue = filters.filter(filter => filter.id !== editedFilter?.id);
  const overlaps = [];
  const searchNextFilters = async () => {
    for (let filter = queue.shift(); filter; filter = queue.shift()) {
      try {
        const search = `(${query}) (${fullQuery(filter.criteria)})`;
        const { ids, hasMore } = await searchMessages(email, search, MAX_COUNTED_MESSAGES);
        if (ids.length) overlaps.push({ filterId: filter.id, count: ids.length, hasMore });
      } catch (error) {
        if (error instanceof AuthError || error instanceof OfflineError) throw error;
        console.warn("Gmail Labels: overlap search failed", error); // a search Gmail rejects
      }
    }
  };
  await Promise.all(Array.from({ length: OVERLAP_SEARCHES_AT_ONCE }, searchNextFilters));
  return { overlaps: overlaps.sort((first, second) => second.count - first.count) };
}

/** Gmail can't update a filter: the new one is created first, so nothing is lost on failure. */
async function replaceFilter(email, original, criteria, action) {
  const current = await getFilter(email, original.id).catch(error => {
    throw error.status === 404 ? new Error(translate("errFilterGone")) : error;
  });
  if (filterKey(current.criteria, current.action) !== filterKey(original.criteria, original.action)) {
    throw new Error(translate("errFilterChanged"));
  }
  if (filterKey(criteria, action) === filterKey(original.criteria, original.action)) return {};
  await createFilter(email, criteria, action);
  try {
    await deleteFilter(email, original.id);
  } catch (error) {
    if (error instanceof AuthError) throw error;
    return { warning: translate("filterOldKept", error.message) };
  }
  return {};
}

function notifyFiltersChanged(email) {
  menuFiltersCache.delete(email);
  browser.runtime.sendMessage({ command: "filtersChanged", email }).catch(() => {}); // no list open
}

/** existingMessages: "none" (future messages only), "inbox" or "all". */
async function applyToExistingMessages(email, query, action, existingMessages) {
  const addLabelIds = action.addLabelIds ?? [];
  const removeLabelIds = action.removeLabelIds ?? [];
  const hasLabelChange = addLabelIds.length || removeLabelIds.length;
  if (!hasLabelChange || (existingMessages !== "inbox" && existingMessages !== "all")) {
    return { appliedCount: 0, hasMore: false };
  }
  const search = existingMessages === "inbox" ? inInbox(query) : query;
  const { ids, hasMore } = await searchMessages(email, search, MAX_EXISTING_MESSAGES_UPDATED);
  await batchModifyLabels(email, ids, addLabelIds, removeLabelIds);
  messageCache.clear();
  return { appliedCount: ids.length, hasMore };
}

/** Creates a filter, or replaces the edited or extended one (targetFilterId). */
async function saveFilter(proposalId, { criteria, action, targetFilterId, applyQuery, existingMessages }) {
  const proposal = getProposal(proposalId);
  const target = proposal.filters.find(filter => filter.id === targetFilterId);
  let warning;
  if (target) ({ warning } = await replaceFilter(proposal.email, target, criteria, action));
  else await createFilter(proposal.email, criteria, action);
  notifyFiltersChanged(proposal.email);
  const applied = await applyToExistingMessages(proposal.email, applyQuery, action, existingMessages);
  proposals.delete(proposalId);
  return { ...applied, warning };
}

/** Deletes the filter open in the edition window. */
async function deleteEditedFilter(proposalId) {
  const proposal = getProposal(proposalId);
  if (proposal.mode !== "edit") throw new Error(translate("errFilterGone"));
  await deleteFilter(proposal.email, proposal.filter.id);
  notifyFiltersChanged(proposal.email);
  proposals.delete(proposalId);
  return {};
}

async function ignoreProposalFolder(proposalId) {
  const { ignoreKey } = getProposal(proposalId);
  const settings = await loadStore("settings", {});
  const ignoredFolders = [...new Set([...(settings.ignoredFolders ?? []), ignoreKey])];
  await browser.storage.local.set({ settings: { ...settings, ignoredFolders } });
  proposals.delete(proposalId);
}

/** Filters and labels of an account; offline, the last known ones. */
async function readFilterList(email) {
  try {
    const [filters, labelsById] = await Promise.all([listFilters(email), listLabels(email)]);
    await browser.storage.local.set({ [`filters:${email}`]: filters });
    return { filters, labels: [...labelsById.values()], stale: false };
  } catch (error) {
    const storedFilters = error instanceof OfflineError ? await loadStore(`filters:${email}`, null) : null;
    if (!storedFilters) throw error;
    const labelsById = await listLabels(email);
    return { filters: storedFilters, labels: [...labelsById.values()], stale: true };
  }
}

async function countFilterMessages(email, query) {
  const { ids, hasMore } = await searchMessages(email, query, MAX_COUNTED_MESSAGES);
  return { count: ids.length, hasMore };
}

async function openFilterList(email) {
  const url = `/filter-list/filter-list.html${email ? `?email=${encodeURIComponent(email)}` : ""}`;
  if (filterListTabId != null) {
    try {
      await browser.tabs.update(filterListTabId, { active: true, url });
      return;
    } catch {
      filterListTabId = null;
    }
  }
  filterListTabId = (await browser.tabs.create({ url })).id;
}

browser.tabs.onRemoved.addListener(tabId => {
  if (tabId === filterListTabId) filterListTabId = null;
});

// Context menu of a message, in the message list or the message itself
const MENU_CREATE = "filterCreate";
const MENU_EDIT = "filterEdit";
const MENU_LIST = "filterList";
const MENU_EDIT_PREFIX = "filterEdit:"; // + filter id
const MENU_CONTEXTS = ["message_list", "page"];
const MAX_MENU_FILTERS = 15;
const MAX_MENU_TITLE_LENGTH = 90;
const MENU_FILTERS_CACHE_DURATION = 2 * 60 * 1000;

browser.menus.create({ id: MENU_CREATE, title: translate("menuCreateFilter"), contexts: MENU_CONTEXTS, visible: false });
browser.menus.create({ id: MENU_EDIT, title: translate("menuEditFilter"), contexts: MENU_CONTEXTS, visible: false });
browser.menus.create({ id: MENU_LIST, title: translate("manageFilters"), contexts: MENU_CONTEXTS, visible: false });

const menuFiltersCache = new Map(); // email -> { filters, updatedAt }
let menuEditIds = [];
let menuInstance = 0;

/** Filters read at most once every two minutes, so the menu opens quickly. */
async function menuFilters(email) {
  const cached = menuFiltersCache.get(email);
  if (cached && Date.now() - cached.updatedAt < MENU_FILTERS_CACHE_DURATION) return cached.filters;
  const filters = await listFilters(email);
  menuFiltersCache.set(email, { filters, updatedAt: Date.now() });
  return filters;
}

function menuFilterTitle(filter, labelsById) {
  const labelNames = userLabelIds(filter.action).map(id => labelsById.get(id)?.name ?? translate("labelDeleted"));
  const title = `${labelNames.join(", ") || translate("filterNoLabel")} : ${fullQuery(filter.criteria)}`;
  const shortTitle = title.length > MAX_MENU_TITLE_LENGTH ? `${title.slice(0, MAX_MENU_TITLE_LENGTH - 1)}…` : title;
  return shortTitle.replace(/&/g, "&&"); // "&" marks an access key
}

/** Replaces the entries of the "Edit" submenu with the filters matching the message. */
async function fillEditMenu({ message, email }, instance) {
  const [filters, labelsById, addresses] = await Promise.all([
    menuFilters(email),
    listLabels(email),
    readMessageAddresses(message, ""),
  ]);
  if (instance !== menuInstance) return false; // the menu was closed meanwhile
  const matching = filters.filter(filter => filterMatchesMessage(filter, { ...addresses, subject: message.subject }));
  await Promise.all(menuEditIds.map(id => browser.menus.remove(id).catch(() => {})));
  menuEditIds = matching.slice(0, MAX_MENU_FILTERS).map(filter => browser.menus.create({
    id: `${MENU_EDIT_PREFIX}${filter.id}`,
    parentId: MENU_EDIT,
    title: menuFilterTitle(filter, labelsById),
    contexts: MENU_CONTEXTS,
  }));
  return matching.length > 0;
}

/** The right-clicked message with its account address, or null if the account is not authorized. */
async function menuMessage(info, tab) {
  const message = info.selectedMessages?.messages?.[0] ??
    (tab ? await getDisplayedMessage(tab.id).catch(() => null) : null);
  if (!message?.folder) return null;
  const account = await browser.accounts.get(message.folder.accountId);
  const email = account?.type === "imap" && account.identities?.[0]?.email?.toLowerCase();
  if (!email || !(await loadStore("tokens", {}))[email]) return null;
  return { message, email };
}

browser.menus.onShown.addListener(async (info, tab) => {
  // menuIds only lists visible entries: test the context, the entries start hidden
  if (!info.contexts.some(context => MENU_CONTEXTS.includes(context))) return;
  const instance = ++menuInstance;
  const target = await menuMessage(info, tab).catch(() => null);
  if (instance !== menuInstance) return;
  await Promise.all([MENU_CREATE, MENU_LIST].map(id => browser.menus.update(id, { visible: Boolean(target) })));
  await browser.menus.update(MENU_EDIT, { visible: false });
  browser.menus.refresh();
  if (!target) return;
  // The filters can take a moment to read: the submenu appears once they are known
  const hasFilters = await fillEditMenu(target, instance).catch(error => {
    console.warn("Gmail Labels: filters of the message unreadable", error);
    return false;
  });
  if (instance !== menuInstance || !hasFilters) return;
  await browser.menus.update(MENU_EDIT, { visible: true });
  browser.menus.refresh();
});

browser.menus.onHidden.addListener(() => menuInstance++);

browser.menus.onClicked.addListener(async (info, tab) => {
  const menuId = String(info.menuItemId);
  if (menuId !== MENU_CREATE && menuId !== MENU_LIST && !menuId.startsWith(MENU_EDIT_PREFIX)) return;
  try {
    const target = await menuMessage(info, tab);
    if (!target) return;
    if (menuId === MENU_LIST) await openFilterList(target.email);
    else if (menuId === MENU_CREATE) await openFilterFormForMessage(target.message, target.email);
    else await openFilterForm(target.email, menuId.slice(MENU_EDIT_PREFIX.length));
  } catch (error) {
    console.warn("Gmail Labels: context menu failed", error);
  }
});

const toErrorResult = error => ({ error: error.message });

browser.runtime.onMessage.addListener(request => {
  switch (request?.command) {
    case "proposal":
      return Promise.resolve().then(() => getProposal(request.proposalId)).catch(toErrorResult);
    case "filterCount":
      return countMatchingMessages(request.proposalId, request.query).catch(toErrorResult);
    case "filterSample":
      return sampleMatchingMessages(request.proposalId, request.query).catch(toErrorResult);
    case "filterOverlaps":
      return findOverlappingFilters(request.proposalId, request.query).catch(toErrorResult);
    case "filterSave":
      return saveFilter(request.proposalId, request).catch(toErrorResult);
    case "filterDismiss":
      dismissedProposals.add(proposals.get(request.proposalId)?.dismissalKey);
      proposals.delete(request.proposalId);
      return Promise.resolve({});
    case "filterIgnoreFolder":
      return ignoreProposalFolder(request.proposalId).then(() => ({}), toErrorResult);
    case "filterListOpen":
      return openFilterList(request.email).then(() => ({}), toErrorResult);
    case "filterListRead":
      return readFilterList(request.email).catch(toErrorResult);
    case "filterListCount":
      return countFilterMessages(request.email, request.query).catch(toErrorResult);
    case "filterFormOpen":
      return openFilterForm(request.email, request.filterId).catch(toErrorResult);
    case "filterDelete":
      menuFiltersCache.delete(request.email);
      return deleteFilter(request.email, request.filterId).then(() => ({}), toErrorResult);
    case "filterRestore":
      menuFiltersCache.delete(request.email);
      return createFilter(request.email, request.filter.criteria, request.filter.action)
        .then(() => ({}), toErrorResult);
    case "filterDeleteEdited":
      return deleteEditedFilter(request.proposalId).catch(toErrorResult);
  }
  return undefined;
});
