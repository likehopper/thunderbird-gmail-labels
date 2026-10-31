/**
 * When a message is moved to a folder matching a Gmail label, or a label is added,
 * suggests (filter/filter.html window) creating the equivalent Gmail filter: an
 * address, a domain or a keyword, searched in From, To/Cc, Reply-to and/or Subject.
 * Suggests nothing if an existing filter already adds this label for this sender.
 */
const MAX_COUNTED_MESSAGES = 500;
const MAX_EXISTING_MESSAGES_UPDATED = 5000;

const proposals = new Map(); // proposal id -> proposal (only one at a time)
const dismissedProposals = new Set(); // "Not now" keys, for the session
let proposalWindowId = null;

const folderKey = folder => `${folder.accountId}|${folder.path}`;
const domainOf = address => address.slice(address.indexOf("@") + 1);

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
    fromInbox: sourceFolder.specialUse?.includes("inbox") ?? false,
    messageCount: messagesAfter.length,
  });
}

/** Label added from the bar or the button: same suggestion as for a move. */
async function proposeFilterForLabel(message, email, labelId, fromInbox) {
  const settings = await loadStore("settings", {});
  if (settings.proposeFilters === false) return;
  const labelsById = await listLabels(email);
  const label = labelsById.get(labelId);
  if (label?.type !== "user") return;
  // Same key as the label's folder, so "don't suggest again" applies to both cases
  const ignoreKey = `${message.folder.accountId}|/${label.name}`;
  if ((settings.ignoredFolders ?? []).includes(ignoreKey)) return;
  await proposeFilter({ message, email, labelsById, labelId, ignoreKey, fromInbox, messageCount: 1 });
}

async function proposeFilter({ message, email, labelsById, labelId, ignoreKey, fromInbox, messageCount }) {
  const addresses = await readMessageAddresses(message, email);
  const sender = addresses.from[0] ?? "";
  const dismissalKey = `${ignoreKey}|${sender}`;
  if (dismissedProposals.has(dismissalKey)) return;

  const filters = await listFilters(email).catch(error => {
    if (error instanceof AuthError) return []; // the window will show the error
    throw error;
  });
  const alreadyCovered = sender && filters.some(filter =>
    filter.action?.addLabelIds?.includes(labelId) &&
    [sender, domainOf(sender)].some(value =>
      JSON.stringify(filter.criteria ?? {}).toLowerCase().includes(value)));
  if (alreadyCovered) return;

  const proposalId = crypto.randomUUID();
  proposals.clear();
  proposals.set(proposalId, {
    dismissalKey,
    ignoreKey,
    email,
    labelId,
    labelName: labelsById.get(labelId).name,
    fromInbox,
    subject: message.subject,
    messageCount,
    addresses,
  });
  await showProposalWindow(proposalId);
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
  const proposalWindow = await browser.windows.create({ type: "popup", url, width: 560, height: 640 });
  proposalWindowId = proposalWindow.id;
}

browser.windows.onRemoved.addListener(windowId => {
  if (windowId === proposalWindowId) proposalWindowId = null;
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

/** existingMessages: "none" (future messages only), "inbox" or "all". */
async function createProposedFilter(proposalId, query, archive, existingMessages) {
  const proposal = getProposal(proposalId);
  const addLabelIds = [proposal.labelId];
  const removeLabelIds = archive ? ["INBOX"] : [];
  await createFilter(proposal.email, { query }, { addLabelIds, ...(archive ? { removeLabelIds } : {}) });
  let appliedCount = 0;
  if (existingMessages === "inbox" || existingMessages === "all") {
    const search = existingMessages === "inbox" ? inInbox(query) : query;
    const { ids } = await searchMessages(proposal.email, search, MAX_EXISTING_MESSAGES_UPDATED);
    await batchModifyLabels(proposal.email, ids, addLabelIds, removeLabelIds);
    appliedCount = ids.length;
    messageCache.clear();
  }
  proposals.delete(proposalId);
  return { appliedCount };
}

async function ignoreProposalFolder(proposalId) {
  const { ignoreKey } = getProposal(proposalId);
  const settings = await loadStore("settings", {});
  const ignoredFolders = [...new Set([...(settings.ignoredFolders ?? []), ignoreKey])];
  await browser.storage.local.set({ settings: { ...settings, ignoredFolders } });
  proposals.delete(proposalId);
}

const toErrorResult = error => ({ error: error.message });

browser.runtime.onMessage.addListener(request => {
  switch (request?.command) {
    case "proposal":
      return Promise.resolve().then(() => getProposal(request.proposalId)).catch(toErrorResult);
    case "filterCount":
      return countMatchingMessages(request.proposalId, request.query).catch(toErrorResult);
    case "filterCreate":
      return createProposedFilter(request.proposalId, request.query, request.archive, request.existingMessages)
        .catch(toErrorResult);
    case "filterDismiss":
      dismissedProposals.add(proposals.get(request.proposalId)?.dismissalKey);
      proposals.delete(request.proposalId);
      return Promise.resolve({});
    case "filterIgnoreFolder":
      return ignoreProposalFolder(request.proposalId).then(() => ({}), toErrorResult);
  }
  return undefined;
});
