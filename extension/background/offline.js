/**
 * On-disk persistence (storage.local) for offline use:
 * - "msg:<email>|<Message-ID>" -> { gmailId, labelIds, updatedAt }: last known message state;
 * - "labels:<email>"           -> the account's label list (see listLabels);
 * - "queue"                    -> changes made offline, replayed in order.
 */
const MAX_STORED_MESSAGES = 10000;
const MAX_STORED_MESSAGE_AGE = 180 * 24 * 3600 * 1000;
const MESSAGE_STORAGE_PREFIX = "msg:";

const messageKey = (email, headerMessageId) => `${email}|${headerMessageId}`;

async function loadMessageState(key) {
  return loadStore(MESSAGE_STORAGE_PREFIX + key, null);
}

async function saveMessageState(key, { gmailId, labelIds, updatedAt }) {
  await browser.storage.local.set({ [MESSAGE_STORAGE_PREFIX + key]: { gmailId, labelIds, updatedAt } });
}

async function loadPendingChanges() {
  return loadStore("queue", []);
}

async function enqueueChange(change) {
  const queue = await loadPendingChanges();
  queue.push({ ...change, queuedAt: Date.now() });
  await browser.storage.local.set({ queue });
}

async function removeOldestChange() {
  const queue = await loadPendingChanges();
  queue.shift();
  await browser.storage.local.set({ queue });
}

/** Applies the changes still pending to a known label list. */
function applyPendingChanges(labelIds, changes) {
  const updatedLabelIds = new Set(labelIds);
  for (const change of changes) {
    change.addLabelIds.forEach(id => updatedLabelIds.add(id));
    change.removeLabelIds.forEach(id => updatedLabelIds.delete(id));
  }
  return [...updatedLabelIds];
}

async function pruneStoredMessages() {
  const stored = await browser.storage.local.get(null);
  const entriesNewestFirst = Object.entries(stored)
    .filter(([key]) => key.startsWith(MESSAGE_STORAGE_PREFIX))
    .sort(([, first], [, second]) => second.updatedAt - first.updatedAt);
  const staleKeys = entriesNewestFirst
    .filter(([, entry], index) =>
      index >= MAX_STORED_MESSAGES || Date.now() - entry.updatedAt > MAX_STORED_MESSAGE_AGE)
    .map(([key]) => key);
  if (staleKeys.length) await browser.storage.local.remove(staleKeys);
}
