/**
 * On-disk persistence (storage.local) for offline use:
 * - "msg:<email>|<Message-ID>" -> { gmailId, labelIds, updatedAt }: last known message state;
 * - "labels:<email>"           -> the account's label list (see listLabels);
 * - "queue"                    -> changes made offline, replayed in order.
 */
const MAX_STORED_MESSAGES = 10000;
const MAX_STORED_MESSAGE_AGE = 180 * 24 * 3600 * 1000;
const MESSAGE_STORAGE_PREFIX = "msg:";
const ACCOUNT_STORAGE_PREFIXES = ["labels", "filters", "recent", "changeFailure"];

const messageKey = (email, headerMessageId) => `${email}|${headerMessageId}`;
const accountStorageKey = (prefix, email) => `${prefix}:${email}`;

async function loadMessageState(key) {
  return loadStore(MESSAGE_STORAGE_PREFIX + key, null);
}

async function saveMessageState(key, { gmailId, labelIds, updatedAt }) {
  await browser.storage.local.set({ [MESSAGE_STORAGE_PREFIX + key]: { gmailId, labelIds, updatedAt } });
}

async function loadPendingChanges() {
  return loadStore("queue", []);
}

let queueWrite = Promise.resolve();

/** One queue update at a time: two concurrent read-change-write would lose one of them. */
function updatePendingChanges(change) {
  queueWrite = queueWrite.catch(() => {}).then(async () => {
    const queue = await loadPendingChanges();
    change(queue);
    await browser.storage.local.set({ queue });
  });
  return queueWrite;
}

const enqueueChange = change => updatePendingChanges(queue => queue.push({ ...change, queuedAt: Date.now() }));
const removeOldestChange = () => updatePendingChanges(queue => queue.shift());

const sanitizedChangeError = error => ({
  failedAt: Date.now(),
  status: Number.isInteger(error?.status) ? error.status : null,
});

const isRetryableChangeError = error =>
  error instanceof OfflineError || error instanceof AuthError || error?.status === 429 || error?.status >= 500;

const loadChangeFailure = email => loadStore(accountStorageKey("changeFailure", email), null);
const clearChangeFailure = email => browser.storage.local.remove(accountStorageKey("changeFailure", email));
const recordChangeFailure = (email, error) => browser.storage.local.set({
  [accountStorageKey("changeFailure", email)]: sanitizedChangeError(error),
});

/** Removes all account-specific caches, queued changes and failure details. */
async function purgeAccountData(email, accountIds = []) {
  const stored = await browser.storage.local.get(null);
  const exactKeys = new Set(ACCOUNT_STORAGE_PREFIXES.map(prefix => accountStorageKey(prefix, email)));
  const messagePrefix = MESSAGE_STORAGE_PREFIX + `${email}|`;
  const keys = Object.keys(stored).filter(key => exactKeys.has(key) || key.startsWith(messagePrefix));
  if (keys.length) await browser.storage.local.remove(keys);
  await updatePendingChanges(queue => {
    for (let index = queue.length - 1; index >= 0; index--) {
      if (queue[index].email === email) queue.splice(index, 1);
    }
  });
  await updateSettings(settings => ({
    ...settings,
    ignoredFolders: (settings.ignoredFolders ?? [])
      .filter(key => !accountIds.some(accountId => key.startsWith(`${accountId}|`))),
  }));
}

/** The OAuth client is shared: remove it only after the last authorization is gone. */
async function purgeUnusedOAuthClient() {
  if (Object.keys(await loadStore("tokens", {})).length) return false;
  let purged = false;
  await updateSettings(current => {
    const { clientId: _clientId, clientSecret: _clientSecret, ...preferences } = current;
    purged = Boolean(_clientId || _clientSecret);
    return preferences;
  });
  return purged;
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
