/**
 * Filter optimizer: measures the longest search Gmail accepts in a filter, and
 * replaces the filters doing the same thing by merged ones (see optimizationGroups).
 */
const DELETES_AT_ONCE = 5;

// Measure of the longest search Gmail accepts in a filter
const PROBE_MIN_LENGTH = 200;
const PROBE_MAX_LENGTH = 20000;
const PROBE_PRECISION = 50;
const PROBE_ACTION = { addLabelIds: ["STARRED"] }; // never applied: no message matches

/** Search of about this length, made of addresses of a domain reserved for examples. */
function probeQuery(length) {
  const items = [];
  for (let index = 0; `{${items.join(" ")}}`.length < length; index++) {
    items.push(`from:probe${String(index).padStart(4, "0")}@example.com`);
  }
  return `{${items.join(" ")}}`;
}

/** Null if Gmail accepts a filter with this search (deleted at once), else its refusal. */
async function probeRefusal(email, query) {
  let created;
  try {
    created = await createFilter(email, { query }, PROBE_ACTION);
  } catch (error) {
    if (error.status === 400) return error.message;
    throw error;
  }
  try {
    await deleteFilter(email, created.id);
  } catch (error) {
    // Harmless (it matches no message), but the user must know where it comes from
    throw new Error(translate("errProbeLeft", error.message));
  }
  return null;
}

/** Dichotomy between an accepted and a refused length; the result is kept for all accounts. */
async function measureQueryLimit(email) {
  let accepted = 0;
  let refused = PROBE_MAX_LENGTH + 1;
  let refusal = null;
  let length = PROBE_MIN_LENGTH;
  while (refused - accepted > PROBE_PRECISION) {
    const query = probeQuery(length);
    if (query.length >= refused) break;
    const message = await probeRefusal(email, query);
    if (message === null) accepted = query.length;
    else [refused, refusal] = [query.length, message];
    // A short search refused: not a matter of length, Gmail's reason is shown
    if (!accepted) throw new Error(translate("errProbeFailed", refusal));
    length = refused > PROBE_MAX_LENGTH ? Math.min(accepted * 2, PROBE_MAX_LENGTH) : Math.floor((accepted + refused) / 2);
    if (length <= accepted) break;
  }
  const limit = { length: accepted, refused: refused > PROBE_MAX_LENGTH ? null : refused, refusal, measuredAt: Date.now() };
  await browser.storage.local.set({ filterQueryLimit: limit });
  return limit;
}

/**
 * Replaces filters doing the same thing by the merged ones. Checks first that they did
 * not change elsewhere; if a creation fails, the filters already created are deleted.
 */
async function applyOptimizationGroup(email, { filterIds, queries }) {
  const current = await listFilters(email);
  const group = filterIds.map(id => current.find(filter => filter.id === id));
  if (group.some(filter => !filter)) throw new Error(translate("errFilterChanged"));
  const action = group[0].action;
  if (group.some(filter => actionKey(filter.action) !== actionKey(action))) throw new Error(translate("errFilterChanged"));
  // A merged search equal to one of the group is kept: Gmail refuses an identical filter
  const reused = new Set();
  const created = [];
  try {
    for (const query of queries) {
      const same = group.find(filter => !reused.has(filter.id) && searchKey(filter.criteria.query) === searchKey(query));
      if (same) reused.add(same.id);
      else created.push(await createFilter(email, { query }, action));
    }
  } catch (error) {
    await Promise.all(created.map(filter => deleteFilter(email, filter.id).catch(() => {})));
    throw error;
  }
  const kept = [];
  await inParallel(group.filter(entry => !reused.has(entry.id)), DELETES_AT_ONCE, async filter => {
    try {
      await deleteFilter(email, filter.id);
    } catch (error) {
      if (error instanceof AuthError) throw error;
      kept.push(filter.id);
    }
  });
  notifyFiltersChanged(email);
  return { created: created.length, deleted: group.length - reused.size - kept.length, kept };
}
