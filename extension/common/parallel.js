/** Shared by the background script and the pages. */
/** Runs worker on each item, at most limit at once. */
async function inParallel(items, limit, worker) {
  const queue = [...items];
  const runNext = async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await worker(item);
  };
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, runNext));
}
