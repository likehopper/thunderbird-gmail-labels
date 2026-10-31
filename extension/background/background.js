/**
 * Links the message displayed in Thunderbird to its Gmail labels.
 * Offline: last known state (stored on disk), and changes are queued then replayed
 * when the network is back. With no known state, falls back on the IMAP folders
 * synced locally.
 */
const SYSTEM_LABEL_NAMES = Object.fromEntries([
  "INBOX", "STARRED", "SENT", "DRAFT", "SPAM", "TRASH",
  "CATEGORY_PERSONAL", "CATEGORY_SOCIAL", "CATEGORY_PROMOTIONS", "CATEGORY_UPDATES", "CATEGORY_FORUMS",
].map(id => [id, translate(`sys${id}`)]));
const HIDDEN_LABEL_IDS = new Set(["UNREAD", "IMPORTANT", "CHAT"]);
const REMOVABLE_SYSTEM_LABEL_IDS = ["INBOX", "STARRED"];
const MESSAGE_CACHE_DURATION = 10 * 60 * 1000;
const MAX_RECENT_LABELS = 10;
const REPLAY_INTERVAL = 60 * 1000;

// All three maps are keyed by messageKey(email, headerMessageId)
const messageCache = new Map(); // -> { gmailId, labelIds, updatedAt }
const gmailMessageIds = new Map(); // -> Gmail id (immutable, kept for the whole session)
const pendingLookups = new Map(); // -> lookup in progress (avoids duplicate requests)

browser.messageDisplayScripts.register({
  js: [{ file: "/common/i18n.js" }, { file: "/display/bar.js" }],
  css: [{ file: "/display/bar.css" }],
});

browser.storage.onChanged.addListener(changes => {
  if (changes.settings || changes.tokens) clearAuthCache();
});

const compareByName = (first, second) =>
  first.name.localeCompare(second.name, browser.i18n.getUILanguage(), { sensitivity: "base" });

function describeLabel(id, labelsById, settings) {
  if (HIDDEN_LABEL_IDS.has(id)) return null;
  if (id.startsWith("CATEGORY_") && settings.hideCategories !== false) return null;
  const label = labelsById.get(id);
  return {
    id,
    name: SYSTEM_LABEL_NAMES[id] ?? label?.name ?? id,
    color: label?.color ?? null,
    system: label?.type !== "user",
    removable: label?.type === "user" || REMOVABLE_SYSTEM_LABEL_IDS.includes(id),
  };
}

function describeLabels(labelIds, labelsById, settings) {
  return sortLabels(labelIds.map(id => describeLabel(id, labelsById, settings)).filter(Boolean));
}

/** Inbox first, then the other system labels, then the user's labels. */
function sortLabels(labels) {
  const inbox = labels.filter(label => label.id === "INBOX");
  const system = labels.filter(label => label.system && label.id !== "INBOX").sort(compareByName);
  const user = labels.filter(label => !label.system).sort(compareByName);
  return [...inbox, ...system, ...user];
}

async function getDisplayedMessage(tabId) {
  const displayed = await browser.messageDisplay.getDisplayedMessages(tabId);
  const messages = Array.isArray(displayed) ? displayed : displayed?.messages ?? [];
  return messages.length === 1 ? messages[0] : null;
}

/** The displayed message with its account address, or null if it is not in an IMAP account. */
async function resolveDisplayedMessage(tabId) {
  const message = await getDisplayedMessage(tabId);
  if (!message?.folder) return null;
  const account = await browser.accounts.get(message.folder.accountId);
  if (account?.type !== "imap") return null;
  const email = account.identities?.[0]?.email?.toLowerCase();
  if (!email) return null;
  const tokens = await loadStore("tokens", {});
  return { message, email, authorized: Boolean(tokens[email]) };
}

async function findMessage(email, headerMessageId, bypassCache = false) {
  const key = messageKey(email, headerMessageId);
  const cachedEntry = messageCache.get(key);
  if (!bypassCache && cachedEntry && Date.now() - cachedEntry.updatedAt < MESSAGE_CACHE_DURATION) {
    return cachedEntry;
  }
  if (!pendingLookups.has(key)) {
    const lookup = fetchMessage(email, headerMessageId, key).finally(() => pendingLookups.delete(key));
    pendingLookups.set(key, lookup);
  }
  return pendingLookups.get(key);
}

async function fetchMessage(email, headerMessageId, key) {
  let gmailId = gmailMessageIds.get(key) ?? (await loadMessageState(key))?.gmailId;
  let labelIds = null;
  if (gmailId) {
    try {
      labelIds = await getMessageLabels(email, gmailId);
    } catch (error) {
      // Permanently deleted on the Gmail side: search for it again
      if (error.status !== 404) throw error;
      gmailMessageIds.delete(key);
      gmailId = null;
    }
  }
  if (!gmailId) {
    gmailId = await searchMessageId(email, headerMessageId);
    if (!gmailId) return null;
    labelIds = await getMessageLabels(email, gmailId);
  }
  gmailMessageIds.set(key, gmailId);
  const entry = { gmailId, labelIds, updatedAt: Date.now() };
  messageCache.set(key, entry);
  await saveMessageState(key, entry);
  return entry;
}

/** Labels deduced from the IMAP folders holding a copy of the message. */
async function labelsFromLocalFolders(message) {
  const results = await browser.messages.query({
    accountId: message.folder.accountId,
    headerMessageId: message.headerMessageId,
  });
  const names = new Set();
  for (const copy of results.messages ?? results) {
    const folder = copy.folder;
    const specialUse = folder.specialUse ?? [];
    // "All Mail" and "Important" carry no information
    if (specialUse.includes("archives") || /\/Important$/.test(folder.path)) continue;
    names.add(specialUse.includes("inbox")
      ? SYSTEM_LABEL_NAMES.INBOX
      : folder.path.replace(/^\//, "").replace(/^\[Gmail\]\//, ""));
  }
  return [...names].map(name => ({ id: name, name, removable: false }));
}

/** Gmail label matching the IMAP folder that holds the displayed message. */
function folderLabelId(folder, labelsById) {
  if (folder.specialUse?.includes("inbox")) return "INBOX";
  const path = folder.path.replace(/^\//, "");
  for (const label of labelsById.values()) {
    if (label.type === "user" && label.name === path) return label.id;
  }
  return null;
}

async function findAllMailFolder(accountId) {
  const folders = await browser.folders.query({ accountId, specialUse: ["archives"] });
  return folders.find(folder => /^\/\[(Gmail|Google Mail)\]\//.test(folder.path)) ?? null;
}

/** Labels offered for adding: all of them, plus the ids of the most recently used. */
async function labelChoices(email, labelsById, settings) {
  const userLabelIds = [...labelsById.values()].filter(label => label.type === "user").map(label => label.id);
  const allLabels = sortLabels([...REMOVABLE_SYSTEM_LABEL_IDS, ...userLabelIds]
    .map(id => describeLabel(id, labelsById, settings)));
  const recentLabelIds = (await loadStore(`recent:${email}`, [])).filter(id => labelsById.has(id));
  return { allLabels, recentLabelIds };
}

async function getOfflineState({ message, email }, settings, includeChoices) {
  const key = messageKey(email, message.headerMessageId);
  const [storedMessage, labelsById, queue] = await Promise.all([
    loadMessageState(key),
    listLabels(email).catch(() => null),
    loadPendingChanges(),
  ]);
  if (!storedMessage || !labelsById) {
    return { mode: "local", email, labels: await labelsFromLocalFolders(message) };
  }

  const changes = queue.filter(change => change.messageKey === key);
  const addedLabelIds = new Set(changes.flatMap(change => change.addLabelIds));
  const labels = describeLabels(applyPendingChanges(storedMessage.labelIds, changes), labelsById, settings)
    .map(label => ({ ...label, pending: addedLabelIds.has(label.id) }));
  for (const name of changes.flatMap(change => change.addLabelNames ?? [])) {
    labels.push({ id: `name:${name}`, name, pending: true, removable: false });
  }
  const state = { mode: "offline", email, labels, since: storedMessage.updatedAt, pendingChangeCount: queue.length };
  if (includeChoices) Object.assign(state, await labelChoices(email, labelsById, settings));
  return state;
}

async function getLabelState(tabId, { includeChoices = false, bypassCache = false } = {}) {
  const displayed = await resolveDisplayedMessage(tabId);
  if (!displayed) return { mode: "none" };
  const { message, email } = displayed;
  if (!displayed.authorized) return { mode: "unauthorized", email };
  const settings = await loadStore("settings", {});
  try {
    await replayPendingChanges();
    const [labelsById, found] = await Promise.all([
      listLabels(email, bypassCache),
      findMessage(email, message.headerMessageId, bypassCache),
    ]);
    if (!found) return { mode: "notfound", email };
    const state = { mode: "gmail", email, labels: describeLabels(found.labelIds, labelsById, settings) };
    if (includeChoices) Object.assign(state, await labelChoices(email, labelsById, settings));
    return state;
  } catch (error) {
    if (error instanceof OfflineError) return getOfflineState(displayed, settings, includeChoices);
    if (error instanceof AuthError) return { mode: "auth", email, error: error.message };
    return { mode: "error", email, error: error.message };
  }
}

async function getDisplayState(tabId, options) {
  const settings = await loadStore("settings", {});
  const state = await getLabelState(tabId, options);
  return { ...state, showBar: settings.showBar !== false };
}

const findLabelByName = (labelsById, name) =>
  [...labelsById.values()].find(label => label.name.toLowerCase() === name.toLowerCase());

async function labelIdForName(email, name) {
  const existingLabel = findLabelByName(await listLabels(email, true), name);
  const id = existingLabel ? existingLabel.id : (await createLabel(email, name)).id;
  await rememberRecentLabels(email, [id]);
  return id;
}

/** Applies a change through the Gmail API and updates the memory and disk caches. */
async function applyChangeOnline({ email, headerMessageId, addLabelIds, removeLabelIds, addLabelNames = [] }) {
  const found = await findMessage(email, headerMessageId);
  if (!found) return null;
  const labelIdsToAdd = [...addLabelIds];
  for (const name of addLabelNames) labelIdsToAdd.push(await labelIdForName(email, name));
  const labelIds = labelIdsToAdd.length || removeLabelIds.length
    ? await modifyLabels(email, found.gmailId, labelIdsToAdd, removeLabelIds)
    : found.labelIds;
  const key = messageKey(email, headerMessageId);
  const entry = { gmailId: found.gmailId, labelIds, updatedAt: Date.now() };
  messageCache.set(key, entry);
  await saveMessageState(key, entry);
  return entry;
}

let replayInProgress = null;

/** Replays, in order, the changes made offline. */
function replayPendingChanges() {
  replayInProgress ??= (async () => {
    let replayedCount = 0;
    for (let queue = await loadPendingChanges(); queue.length; queue = await loadPendingChanges()) {
      const oldestChange = queue[0];
      try {
        await applyChangeOnline(oldestChange);
      } catch (error) {
        if (error instanceof OfflineError || error instanceof AuthError) break; // retried later
        console.warn("Gmail Labels: change dropped", oldestChange, error);
      }
      await removeOldestChange();
      replayedCount++;
    }
    if (replayedCount) {
      for (const tab of await browser.tabs.query({})) {
        browser.tabs.sendMessage(tab.id, { command: "refresh" }).catch(() => {});
      }
    }
  })().finally(() => (replayInProgress = null));
  return replayInProgress;
}

async function changeLabels(tabId, { addLabelIds = [], removeLabelIds = [], addLabelNames = [] }, notifyTab) {
  const displayed = await resolveDisplayedMessage(tabId);
  if (!displayed?.authorized) throw new Error(translate("errAccountNotAuthorized"));
  const { message, email } = displayed;
  const { headerMessageId } = message;
  await rememberRecentLabels(email, addLabelIds);

  let messageMoved = false;
  try {
    // Pending changes go first, to keep them in order
    await replayPendingChanges();
    if ((await loadPendingChanges()).length) throw new OfflineError("queue not empty");

    // Removing the label of the displayed folder goes through a Thunderbird move to
    // "All Mail" (which only removes that label on the Gmail side): the folder list
    // updates at once, without waiting for the next IMAP sync.
    const labelsById = await listLabels(email);
    const displayedFolderLabelId = folderLabelId(message.folder, labelsById);
    const allMailFolder = displayedFolderLabelId && removeLabelIds.includes(displayedFolderLabelId)
      ? await findAllMailFolder(message.folder.accountId)
      : null;
    const removeThroughApi = allMailFolder
      ? removeLabelIds.filter(id => id !== displayedFolderLabelId)
      : removeLabelIds;

    const entry = await applyChangeOnline({
      email, headerMessageId, addLabelIds, removeLabelIds: removeThroughApi, addLabelNames,
    });
    if (!entry) throw new Error(translate("errNotFound"));
    if (allMailFolder) {
      await browser.messages.move([message.id], allMailFolder);
      entry.labelIds = entry.labelIds.filter(id => id !== displayedFolderLabelId);
      await saveMessageState(messageKey(email, headerMessageId), entry);
      messageMoved = true;
    }

    // A single label added (picked or created): suggest the matching Gmail filter
    if (addLabelIds.length + addLabelNames.length === 1) {
      const addedLabelId = addLabelIds[0] ?? findLabelByName(await listLabels(email), addLabelNames[0])?.id;
      if (addedLabelId) {
        proposeFilterForLabel(message, email, addedLabelId, entry.labelIds.includes("INBOX"))
          .catch(error => console.warn("Gmail Labels: filter suggestion failed", error));
      }
    }
  } catch (error) {
    if (!(error instanceof OfflineError)) throw error;
    await enqueueChange({
      messageKey: messageKey(email, headerMessageId),
      email, headerMessageId, addLabelIds, removeLabelIds, addLabelNames,
    });
  }
  if (notifyTab && !messageMoved) browser.tabs.sendMessage(tabId, { command: "refresh" }).catch(() => {});
  return getDisplayState(tabId, { includeChoices: true });
}

/** Keeps the most recently added labels for each account; they are offered first. */
async function rememberRecentLabels(email, labelIds) {
  if (!labelIds.length) return;
  const storageKey = `recent:${email}`;
  const recentLabelIds = await loadStore(storageKey, []);
  const updatedLabelIds = [...labelIds, ...recentLabelIds.filter(id => !labelIds.includes(id))];
  await browser.storage.local.set({ [storageKey]: updatedLabelIds.slice(0, MAX_RECENT_LABELS) });
}

window.addEventListener("online", () => replayPendingChanges());
setInterval(() => replayPendingChanges(), REPLAY_INTERVAL);
replayPendingChanges();
pruneStoredMessages();

async function listAccountStatuses() {
  const accounts = await browser.accounts.list(false);
  const tokens = await loadStore("tokens", {});
  return accounts
    .filter(account => account.type === "imap")
    .map(account => {
      const email = account.identities?.[0]?.email?.toLowerCase() ?? null;
      return { id: account.id, name: account.name, email, authorized: Boolean(email && tokens[email]) };
    });
}

const toErrorState = error => ({ mode: "error", error: error.message });

browser.runtime.onMessage.addListener((request, sender) => {
  if (!request?.command) return undefined;
  // The popup passes tabId; the display script runs inside the tab itself
  const fromPopup = request.tabId != null;
  const tabId = request.tabId ?? sender.tab?.id;
  switch (request.command) {
    case "state":
      return getDisplayState(tabId, request).catch(toErrorState);
    case "modify":
      return changeLabels(tabId, request, fromPopup).catch(toErrorState);
    case "create":
      return changeLabels(tabId, { addLabelNames: [request.labelName] }, fromPopup).catch(toErrorState);
    case "accounts":
      return listAccountStatuses();
    case "authorize":
      return authorize(request.email).then(
        () => ({ ok: true }),
        error => ({ ok: false, error: error.message }));
    case "revoke":
      return revoke(request.email).then(() => ({ ok: true }));
    case "openOptions":
      return browser.runtime.openOptionsPage();
  }
  return undefined;
});
